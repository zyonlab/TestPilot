import { describe, expect, it } from "vitest";
import {
  ABLATABLE,
  ALL_ABLATABLE,
  EventBus,
  FakeModel,
  MemoryEventStore,
  MemoryOutputStore,
  NodeRegistry,
  parseAblation,
  runGraph,
  type GraphDef,
} from "@testpilot/harness-core";
import { caseGenNodes } from "../src/casegen/nodes.js";
import { codeGenNodes, type CaseExecutor } from "../src/codegen/nodes.js";
import type { GatedBundle } from "../src/casegen/types.js";
import type { GatedCodeBundle } from "../src/codegen/types.js";

/**
 * Every switch in the list has to change something a node does. A switch that changes
 * nothing turns the ablation report into a lie — which is worse than having no report,
 * because it looks like evidence.
 */

const SPEC = "登录模块：用户名 + 密码。凭证正确进入面板，错误显示 Invalid username or password。";

const storyReply = JSON.stringify({ stories: [{ id: "US-01", title: "登录", acceptance: ["显示面板"] }] });
const casesReply = JSON.stringify({
  cases: [
    {
      title: "有效凭证登录",
      designMethod: "equivalence",
      steps: ["输入 ${env.USERNAME}", "点击 Sign in"],
      expected: "页面显示正常",
      tier: 3,
      key: "login|valid|dashboard", covers: [],
    },
    {
      title: "同一件事换个说法",
      designMethod: "equivalence",
      steps: ["输入 ${env.USERNAME}", "点击 Sign in"],
      expected: "页面显示正常",
      tier: 3,
      key: "login|valid|dashboard", covers: [],
    },
  ],
});

function g1Harness() {
  const model = new FakeModel((req) =>
    req.label === "spec.compose"
      ? JSON.stringify({ title: "t", summary: "s", rules: [{ id: "R-1", text: "r", evidence: "e" }], unknowns: [], flows: [] })
      : req.label === "plan.stories"
        ? storyReply
        : casesReply,
  );
  const bus = new EventBus(new MemoryEventStore(), { coalesceMs: 0 });
  const registry = new NodeRegistry();
  for (const n of caseGenNodes({ model })) registry.register(n);
  const def: GraphDef = {
    id: "g1",
    version: 1,
    nodes: [
      // 用户文档是材料，标准规格由 spec.compose 产出——下游只认后者。
      { id: "docs", type: "source.spec", params: { text: SPEC } },
      { id: "spec", type: "spec.compose" },
      { id: "stories", type: "plan.stories" },
      { id: "design", type: "design.cases", params: { specText: SPEC } },
      { id: "gate", type: "gate.textcase" },
    ],
    edges: [
      { from: "docs", to: "spec" },
      { from: "spec", to: "stories" },
      { from: "stories", to: "design" },
      { from: "design", to: "gate" },
    ],
  };
  return { model, bus, registry, def, store: new MemoryOutputStore() };
}

describe("the ablation list", () => {
  it("accepts only names a node actually reads", () => {
    expect(parseAblation("design-methods,oracle-grading")).toEqual({
      on: ["design-methods", "oracle-grading"],
      unknown: [],
    });
    // A typo must be reported, not silently ignored: a run "with memory off" that never
    // turned anything off would be reported as evidence about memory.
    expect(parseAblation("memroy")).toEqual({ on: [], unknown: ["memroy"] });
  });

  it("lists exactly the switches this harness can prove", () => {
    expect(ALL_ABLATABLE.sort()).toEqual(
      ["dedupe", "design-methods", "fragments", "oracle-grading", "repair"].sort(),
    );
  });
});

describe("switches that change what a node does", () => {
  it("design-methods: the prompt stops naming the methods", async () => {
    const on = g1Harness();
    await runGraph(on.def, { registry: on.registry, bus: on.bus, store: on.store });
    const withMethods = on.model.calls.find((c) => c.label?.startsWith("design.cases"))!.stable;

    const off = g1Harness();
    await runGraph(off.def, {
      registry: off.registry,
      bus: off.bus,
      store: off.store,
      ablate: [ABLATABLE.designMethods],
    });
    const without = off.model.calls.find((c) => c.label?.startsWith("design.cases"))!.stable;

    expect(withMethods).toContain("Apply test design methods explicitly");
    expect(without).not.toContain("Apply test design methods explicitly");
    expect(without).toContain("concrete, checkable outcome"); // the rest of the job is unchanged
  });

  it("oracle-grading: the gate stops judging assertion hardness", async () => {
    const on = g1Harness();
    const a = await runGraph(on.def, { registry: on.registry, bus: on.bus, store: on.store });
    const graded = (a.outputs.gate as GatedBundle).gate;

    const off = g1Harness();
    const b = await runGraph(off.def, {
      registry: off.registry,
      bus: off.bus,
      store: off.store,
      ablate: [ABLATABLE.oracleGrading],
    });
    const ungraded = (b.outputs.gate as GatedBundle).gate;

    expect(graded.findings.some((f) => f.rule === "oracle-vague")).toBe(true);
    expect(ungraded.findings.some((f) => f.rule === "oracle-vague")).toBe(false);
    expect(ungraded.findings.some((f) => f.rule === "tier")).toBe(false);
  });

  it("dedupe: two cases with the same key stop being collapsed", async () => {
    const on = g1Harness();
    const a = await runGraph(on.def, { registry: on.registry, bus: on.bus, store: on.store });
    expect((a.outputs.gate as GatedBundle).gate.stats.duplicates).toBe(1);

    const off = g1Harness();
    const b = await runGraph(off.def, {
      registry: off.registry,
      bus: off.bus,
      store: off.store,
      ablate: [ABLATABLE.dedupe],
    });
    expect((b.outputs.gate as GatedBundle).gate.stats.duplicates).toBe(0);
  });
});

