vi.mock("../src/runService.js", () => ({ registerWebRun: () => undefined, freezeGraphSources: () => undefined, runLedger: () => ({ registration: () => undefined }) }));
vi.mock("../src/modelSnapshots.js", () => import("./helpers/model-snapshot.js"));
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Breakpoints as the gateway sees them: they belong to the run, and "continue" means
 * carrying on from where it stopped without losing where else it should stop.
 *
 * The agent is stubbed — what is under test is the run record and the mode/breakpoints the
 * gateway hands over, not the runtime (which has its own tests for pausing).
 */

const started: Array<Record<string, unknown>> = [];

const agentApi = {
  startRun: async (input: Record<string, unknown>) => {
    started.push(input);
    return { wfRunId: String(input.wfRunId) };
  },
  cancelRun: async () => true,
  activeRuns: async () => [],
  nodeOutput: async () => undefined,
  allOutputs: async () => ({}),
};

vi.mock("../src/datadir.js", () => ({
  DATA_DIR: ":memory:",
  dataPath: () => ":memory:",
  INSTANCE: "test",
}));

vi.mock("../src/procs.js", () => ({
  bus: { subscribe: () => ({ close: () => undefined }) },
  setAgentExecutor: () => undefined,
  supervisor: {
    statusOf: () => ({ state: "alive" }),
    start: async () => undefined,
    rpc: () => agentApi,
  },
}));

vi.mock("../src/exec.js", () => ({ execOnRunner: async () => ({ status: "passed" }) }));

vi.mock("../src/settings.js", () => ({
  DEFAULT_PROMPTS: { explore: "x" },
  getSettings: () => ({ prompts: { explore: "explore template" } }),
}));

vi.mock("../src/db.js", () => ({
  ARTIFACT_DIR: "/tmp",
  getProject: () => undefined,
  getSecretValues: () => ({}),
  resolveEnvironment: () => undefined,
}));

const { startRun, resumeRun, runDetail, outputStore, listGraphs, getGraph, resumePoint, setRunBreakpoints } =
  await import("../src/graphs.js");
const { topoOrder } = await import("@testpilot/harness-core");

const GRAPH = listGraphs()[0]!.id;

describe("what an arm of a paired evaluation runs", () => {
  beforeEach(() => {
    started.length = 0;
  });

  it("folds a parameter override in per key, leaving the rest of the node's params alone", async () => {
    // The failure this guards against: replacing the params object instead of merging it.
    // The graph would still validate (params have defaults), and the experiment would
    // silently be measuring four changes while reporting one.
    const before = listGraphs().find((g) => g.id === "g1-text-cases")!;
    const designBefore = before.nodes.find((n) => n.id === "design")!.params as Record<string, unknown>;
    await startRun({
      graphId: "g1-text-cases",
      params: { design: { maxCasesPerStory: 10 } },
      target: { url: "http://127.0.0.1:5301" },
    });
    const def = (started.at(-1)!.def as typeof before);
    const design = def.nodes.find((n) => n.id === "design")!.params as Record<string, unknown>;
    expect(design.maxCasesPerStory).toBe(10);
    for (const [k, v] of Object.entries(designBefore)) expect(design[k]).toEqual(v);
    // Nothing leaks into the other nodes.
    expect(def.nodes.find((n) => n.id === "gate")!.params).toEqual(
      before.nodes.find((n) => n.id === "gate")!.params,
    );
  });

  it("records which instructions the run was produced by", async () => {
    // The version pins the shape and the parameters; the prompts live in source and in
    // settings, so without this a comparison can straddle a prompt edit and never say so.
    const { wfRunId } = await startRun({ graphId: "g1-text-cases", target: { url: "http://127.0.0.1:5301" } });
    const prompts = runDetail(wfRunId).prompts as { entries: Record<string, string>; combined: string };
    expect(prompts.combined).toMatch(/^[0-9a-f]{8}$/);
    expect(Object.keys(prompts.entries)).toEqual(
      expect.arrayContaining(["design.cases", "plan.stories", "settings:explore"]),
    );
  });

  it("records the overrides on the run — settings nobody wrote down are not a result", async () => {
    const { wfRunId } = await startRun({
      graphId: "g1-text-cases",
      params: { design: { maxCasesPerStory: 10 } },
      target: { url: "http://127.0.0.1:5301" },
    });
    expect(runDetail(wfRunId).paramOverrides).toEqual({ design: { maxCasesPerStory: 10 } });
  });

  it("refuses an override aimed at a node the graph does not have", async () => {
    // Otherwise the arm runs unchanged and the report says it was different.
    await expect(
      startRun({
        graphId: "g1-text-cases",
        params: { designn: { maxCasesPerStory: 10 } },
        target: { url: "http://127.0.0.1:5301" },
      }),
    ).rejects.toThrow(/no node called designn/);
  });

  it("refuses a graph version that was never saved", async () => {
    await expect(
      startRun({ graphId: "g1-text-cases", graphVersion: 99, target: { url: "http://127.0.0.1:5301" } }),
    ).rejects.toThrow(/no version 99/);
  });
});

