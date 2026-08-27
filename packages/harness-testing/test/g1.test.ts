import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EventBus,
  FakeModel,
  MemoryEventStore,
  MemoryOutputStore,
  runGraph,
  scoreCoverage,
  type Envelope,
  type GoldChecklist,
} from "@testpilot/harness-core";
import { g1 } from "../src/casegen/graph.js";
import { runGate } from "../src/casegen/gate.js";
import type { CaseBundle, GatedBundle } from "../src/casegen/types.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/mock-spec/", import.meta.url));
const SPEC = readFileSync(`${FIXTURES}acme-portal.md`, "utf8");
const GOLD = JSON.parse(readFileSync(`${FIXTURES}gold-checklist.json`, "utf8")) as GoldChecklist;

/**
 * G1 end to end on a fake model. No endpoint, no browser, no minutes — which is the whole
 * point: the TDD loop for stage one has to be seconds, or it stops being run.
 */
function fakeModel() {
  return new FakeModel((req) => {
    // 用户文档现在只是材料：先被整理成那份标准规格，下游才开始工作。
    if (req.label === "spec.compose")
      return JSON.stringify({
        title: "Acme Portal 登录模块",
        summary: "登录与错误提示。",
        rules: [
          { id: "R-1", text: "有效凭证登录后显示个人面板", evidence: "Your dashboard is ready." },
          { id: "R-2", text: "凭证错误时停留在登录页并提示", evidence: "Invalid username or password" },
        ],
        unknowns: ["注册与找回密码的流程材料里没有描述"],
      });
    if (req.label === "plan.stories")
      return JSON.stringify({
        stories: [
          { id: "US-01", title: "使用有效凭证登录", acceptance: ["登录成功后显示个人面板"] },
          { id: "US-02", title: "凭证错误时被拒绝", acceptance: ["显示 Invalid username or password"] },
        ],
      });
    if (req.label === "design.cases:US-01")
      return [
        "```json",
        JSON.stringify({
          cases: [
            {
              title: "使用有效凭证成功登录",
              designMethod: "equivalence",
              precondition: ["已打开登录页"],
              steps: ["输入 ${env.USERNAME}", "输入 ${secret.PASSWORD}", "点击 Sign in"],
              expected: "页面显示 Welcome, ${env.USERNAME} 与 Your dashboard is ready.",
              tier: 1,
              key: "login|valid|dashboard-shown",
            },
          ],
        }),
        "```",
      ].join("\n");
    if (req.label === "design.cases:US-02")
      return JSON.stringify({
        cases: [
          {
            title: "密码错误登录被拒绝",
            designMethod: "negative",
            precondition: [],
            steps: ["输入 ${env.USERNAME}", "输入错误密码 wrong-pass", "点击 Sign in"],
            expected: "显示 Invalid username or password，停留在登录页",
            tier: 1,
            key: "login|wrong-password|error-shown",
          },
          {
            title: "空用户名登录被拒绝",
            designMethod: "boundary",
            precondition: [],
            steps: ["用户名留空", "输入 ${secret.PASSWORD}", "点击 Sign in"],
            expected: "显示 Invalid username or password",
            tier: 1,
            key: "login|empty-username|error-shown",
          },
        ],
      });
    return "{}";
  });
}

function harness(model = fakeModel()) {
  const events: Envelope[] = [];
  const bus = new EventBus(new MemoryEventStore(), { coalesceMs: 0 });
  bus.subscribe((e) => events.push(e));
  const { registry, def } = g1(model, { spec: { text: SPEC }, specText: SPEC });
  return { bus, events, registry, def, store: new MemoryOutputStore(), model };
}

