import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 接着往下跑的契约：能不能接上是**类型**说了算，不是名字。
 *
 * 阶段一与阶段二是两张图，所以「跑完 gate 然后呢」必须有人回答。回答的方式是：这次运行末端
 * 节点产出的类型，对上哪张图根节点要的类型。写死「g1 之后是 g2」也能跑通今天这一种情况，
 * 每加一张图就要再改一次这里——这些测试守的就是这件事没被写死。
 */

const graphs: Record<string, unknown> = {
  g1: {
    id: "g1", version: 1,
    nodes: [{ id: "spec", type: "source.spec" }, { id: "gate", type: "gate.textcase" }],
    edges: [{ from: "spec", to: "gate" }],
  },
  g2: {
    id: "g2", version: 1,
    nodes: [{ id: "codegen", type: "codegen.case" }, { id: "repair", type: "repair.loop" }],
    edges: [{ from: "codegen", to: "repair" }],
  },
  // 同样吃 gated-cases，所以它也该被列出来——列表不该只知道 g2 一张图。
  g3: { id: "g3", version: 1, nodes: [{ id: "only", type: "codegen.case" }], edges: [] },
  // 吃别的类型：接不上。
  gx: { id: "gx", version: 1, nodes: [{ id: "only", type: "source.spec" }], edges: [] },
};

const outputs: Record<string, unknown> = { "run-1:gate": { cases: [{ id: "c1" }] } };
const runs: Record<string, unknown> = {
  "run-1": { id: "run-1", graphId: "g1", graphVersion: 1, status: "done", detail: { target: { projectId: "prj-1" } } },
  "run-empty": { id: "run-empty", graphId: "g1", graphVersion: 1, status: "failed", detail: {} },
};

const started: Array<Record<string, unknown>> = [];

vi.mock("../src/graphs.js", () => ({
  getGraph: (id: string) => graphs[id],
  getGraphVersion: (id: string) => graphs[id],
  listGraphs: () => Object.values(graphs),
  nodeOutput: async (runId: string, nodeId: string) => outputs[`${runId}:${nodeId}`],
  outputStore: { getRun: (id: string) => runs[id] },
  registry: {
    list: () => [
      { type: "source.spec", inKind: null, outKind: "spec-text" },
      { type: "gate.textcase", inKind: "cases", outKind: "gated-cases" },
      { type: "codegen.case", inKind: "gated-cases", outKind: "code" },
      { type: "repair.loop", inKind: "code", outKind: "code" },
    ],
  },
  startRun: async (input: Record<string, unknown>) => {
    started.push(input);
    return { wfRunId: "run-2", graph: graphs[String(input.graphId)], target: input.target };
  },
}));

let mod: typeof import("../src/continue.js");

beforeEach(async () => {
  started.length = 0;
  vi.resetModules();
  mod = await import("../src/continue.js");
});

afterEach(() => vi.restoreAllMocks());

describe("哪几张图接得上", () => {
  it("按类型匹配，不按名字——所有吃 gated-cases 的图都列出来", async () => {
    const list = await mod.continuationsFor("run-1");
    expect(list.map((c) => c.graphId).sort()).toEqual(["g2", "g3"]);
    expect(list[0]).toMatchObject({ fromNode: "gate", intoNode: "codegen", kind: "gated-cases", ready: true });
  });

  it("类型对不上的图不出现", async () => {
    expect((await mod.continuationsFor("run-1")).some((c) => c.graphId === "gx")).toBe(false);
  });

  it("产物不存在时列出来但标着没就绪——失败的运行没有可接着跑的东西", async () => {
    const list = await mod.continuationsFor("run-empty");
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c) => c.ready)).toBe(false);
  });

  it("不认识的运行返回空，而不是抛错", async () => {
    expect(await mod.continuationsFor("nope")).toEqual([]);
  });
});

describe("起一次接着跑的运行", () => {
  it("用末端节点的产物作种子，并沿用源运行的目标端", async () => {
    const { wfRunId } = await mod.continueRun("run-1", "g2");
    expect(wfRunId).toBe("run-2");
    expect(started[0]).toMatchObject({
      graphId: "g2",
      seed: { cases: [{ id: "c1" }] },
      target: { projectId: "prj-1" },
    });
  });

  it("拒绝接不上的图，并说清为什么", async () => {
    await expect(mod.continueRun("run-1", "gx")).rejects.toThrow(/对不上/);
  });

  it("拒绝没有产物的运行", async () => {
    await expect(mod.continueRun("run-empty", "g2")).rejects.toThrow(/没有产出/);
  });
});
