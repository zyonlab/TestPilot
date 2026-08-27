import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The review queue's contract: nothing reaches the board without a decision, an approval
 * carries the provenance with it, and a rejection is remembered.
 *
 * The workflow outputs and the database are both stubbed here — what is under test is the
 * queue's own logic, not SQLite.
 */

const outputs: Record<string, unknown> = {};
const runs: Record<string, unknown> = {};
const created: Array<Record<string, unknown>> = [];
const decisions: Array<Record<string, unknown>> = [];
const edits: Record<string, Record<string, unknown>> = {};
const replies: string[] = [];

vi.mock("../src/graphs.js", () => ({
  nodeOutput: async (wfRunId: string, nodeId: string) => outputs[`${wfRunId}:${nodeId}`],
  // The gate's own parameters, as the run's graph version had them.
  getGraphVersion: () => ({
    id: "g1",
    version: 1,
    nodes: [{ id: "gate", type: "gate.textcase", params: { minNegativeRatio: 0.3, maxSteps: 8 } }],
    edges: [],
  }),
  outputStore: {
    getRun: (id: string) => runs[id],
    listRuns: () => Object.entries(runs).map(([id, r]) => ({ id, ...(r as object) })),
  },
}));

// Everything else in harness-core is real — the gate that re-scores an edited batch must be
// the same code the run used, or the two numbers would not be comparable.
vi.mock("@testpilot/harness-core", async (actual) => {
  const core = (await actual()) as Record<string, unknown>;
  const { FakeModel } = core as { FakeModel: new (r: () => string) => unknown };
  return { ...core, modelFromEnv: () => new FakeModel(() => replies.shift() ?? "{}") };
});

vi.mock("../src/db.js", () => ({
  createCase: (input: Record<string, unknown>) => {
    const kase = { id: `tc-${created.length + 1}`, ...input };
    created.push(kase);
    return kase;
  },
  recordReviewDecision: (d: Record<string, unknown>) => {
    decisions.push(d);
  },
  listReviewDecisions: (wfRunId: string) => decisions.filter((d) => d.wfRunId === wfRunId),
  saveReviewEdit: (wfRunId: string, caseId: string, edit: Record<string, unknown>) => {
    edits[`${wfRunId}:${caseId}`] = edit;
  },
  clearReviewEdit: (wfRunId: string, caseId: string) => {
    delete edits[`${wfRunId}:${caseId}`];
  },
  listReviewEdits: (wfRunId: string) =>
    Object.fromEntries(
      Object.entries(edits)
        .filter(([k]) => k.startsWith(`${wfRunId}:`))
        .map(([k, v]) => [k.slice(wfRunId.length + 1), v]),
    ),
}));

const { approve, batchAdjust, editCase, pendingRuns, regenerate, reject, reviewBatch } = await import(
  "../src/review.js"
);

const textCase = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  storyId: "US-01",
  title: `case ${id}`,
  designMethod: "negative",
  precondition: ["已打开登录页"],
  steps: ["输入错误密码", "点击 Sign in"],
  expected: "显示 Invalid username or password",
  // A tier-1 case carries the check a program would run; without it gate ① now says the
  // tier is a claim with nothing behind it, which would drown this file's assertions.
  oracle: { kind: "text", value: "Invalid username or password" },
  tier: 1,
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(outputs)) delete outputs[k];
  for (const k of Object.keys(runs)) delete runs[k];
  created.length = 0;
  decisions.length = 0;
  replies.length = 0;
  for (const k of Object.keys(edits)) delete edits[k];

  runs["wf-1"] = {
    id: "wf-1",
    graphId: "g1",
    graphVersion: 1,
    status: "done",
    detail: { target: { projectId: "prj-1" } },
  };
  outputs["wf-1:gate"] = {
    stories: [{ id: "US-01", title: "登录", acceptance: ["错误密码必须被拒绝"] }],
    cases: [textCase("c1"), textCase("c2", { designMethod: "equivalence", tier: 3 })],
    gate: {
      score: 0.5,
      stats: { cases: 2 },
      findings: [{ caseId: "c2", rule: "oracle-vague", severity: "warn", message: "assertion promises nothing" }],
    },
  };
});

afterEach(() => vi.clearAllMocks());