describe("G1: specification → text cases", () => {
  it("runs the whole pipeline and produces gated cases", async () => {
    const h = harness();
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });

    expect(r.status).toBe("done");
    const out = r.outputs.gate as GatedBundle;
    expect(out.stories.map((s) => s.id)).toEqual(["US-01", "US-02"]);
    expect(out.cases).toHaveLength(3);
    // Every case is traceable and carries its design method and verdict hardness.
    expect(out.cases.every((c) => c.storyId && c.designMethod && c.tier)).toBe(true);
    expect(out.gate.stats).toMatchObject({ cases: 3, orphans: 0, duplicates: 0 });
  });

  it("charges each model call to the node that made it", async () => {
    const h = harness();
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });
    const byNode = Object.fromEntries(r.nodes.map((n) => [n.nodeId, n.spend.calls]));
    // docs 只是读文件，不花模型；spec 是整理那一次；design 每条故事一次。
    expect(byNode).toMatchObject({ docs: 0, spec: 1, stories: 1, design: 2, gate: 0 });
    expect(r.spend.calls).toBe(4);
  });

  it("survives one story returning garbage instead of losing the batch", async () => {
    const model = new FakeModel((req) => {
      if (req.label === "spec.compose")
        return JSON.stringify({
          title: "t",
          summary: "s",
          rules: [{ id: "R-1", text: "登录成功显示面板", evidence: "Your dashboard is ready." }],
          unknowns: [], flows: [],
        });
      if (req.label === "plan.stories")
        return JSON.stringify({
          stories: [
            { id: "US-01", title: "ok", acceptance: [] },
            { id: "US-02", title: "broken", acceptance: [] },
          ],
        });
      if (req.label === "design.cases:US-02") return "I think the answer is that we should…";
      return JSON.stringify({
        cases: [
          {
            title: "有效凭证登录",
            designMethod: "equivalence",
            steps: ["点击 Sign in"],
            expected: "显示 Your dashboard is ready.",
            tier: 1,
            key: "login|valid|dashboard",
          },
        ],
      });
    });
    const h = harness(model);
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });
    expect(r.status).toBe("done");
    expect((r.outputs.gate as GatedBundle).cases).toHaveLength(1);
    // …and it says so, rather than quietly producing less.
    expect(h.events.some((e) => String((e.payload as { text?: string }).text ?? "").includes("US-02"))).toBe(true);
  });

  it("fails loudly when nothing usable came back at all", async () => {
    const h = harness(new FakeModel("no json here"));
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });
    expect(r.status).toBe("failed");
    // 第一个吃模型的节点现在是整理那一步：材料进不去标准形状，后面一步都不该走。
    expect(r.error?.node).toBe("spec");
    expect(r.error?.message).toMatch(/no JSON object/);
  });

  it("re-runs just the gate from stored cases — changing a threshold must not re-ask the model", async () => {
    const h = harness();
    const first = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });
    const callsBefore = h.model.calls.length;

    const strict = { ...h.def, nodes: h.def.nodes.map((n) => (n.id === "gate" ? { ...n, params: { minNegativeRatio: 0.9 } } : n)) };
    const again = await runGraph(strict, {
      registry: h.registry,
      bus: h.bus,
      store: h.store,
      wfRunId: first.wfRunId,
      mode: { kind: "only", node: "gate" },
    });

    expect(h.model.calls.length).toBe(callsBefore); // the model was not touched
    const gate = (again.outputs.gate as GatedBundle).gate;
    expect(gate.findings.some((f) => f.rule === "negative-ratio")).toBe(true);
  });

  it("scores the produced suite against the gold checklist", async () => {
    const h = harness();
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });
    const bundle = r.outputs.gate as GatedBundle;
    const cov = scoreCoverage(GOLD, bundle.cases);
    // Three cases cannot cover twelve gold items — the number's job is to say so.
    expect(cov.coverage).toBeGreaterThan(0);
    expect(cov.coverage).toBeLessThan(0.6);
    expect(cov.misses.length).toBeGreaterThan(3);
  });
});

