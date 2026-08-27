import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

/**
 * The code line's contract: the generated code belongs to a run, the runnable code belongs
 * to a case, and the page must be able to tell them apart — including when they have quietly
 * diverged.
 *
 * The run's outputs are stubbed; the database is real, because the link between the two
 * sides is a review decision row and matching on anything else is the bug this guards.
 */

const outputs: Record<string, unknown> = {};
const runs: Record<string, unknown> = { "wf-1": { id: "wf-1", graphId: "g2-code", status: "done" } };

vi.mock("../src/graphs.js", () => ({
  nodeOutput: async (wfRunId: string, nodeId: string) => outputs[`${wfRunId}:${nodeId}`],
  outputStore: { getRun: (id: string) => runs[id], listRuns: () => Object.values(runs) },
}));

const dir = resolve(tmpdir(), `tp-codeline-${process.pid}`);
let db: typeof import("../src/db.js");
let cl: typeof import("../src/codeline.js");

const GENERATED = "await agent.aiAction('log in');\nawait agent.aiAssert('the inventory is shown');";

beforeEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  process.env.TP_DATA_DIR = dir;
  vi.resetModules();
  db = await import("../src/db.js");
  cl = await import("../src/codeline.js");
  outputs["wf-1:repair"] = {
    code: [{ caseId: "US-02-1-登录成功", code: GENERATED, uses: ["flows/login"] }],
    fragments: [{ id: "flows/login" }],
    gate: {
      score: 0.9,
      findings: [{ caseId: "US-02-1-登录成功", rule: "invented-credential", severity: "block", message: "a literal password is typed" }],
    },
    repair: {
      rounds: [{ caseId: "US-02-1-登录成功", round: 1, changes: ["selector"] }],
      outcomes: [{ caseId: "US-02-1-登录成功", status: "passed", ms: 4200 }],
      degraded: ["US-02-1-登录成功"],
    },
  };
});

afterEach(() => {
  delete process.env.TP_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/** A board case that came from wf-1, carrying whatever code it was approved with. */
function approvedCase(code: string) {
  const p = db.createProject("proj", "https://example.com");
  const kase = db.createCase({
    projectId: p.id,
    title: "登录成功",
    priority: "P0",
    steps: [{ order: 1, text: "log in" }],
    code,
    hasCode: !!code,
    sourceRunId: "wf-1",
  });
  db.recordReviewDecision({
    wfRunId: "wf-1",
    caseId: "US-02-1-登录成功",
    decision: "approved",
    createdCaseId: kase.id,
    at: new Date().toISOString(),
  });
  return { projectId: p.id, kase };
}

describe("tracing a case back to the code that was generated for it", () => {
  it("reports the run's own gate score, repair rounds and degradation rather than recomputing them", async () => {
    const { kase } = approvedCase(GENERATED);
    const p = await cl.codeProvenance(kase.id);
    expect(p.generated).toBe(GENERATED);
    expect(p.current).toBe(GENERATED);
    expect(p.gate2).toBe(0.9);
    expect(p.rounds).toEqual([{ round: 1, changes: ["selector"] }]);
    expect(p.degraded).toBe(true);
    expect(p.outcome?.status).toBe("passed");
    expect(p.uses).toEqual(["flows/login"]);
    expect(p.findings).toHaveLength(1);
  });

  it("marks the case as drifted once the runnable code no longer matches what was generated", async () => {
    const { kase } = approvedCase(`${GENERATED}\nawait agent.aiAssert('and the cart is empty');`);
    expect((await cl.codeProvenance(kase.id)).drifted).toBe(true);
  });

  it("does not call a case drifted when it has no code at all", async () => {
    const { kase } = approvedCase("");
    const p = await cl.codeProvenance(kase.id);
    expect(p.drifted).toBe(false);
    expect(p.current).toBe("");
  });

  it("links through the review decision, not the title — two cases named alike stay apart", async () => {
    const { kase } = approvedCase(GENERATED);
    const stray = db.createCase({
      projectId: db.getCase(kase.id)!.projectId,
      title: "登录成功",
      priority: "P1",
      steps: [],
      sourceRunId: "wf-1",
    });
    // No decision row points at `stray`, so it must not inherit the other case's code.
    const p = await cl.codeProvenance(stray.id);
    expect(p.generated).toBeUndefined();
    expect(p.sourceCaseId).toBeUndefined();
  });

  it("says nothing about a hand-written case that never came from a run", async () => {
    const proj = db.createProject("hand", "https://example.com");
    const kase = db.createCase({ projectId: proj.id, title: "手写", priority: "P1", steps: [] });
    const p = await cl.codeProvenance(kase.id);
    expect(p.sourceRunId).toBeUndefined();
    expect(p.gate2).toBeUndefined();
  });
});

describe("the project's code line", () => {
  it("lists cases without code too, so the suite cannot look more runnable than it is", async () => {
    const { projectId } = approvedCase(GENERATED);
    db.createCase({ projectId, title: "还没生成代码", priority: "P2", steps: [] });
    const { rows } = await cl.codeLine(projectId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.hasCode)).toHaveLength(1);
  });
});

describe("what has been rewritten", () => {
  it("names the fields a review edit moved, and who moved them", async () => {
    const { projectId } = approvedCase(GENERATED);
    db.saveReviewEdit("wf-1", "US-02-1-登录成功", { expected: "更具体的期望", by: "model" });
    const rows = await cl.changes(projectId);
    const edit = rows.find((r) => r.kind === "review-edit");
    expect(edit?.by).toBe("model");
    expect(edit?.fields).toEqual(["期望"]);
  });

  it("ignores an edit that only set a priority — that is a decision about the board", async () => {
    const { projectId } = approvedCase(GENERATED);
    db.saveReviewEdit("wf-1", "US-02-1-登录成功", { priority: "P0", by: "human" });
    expect((await cl.changes(projectId)).filter((r) => r.kind === "review-edit")).toHaveLength(0);
  });

  it("still reports a rewrite that happened to also set a priority", async () => {
    const { projectId } = approvedCase(GENERATED);
    db.saveReviewEdit("wf-1", "US-02-1-登录成功", { priority: "P0", steps: ["先登录"], by: "human" });
    const edit = (await cl.changes(projectId)).find((r) => r.kind === "review-edit");
    expect(edit?.fields).toEqual(["步骤"]);
  });

  it("reports code that drifted after approval as its own kind of change", async () => {
    const { projectId } = approvedCase(`${GENERATED}\n// edited by hand`);
    const rows = await cl.changes(projectId);
    expect(rows.some((r) => r.kind === "code-drift")).toBe(true);
  });

  it("does not show edits made in another project's runs", async () => {
    const other = db.createProject("other", "https://example.com");
    db.saveReviewEdit("wf-1", "US-02-1-登录成功", { expected: "x", by: "human" });
    expect(await cl.changes(other.id)).toHaveLength(0);
  });
});