describe("review batch", () => {
  it("pairs each generated case with what the gate said about it", async () => {
    const batch = await reviewBatch("wf-1");
    expect(batch.items).toHaveLength(2);
    expect(batch.pending).toBe(2);
    expect(batch.items[0].findings).toEqual([]);
    expect(batch.items[1].findings[0].rule).toBe("oracle-vague");
    expect(batch.projectId).toBe("prj-1");
  });

  it("shows stage-two code and flags a case whose assertion was weakened", async () => {
    outputs["wf-1:repair"] = {
      code: [{ caseId: "c1", code: "await agent.aiAssert('shows the error');" }],
      gate: { findings: [{ caseId: "c2", rule: "no-assertion", severity: "block", message: "asserts nothing" }] },
      repair: { degraded: ["c1"] },
    };
    const batch = await reviewBatch("wf-1");
    expect(batch.items[0].code).toContain("aiAssert");
    expect(batch.items[0].degraded).toBe(true);
    expect(batch.items[1].codeBlocked).toBe(true);
  });
});

describe("editing in the queue", () => {
  it("keeps the product beside the edit, and re-scores the batch as the same gate would", async () => {
    // c2's assertion is what the gate objected to; replacing it with an observable one
    // should be visible as a better score, not merely as different text.
    const before = await reviewBatch("wf-1");
    expect(before.editedGateScore).toBeUndefined();
    expect(before.gateScore).toBe(0.5);

    const after = await editCase("wf-1", "c2", {
      expected: "页面显示「用户名不能为空」，且仍停留在登录页",
    });
    const item = after.items.find((i) => i.caseId === "c2")!;
    expect(item.expected).toContain("用户名不能为空");
    // The harness's own version is still there — it is what the gate scored, and what the
    // next version of the harness will be compared against.
    expect(item.original?.expected).toBe("显示 Invalid username or password");
    expect(item.edit?.by).toBe("human");
    expect(after.edited).toBe(1);
    expect(after.editedGateScore).toBeGreaterThan(0);
    // The tier-3 finding is still there (the edit did not touch the tier), so the two
    // numbers are the same gate looking at different text.
    expect(item.editedFindings?.some((f) => f.rule === "tier")).toBe(true);
  });

  it("refuses to edit a case that has already been decided", async () => {
    await approve({ wfRunId: "wf-1", caseIds: ["c1"] });
    await expect(editCase("wf-1", "c1", { title: "too late" })).rejects.toThrow(/already been approved/);
  });

  it("does not call a priority a rewrite", async () => {
    // Batch-prioritising a selection stores an edit against every case in it. Reporting
    // that as "edited in review" made a whole batch look rewritten when nothing was.
    await batchAdjust("wf-1", ["c1"], { kind: "priority", priority: "P0" });
    const batch = await reviewBatch("wf-1");
    expect(batch.items[0].edit?.priority).toBe("P0");
    expect(batch.items[0].original).toBeUndefined();
    await approve({ wfRunId: "wf-1", caseIds: ["c1"] });
    expect(String(created[0].priorityReason)).not.toContain("edited in review");
    expect(created[0].priority).toBe("P0");
  });

  it("carries the edit onto the board when the case is approved", async () => {
    await editCase("wf-1", "c1", { title: "改过的标题", priority: "P0" });
    await approve({ wfRunId: "wf-1", caseIds: ["c1"] });
    expect(created[0]).toMatchObject({ title: "改过的标题", priority: "P0" });
    expect(String(created[0].priorityReason)).toContain("edited in review");
  });
});