describe("gate ①", () => {
  const bundle = (cases: CaseBundle["cases"]): CaseBundle => ({
    origin: "test",
    stories: [{ id: "US-01", title: "story", acceptance: [] }],
    cases,
  });
  const base = {
    id: "c1",
    storyId: "US-01",
    title: "case",
    designMethod: "equivalence" as const,
    precondition: [],
    steps: ["点击 Sign in"],
    expected: "显示 Your dashboard is ready.",
    // A tier-1 case now has to carry the check a program would run. Without it the gate
    // says so, which is the whole point of the rule.
    oracle: { kind: "text" as const, value: "Your dashboard is ready." },
    tier: 1 as const,
    key: "login|valid|dashboard",
  };

  it("marks an assertion that promises nothing checkable", () => {
    const g = runGate(bundle([{ ...base, expected: "页面显示正常" }]));
    expect(g.findings.some((f) => f.rule === "oracle-vague" && f.severity === "warn")).toBe(true);
  });

  it("marks a case that cannot be traced to a story", () => {
    const g = runGate(bundle([{ ...base, storyId: "US-99" }]));
    expect(g.stats.orphans).toBe(1);
  });

  it("marks two cases that cover the same thing in different words", () => {
    const g = runGate(bundle([base, { ...base, id: "c2", title: "另一个说法" }]));
    expect(g.stats.duplicates).toBe(1);
  });

  it("calls out a suite that is all happy path", () => {
    const g = runGate(bundle([base, { ...base, id: "c2", key: "login|valid2|dashboard" }]));
    expect(g.findings.some((f) => f.rule === "negative-ratio")).toBe(true);
    expect(g.stats.negativeRatio).toBe(0);
  });

  it("marks a credential written into a step instead of a placeholder", () => {
    const g = runGate(bundle([{ ...base, steps: ["输入 password: s3cr3t-pass"] }]));
    expect(g.findings.some((f) => f.rule === "secret")).toBe(true);
  });

  it("reports the tier mix, because 66 judge cases and 66 assert cases are different products", () => {
    const g = runGate(
      bundle([base, { ...base, id: "c2", tier: 3, key: "k2", expected: "界面看起来像话" }]),
    );
    expect(g.stats.tiers).toEqual({ "1": 1, "3": 1 });
  });

  it("notices a story nobody wrote a case for", () => {
    const b = bundle([base]);
    b.stories.push({ id: "US-02", title: "forgotten", acceptance: [] });
    expect(runGate(b).findings.some((f) => f.rule === "story-uncovered")).toBe(true);
  });

  it("scores a clean batch high and a messy one low, and never refuses either", () => {
    const clean = runGate(
      bundle([
        base,
        { ...base, id: "c2", designMethod: "negative", key: "login|wrong|error", expected: "显示 Invalid username or password" },
      ]),
    );
    const messy = runGate(bundle([{ ...base, expected: "一切正常", storyId: "US-42", oracle: undefined }]));
    expect(clean.score).toBeGreaterThan(messy.score);
    expect(messy.score).toBeLessThan(0.5);
  });

  it("calls out a tier the case cannot deliver, and reports both distributions", () => {
    // The label used to be unfalsifiable: every case could claim tier 1 and still be
    // settled by a model looking at a screenshot.
    const claimed = runGate(bundle([{ ...base, oracle: undefined }]));
    expect(claimed.findings.some((f) => f.rule === "tier-unbacked" && f.severity === "warn")).toBe(true);
    expect(claimed.stats.tiers).toEqual({ "1": 1 });
    expect(claimed.stats.tiersBacked).toEqual({ "3": 1 });

    const backed = runGate(bundle([base]));
    expect(backed.findings.some((f) => f.rule === "tier-unbacked")).toBe(false);
    expect(backed.stats.tiersBacked).toEqual({ "1": 1 });

    // An oracle that is really a relation cannot be sold as tier 1 either.
    const overclaimed = runGate(
      bundle([{ ...base, oracle: { kind: "delta" as const, value: "重启次数", direction: "increased" as const } }]),
    );
    expect(overclaimed.findings.some((f) => f.rule === "tier-unbacked" && f.message.includes("tier 2"))).toBe(true);
  });
});

