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

const { startRun, resumeRun, runDetail, outputStore, listGraphs } = await import("../src/graphs.js");

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

  it("refuses to resume a run that is not paused", async () => {
    const { wfRunId } = await startRun({ graphId: GRAPH, target: { url: "http://127.0.0.1:5301" } });
    await expect(resumeRun(wfRunId)).rejects.toThrow(/not paused/);
    await expect(resumeRun("wf-never-existed")).rejects.toThrow(/unknown run/);
  });
});