describe("stage-two switches", () => {
  const seed = (): GatedBundle => ({ origin: "x", flows: [], stories: [{ id: "US-01", title: "登录", acceptance: [] }],
    cases: [
      {
        id: "c1",
        storyId: "US-01",
        title: "登录",
        designMethod: "equivalence",
        precondition: [],
        steps: ["输入用户名", "点击 Sign in"],
        expected: "显示面板",
        tier: 1,
        key: "k1", covers: [],
      },
      {
        id: "c2",
        storyId: "US-01",
        title: "登录后退出",
        designMethod: "state-transition",
        precondition: [],
        steps: ["输入用户名", "点击 Sign in", "点击 Log out"],
        expected: "显示登录表单",
        tier: 1,
        key: "k2", covers: [],
      },
    ],
    gate: { score: 1, findings: [], stats: { cases: 2, tiers: {}, tiersBacked: {}, methods: {}, negativeRatio: 0, orphans: 0, duplicates: 0 } },
  });

  const codeFor = (id: string) =>
    id === "c1"
      ? "await agent.aiInput('${env.USERNAME}', 'user');\nawait agent.aiAction('click Sign in');\nawait agent.aiAssert('shows dashboard');"
      : "await agent.aiInput('${env.USERNAME}', 'user');\nawait agent.aiAction('click Sign in');\nawait agent.aiAction('click Log out');\nawait agent.aiAssert('shows the login form');";

  function g2Harness(executor: CaseExecutor) {
    const model = new FakeModel((req) =>
      req.label?.startsWith("repair:") ? codeFor("c1") : codeFor(req.label?.split(":")[1] ?? "c1"),
    );
    const bus = new EventBus(new MemoryEventStore(), { coalesceMs: 0 });
    const registry = new NodeRegistry();
    for (const n of codeGenNodes({ model, executor })) registry.register(n);
    const def: GraphDef = {
      id: "g2",
      version: 1,
      nodes: [
        { id: "codegen", type: "codegen.case" },
        { id: "gate", type: "gate.code" },
        { id: "repair", type: "repair.loop", params: { maxRounds: 2 } },
      ],
      edges: [
        { from: "codegen", to: "gate" },
        { from: "gate", to: "repair" },
      ],
    };
    return { model, bus, registry, def, store: new MemoryOutputStore() };
  }

  const passing: CaseExecutor = { run: async ({ caseId }) => ({ caseId, status: "passed", ms: 1 }) };

  it("fragments: the shared prologue stops being lifted out", async () => {
    const on = g2Harness(passing);
    const a = await runGraph(on.def, { registry: on.registry, bus: on.bus, store: on.store, input: seed() });
    expect((a.outputs.repair as GatedCodeBundle).fragments).toHaveLength(1);

    const off = g2Harness(passing);
    const b = await runGraph(off.def, {
      registry: off.registry,
      bus: off.bus,
      store: off.store,
      input: seed(),
      ablate: [ABLATABLE.fragments],
    });
    expect((b.outputs.repair as GatedCodeBundle).fragments).toHaveLength(0);
  });

  it("repair: a failing case is executed but never fixed", async () => {
    const failing: CaseExecutor = {
      run: async ({ caseId }) => ({ caseId, status: "failed", failKind: "locate", message: "not found", ms: 1 }),
    };
    const on = g2Harness(failing);
    const a = await runGraph(on.def, { registry: on.registry, bus: on.bus, store: on.store, input: seed() });
    expect((a.outputs.repair as { repair: { rounds: unknown[] } }).repair.rounds.length).toBeGreaterThan(0);

    const off = g2Harness(failing);
    const b = await runGraph(off.def, {
      registry: off.registry,
      bus: off.bus,
      store: off.store,
      input: seed(),
      ablate: [ABLATABLE.repair],
    });
    const report = (b.outputs.repair as { repair: { rounds: unknown[]; outcomes: unknown[] } }).repair;
    expect(report.rounds).toHaveLength(0);
    expect(report.outcomes).toHaveLength(2); // still executed, just not repaired
  });
});