describe("adjusting a selection at once", () => {
  it("replaces an invented credential everywhere it appears, and nowhere it does not", async () => {
    outputs["wf-1:gate"] = {
      stories: [{ id: "US-01", title: "登录", acceptance: [] }],
      cases: [
        textCase("c1", { steps: ["输入用户名 testuser", "输入密码 testpass", "点击 Sign in"] }),
        textCase("c2", { steps: ["输入用户名 ${env.LOGIN_USER}", "点击 Sign in"] }),
      ],
      gate: { score: 1, stats: { cases: 2 }, findings: [] },
    };
    const { changed, batch } = await batchAdjust("wf-1", ["c1", "c2"], {
      kind: "replace",
      find: "testuser",
      with: "${env.LOGIN_USER}",
    });
    // Only the case that actually contained it counts as changed: an edit that changes
    // nothing would still mark the case as edited and open a diff on two identical columns.
    expect(changed).toEqual(["c1"]);
    expect(batch.items[0].steps[0]).toBe("输入用户名 ${env.LOGIN_USER}");
    expect(batch.items[1].edit).toBeUndefined();
  });

  it("sets a priority and adds a shared precondition without duplicating it", async () => {
    await batchAdjust("wf-1", ["c1", "c2"], { kind: "priority", priority: "P0" });
    const first = await batchAdjust("wf-1", ["c1"], { kind: "precondition", text: "已登录" });
    expect(first.changed).toEqual(["c1"]);
    expect(first.batch.items[0].precondition).toContain("已登录");
    const again = await batchAdjust("wf-1", ["c1"], { kind: "precondition", text: "已登录" });
    expect(again.changed).toEqual([]);
    // The priority set a moment ago survives the second edit.
    expect(again.batch.items[0].edit?.priority).toBe("P0");
  });

  it("reverts to what the harness produced", async () => {
    await editCase("wf-1", "c1", { title: "改过的" });
    const { changed, batch } = await batchAdjust("wf-1", ["c1", "c2"], { kind: "revert" });
    expect(changed).toEqual(["c1"]);
    expect(batch.items[0].title).toBe("case c1");
    expect(batch.edited).toBe(0);
  });

  it("leaves decided cases alone", async () => {
    await approve({ wfRunId: "wf-1", caseIds: ["c1"] });
    const { changed } = await batchAdjust("wf-1", ["c1", "c2"], { kind: "priority", priority: "P2" });
    expect(changed).toEqual(["c2"]);
  });
});

describe("regenerating", () => {
  it("answers the objections and lands as an edit, not as a replacement", async () => {
    replies.push(
      JSON.stringify({
        cases: [
          {
            title: "case c2",
            designMethod: "equivalence",
            precondition: ["已打开登录页"],
            steps: ["输入用户名 ${env.LOGIN_USER}", "点击 Sign in"],
            expected: "页面显示「Invalid username or password」",
            tier: 1,
            key: "login|bad-password|error-shown",
          },
        ],
      }),
    );
    const out = await regenerate("wf-1", ["c2"], { lang: "zh" });
    expect(out.revised).toEqual(["c2"]);
    const item = out.batch.items.find((i) => i.caseId === "c2")!;
    expect(item.edit?.by).toBe("model");
    expect(item.tier).toBe(1);
    // The product is untouched: a regeneration is a proposal like any other edit.
    expect(item.original?.tier).toBe(3);
  });

  it("reports the ones it could not rewrite instead of failing the whole selection", async () => {
    replies.push("not json at all");
    const out = await regenerate("wf-1", ["c2"]);
    expect(out.revised).toEqual([]);
    expect(out.failed[0]).toMatchObject({ caseId: "c2" });
    expect(out.batch.edited).toBe(0);
  });
});

describe("approving", () => {
  it("creates a case and carries the provenance onto the board", async () => {
    const out = await approve({ wfRunId: "wf-1", caseIds: ["c1"] });
    expect(out).toHaveLength(1);
    expect(created[0]).toMatchObject({
      projectId: "prj-1",
      title: "case c1",
      type: "negative", // design method mapped to the board's category
      storyId: "US-01",
      designMethod: "negative",
      tier: 1,
      gateScore: 0.5,
      sourceRunId: "wf-1",
    });
    expect((created[0].steps as Array<{ order: number }>).map((s) => s.order)).toEqual([1, 2]);
  });

  it("attaches the generated code so an approved case is runnable at once", async () => {
    outputs["wf-1:repair"] = { code: [{ caseId: "c1", code: "await agent.aiAssert('x');" }] };
    await approve({ wfRunId: "wf-1", caseIds: ["c1"] });
    expect(created[0]).toMatchObject({ hasCode: true });
    expect(String(created[0].code)).toContain("aiAssert");
  });

  it("applies edits made in the queue before approving", async () => {
    await approve({
      wfRunId: "wf-1",
      caseIds: ["c1"],
      edits: { c1: { title: "改过的标题", expected: "更具体的断言", priority: "P0" } },
    });
    expect(created[0]).toMatchObject({ title: "改过的标题", expected: "更具体的断言", priority: "P0" });
  });

  it("refuses to approve a run that was never bound to a project", async () => {
    runs["wf-2"] = { id: "wf-2", graphId: "g1", status: "done", detail: {} };
    outputs["wf-2:gate"] = { cases: [textCase("c1")], gate: { score: 1, findings: [] } };
    await expect(approve({ wfRunId: "wf-2", caseIds: ["c1"] })).rejects.toThrow(/not bound to a project/);
    expect(created).toHaveLength(0);
  });

  it("remembers the decision so the queue stops offering it", async () => {
    await approve({ wfRunId: "wf-1", caseIds: ["c1"] });
    const batch = await reviewBatch("wf-1");
    expect(batch.items[0].decision).toBe("approved");
    expect(batch.items[0].createdCaseId).toBe("tc-1");
    expect(batch.pending).toBe(1);
  });

  it("ignores a case id that is not in the batch instead of inventing one", async () => {
    const out = await approve({ wfRunId: "wf-1", caseIds: ["c1", "nope"] });
    expect(out).toHaveLength(1);
    expect(created).toHaveLength(1);
  });
});