describe("context budget", () => {
  it("trims the specification rather than letting the request grow without bound, and says so", async () => {
    const huge = `${SPEC}\n${"补充说明。".repeat(4000)}`;
    const model = fakeModel();
    const events: Envelope[] = [];
    const bus = new EventBus(new MemoryEventStore(), { coalesceMs: 0 });
    bus.subscribe((e) => events.push(e));
    const { registry, def } = g1(model, { spec: { text: huge }, specText: huge });
    const tight = {
      ...def,
      nodes: def.nodes.map((n) => (n.id === "design" ? { ...n, params: { specText: huge, contextTokens: 1500 } } : n)),
    };

    await runGraph(tight, { registry, bus, store: new MemoryOutputStore() });

    const call = model.calls.find((c) => c.label?.startsWith("design.cases"))!;
    expect(call.variable.length).toBeLessThan(huge.length);
    expect(call.variable).toContain("trimmed to fit the context budget");
    // The story itself is never trimmed — that is the part the call is about.
    expect(call.variable).toContain("US-01");
    expect(
      events.some((e) => String((e.payload as { text?: string }).text ?? "").includes("trimmed")),
    ).toBe(true);
  });
});

/**
 * 门禁①认出「不是故事的故事」。
 *
 * 实测产出里出现过「页面底部显示社交链接和版权信息」——没有人想要它，它只是一条关于
 * 屏幕的事实，由它衍生的用例做的也只能是「屏幕还是不是原来的样子」。
 * 只标记不拒收：判断一条故事有没有价值最终要人来看，门禁能做的是把该看的挑出来。
 */
describe("gate ① on the stories themselves", () => {
  const kase = {
    id: "c1",
    storyId: "US-01",
    title: "点击 Checkout 进入结账信息页",
    designMethod: "state-transition" as const,
    steps: ["点击 Checkout"],
    expected: "页面显示 Checkout: Your Information",
    tier: 1 as const,
    oracle: { kind: "text" as const, value: "Checkout: Your Information" },
    key: "checkout|cart|step-one",
  };
  const withStories = (stories: unknown[]) =>
    runGate({ origin: "x", stories: stories as never, cases: [kase] as never });

  it("说不出谁想要、能得到什么的条目被标出来", () => {
    const r = withStories([{ id: "US-01", title: "页面底部显示社交链接", acceptance: [] }]);
    expect(r.findings.some((f) => f.rule === "story-no-actor")).toBe(true);
  });

  it("有角色有价值的故事不被标", () => {
    const r = withStories([
      { id: "US-01", title: "完成下单", role: "顾客", benefit: "买到东西", acceptance: ["当点击 Checkout 时，进入结账信息页"] },
    ]);
    expect(r.findings.some((f) => f.rule === "story-no-actor")).toBe(false);
  });

  it("验收标准里一条触发都没有，也标出来——那些是描述，不是判据", () => {
    const r = withStories([
      { id: "US-01", title: "结账", role: "顾客", benefit: "下单", acceptance: ["结账页有三个输入框", "页面标题是 Checkout"] },
    ]);
    expect(r.findings.some((f) => f.rule === "acceptance-no-trigger")).toBe(true);
  });

  it("报出有多少故事挂在流程上——故事地图能不能画的前提", () => {
    const r = withStories([
      { id: "US-01", title: "完成下单", role: "顾客", benefit: "买到东西", flowId: "F-1", acceptance: [] },
      { id: "US-02", title: "页脚", acceptance: [] },
    ]);
    expect(r.stats.stories).toBe(2);
    expect(r.stats.storiesAnchored).toBe(1);
  });
});