describe("breakpoints on a run", () => {
  beforeEach(() => {
    started.length = 0;
  });

  it("records the breakpoints on the run, so a re-run of one node does not clear them", async () => {
    const { wfRunId } = await startRun({
      graphId: GRAPH,
      breakpoints: ["gate"],
      target: { url: "http://127.0.0.1:5301" },
    });
    expect(runDetail(wfRunId).breakpoints).toEqual(["gate"]);

    await startRun({ graphId: GRAPH, wfRunId, mode: { kind: "only", node: "spec" } });
    expect(runDetail(wfRunId).breakpoints).toEqual(["gate"]);
    // ...and the agent is told about them on that partial run too.
    expect(started.at(-1)).toMatchObject({ breakpoints: ["gate"] });
  });

  it("resumes from where it paused, keeping the breakpoint set", async () => {
    const { wfRunId } = await startRun({
      graphId: GRAPH,
      breakpoints: ["design", "gate"],
      target: { url: "http://127.0.0.1:5301" },
    });
    // The agent reports a pause by finishing the run with `pausedAt`; store it as it would.
    const row = outputStore.getRun(wfRunId)!;
    outputStore.saveRun({
      id: wfRunId,
      graphId: String(row.graphId),
      graphVersion: Number(row.graphVersion),
      status: "paused",
      startedAt: String(row.startedAt),
      finishedAt: new Date().toISOString(),
      detail: { ...(row.detail as object), pausedAt: "design" },
    });

    const resumed = await resumeRun(wfRunId);
    expect(resumed.from).toBe("design");
    expect(started.at(-1)).toMatchObject({
      wfRunId,
      mode: { kind: "from", node: "design" },
      breakpoints: ["design", "gate"],
    });
    // Running again clears where it stopped — a status that outlives its run is a lie.
    expect(runDetail(wfRunId).pausedAt).toBeUndefined();
  });

  /**
   * 2026-09-01 改了这条的判据。
   *
   * 原来只认 `pausedAt`，其余一律拒绝——包括被网关重启打断的运行，而它的产物就躺在
   * `wf_node_outputs` 里。实测 wf-mtfmsfq8：status=interrupted、detail 里没有 nodes 也没有
   * pausedAt，可 outputs 里有 docs 的产物；界面上整张图全是 idle，人只能自己猜从哪一步起。
   *
   * 所以现在的判据是「有没有可接上的地方」，而不是「有没有停在断点上」。
   * 一个节点都没产出的运行仍然拒绝——那才是真的没有可接的东西。
   */
  it("拒绝续跑一次什么都没产出的运行，但不再要求它必须停在断点上", async () => {
    const { wfRunId } = await startRun({ graphId: GRAPH, target: { url: "http://127.0.0.1:5301" } });
    await expect(resumeRun(wfRunId)).rejects.toThrow(/没有可接上的地方|一个节点都没产出/);
    await expect(resumeRun("wf-never-existed")).rejects.toThrow(/unknown run/);
  });

  it("被打断的运行按产物反推续跑点", async () => {
    const { wfRunId } = await startRun({ graphId: GRAPH, target: { url: "http://127.0.0.1:5301" } });
    const def = getGraph(GRAPH)!;
    const first = topoOrder(def)[0]!;
    // 模拟"跑完第一步就被打断"：产物落盘，运行记录停在 interrupted 且没有 pausedAt。
    await outputStore.set(wfRunId, first, { ok: true });
    const point = await resumePoint(wfRunId);
    expect(point?.done).toContain(first);
    expect(point?.from).toBe(topoOrder(def)[1]);
  });
});

/**
 * 断点属于这次运行，不属于浏览器。
 *
 * 此前它只活在前端 store 里，而且只有整跑那一次随请求发出——「只跑这一步」
 * 「从这里开始」「继续」三条路都不带它。于是画布上刚点亮的红点和「这次会不会停」
 * 是两回事，顶栏那个「断点 N」数的是本地那一份。
 */
describe("断点存进运行记录", () => {
  it("改过之后，部分重跑与续跑都用新的那一组", async () => {
    const { wfRunId } = await startRun({
      graphId: GRAPH,
      target: { url: "http://127.0.0.1:5301" },
      breakpoints: ["a"],
    });
    expect(runDetail(wfRunId).breakpoints).toEqual(["a"]);

    setRunBreakpoints(wfRunId, ["b", "c"]);
    expect(runDetail(wfRunId).breakpoints).toEqual(["b", "c"]);

    // 不带 breakpoints 的起跑（部分重跑走的就是这条）必须沿用运行里那一份
    started.length = 0;
    await startRun({ graphId: GRAPH, wfRunId, mode: { kind: "only", node: "docs" } });
    expect((started[0] as { breakpoints?: string[] }).breakpoints).toEqual(["b", "c"]);
  });

  it("没有这个运行时如实报错，不静默吞掉", () => {
    expect(() => setRunBreakpoints("wf-never-existed", ["x"])).toThrow(/unknown run/);
  });
});