describe("rejecting", () => {
  it("records the rejection and creates nothing", async () => {
    expect(reject({ wfRunId: "wf-1", caseIds: ["c2"], note: "重复" })).toBe(1);
    const batch = await reviewBatch("wf-1");
    expect(batch.items[1].decision).toBe("rejected");
    expect(created).toHaveLength(0);
    expect(batch.pending).toBe(1);
  });
});

describe("the queue itself", () => {
  it("lists runs that still have something waiting", async () => {
    const list = await pendingRuns();
    expect(list).toEqual([{ wfRunId: "wf-1", graphId: "g1", pending: 2, total: 2 }]);
  });

  it("skips a run whose outputs are gone rather than failing the whole list", async () => {
    runs["wf-gone"] = { id: "wf-gone", graphId: "g1", status: "done", detail: {} };
    const list = await pendingRuns();
    expect(list.map((r) => r.wfRunId)).toEqual(["wf-1"]);
  });
});

/**
 * 修复循环改过的东西，能不能跟着批准走到看板上。
 *
 * 这一组存在的理由是一个实测出来的断链：批准写进看板的 `steps` 一律取自**阶段一**的文本用例，
 * 而修复循环改的是阶段二的动作。于是它加的等待、改的措辞一条都传不下去——看板今晚仍然按
 * 原始步骤跑，而且可能因为修复循环**已经修好的那个理由**而挂。
 */
describe("what the board ends up running", () => {
  const withStageTwo = (over: Record<string, unknown> = {}) => {
    outputs["wf-1:repair"] = {
      fragments: [{ name: "sharedSetup", actions: [{ kind: "action", text: "打开登录页" }] }],
      code: [
        {
          caseId: "c1",
          code: "await agent.aiAction('…');",
          uses: ["sharedSetup"],
          actions: [
            { kind: "input", text: "${secret.PASSWORD}", field: "密码" },
            { kind: "action", text: "等待错误提示出现后点击 Sign in" },
            { kind: "assert", text: "显示 Invalid username or password" },
          ],
        },
      ],
      repair: { degraded: [] },
      ...over,
    };
  };

  it("takes the steps the repair loop actually ran, not stage one's", async () => {
    withStageTwo();
    await approve({ wfRunId: "wf-1", caseIds: ["c1"] });
    const steps = (created[0].steps as Array<{ text: string }>).map((s) => s.text);
    // 共享前置被展开：看板没有片段这个概念，一条用例要能独立跑起来。
    expect(steps[0]).toBe("打开登录页");
    expect(steps[1]).toBe("在「密码」输入 ${secret.PASSWORD}");
    // 修复循环加的等待到位了——这正是此前丢掉的东西。
    expect(steps[2]).toContain("等待错误提示出现");
    // 断言不进步骤：它是判决，看板用 expected 与 oracle 表达。
    expect(steps.some((t) => t.includes("Invalid username or password"))).toBe(false);
    expect(created[0].expected).toBe("显示 Invalid username or password");
    expect((created[0].oracle as { value: string }).value).toBe("Invalid username or password");
  });

  it("still prefers a person's edit over the machine's version", async () => {
    withStageTwo();
    await editCase("wf-1", "c1", { steps: ["人改过的一步"] });
    await approve({ wfRunId: "wf-1", caseIds: ["c1"] });
    const steps = (created[0].steps as Array<{ text: string }>).map((s) => s.text);
    expect(steps).toEqual(["人改过的一步"]);
  });

  it("falls back to stage one when the run never generated code", async () => {
    await approve({ wfRunId: "wf-1", caseIds: ["c1"] });
    const steps = (created[0].steps as Array<{ text: string }>).map((s) => s.text);
    expect(steps).toEqual(["输入错误密码", "点击 Sign in"]);
  });
});
