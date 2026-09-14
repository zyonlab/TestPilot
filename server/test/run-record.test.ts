vi.mock("../src/runService.js", () => ({ registerWebRun: () => undefined, freezeGraphSources: () => undefined, runLedger: () => ({ registration: () => undefined }) }));
vi.mock("../src/modelSnapshots.js", () => import("./helpers/model-snapshot.js"));
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 一次运行的记录说的话对不对。
 *
 * 这一组钉的全是 P0 那一批（docs/archive/spec/17 的 U-02、U-04、U-07、U-09、U-10、U-12）——
 * 它们的共同形状是**界面在对自己的状态撒谎**，而"记录里写的是不是真的"是可判定的，
 * 所以每一条都该有一根钉子。没有钉子的要求，模型和代码都会漂。
 */

const started: Array<Record<string, unknown>> = [];
let cancelOk = true;

vi.mock("../src/procs.js", async () => {
  const { EventBus } = await import("@testpilot/harness-core");
  const bus = new EventBus();
  return {
    bus,
    setAgentExecutor: () => undefined,
    supervisor: {
      statusOf: () => ({ state: "alive" }),
      start: async () => undefined,
      rpc: () => ({
        startRun: async (input: Record<string, unknown>) => {
          started.push(input);
          return { wfRunId: String(input.wfRunId) };
        },
        cancelRun: async () => cancelOk,
        activeRuns: async () => [],
        nodeOutput: async () => undefined,
        allOutputs: async () => ({}),
      }),
    },
    tracing: undefined,
  };
});
vi.mock("../src/exec.js", () => ({ execOnRunner: async () => ({ status: "passed" }) }));
vi.mock("../src/settings.js", () => ({
  DEFAULT_PROMPTS: { explore: "x" },
  getSettings: () => ({ prompts: { explore: "explore template" } }),
}));

let project: unknown;
let environment: unknown;
vi.mock("../src/db.js", () => ({
  ARTIFACT_DIR: "/tmp",
  getProject: () => project,
  getSecretValues: () => ({}),
  resolveEnvironment: () => environment,
  // 点名的环境要能被查到——graphs 会自己再查一次，好在名字对不上时拦下来。
  listEnvironments: () => (environment ? [environment] : []),
}));

const g = await import("../src/graphs.js");
const { startRun, runDetail, outputStore, listGraphs, getGraph, missingUpstream, cancelRun, resumePoint } = g;
const { topoOrder } = await import("@testpilot/harness-core");
const GRAPH = listGraphs()[0]!.id;

beforeEach(() => {
  started.length = 0;
  cancelOk = true;
  project = undefined;
  environment = undefined;
});

describe("U-04 · 打的是哪里，按值记", () => {
  it("把解析出来的地址与那句人话一起存进运行记录", async () => {
    project = { id: "p1", name: "Acme 门户", materials: [] };
    environment = { id: "e1", name: "staging", baseUrl: "https://staging.acme.com", vars: {}, headers: {}, query: {}, login: {} };
    const { wfRunId } = await startRun({ graphId: GRAPH, target: { projectId: "p1", envRef: "e1" } });
    const snap = runDetail(wfRunId).targetSnapshot;
    expect(snap?.baseUrl).toBe("https://staging.acme.com");
    expect(snap?.describe).toBe("Acme 门户 / staging");
    // 关键：以后有人改了环境，这次运行的记录不跟着变。
    environment = { id: "e1", name: "staging", baseUrl: "https://SOMEWHERE-ELSE", vars: {}, headers: {}, query: {}, login: {} };
    expect(runDetail(wfRunId).targetSnapshot?.baseUrl).toBe("https://staging.acme.com");
  });

  it("解析不出目标也不拦运行——那是记账问题，不是可用性问题", async () => {
    const { wfRunId } = await startRun({ graphId: GRAPH, target: {} });
    expect(runDetail(wfRunId).targetSnapshot?.describe).toContain("目标解析不了");
  });

  it("点名一个不存在的环境，不拿别的环境顶上", async () => {
    project = { id: "p1", name: "Acme 门户", materials: [] };
    environment = { id: "e1", name: "staging", baseUrl: "https://staging.acme.com", vars: {}, headers: {}, query: {}, login: {} };
    const { wfRunId } = await startRun({ graphId: GRAPH, target: { projectId: "p1", envRef: "prod" } });
    // 打在 staging 上却记着「成功」是最坏的一种结果：记录里必须留下这次没能解析。
    const snap = runDetail(wfRunId).targetSnapshot;
    expect(snap?.describe).toContain("没有叫「prod」的环境");
    expect(snap?.baseUrl).toBeUndefined();
  });

  it("地址出处与环境是不是人选的，都记下来", async () => {
    project = { id: "p1", name: "Acme 门户", materials: [] };
    environment = { id: "e1", name: "staging", baseUrl: "https://staging.acme.com", vars: {}, headers: {}, query: {}, login: {} };
    const named = await startRun({ graphId: GRAPH, target: { projectId: "p1", envRef: "staging" } });
    expect(runDetail(named.wfRunId).targetSnapshot?.envPick).toBe("named");
    expect(runDetail(named.wfRunId).targetSnapshot?.urlFrom).toBe("env");

    const oneOff = await startRun({
      graphId: GRAPH,
      target: { projectId: "p1", url: "https://just-this-once.example" },
    });
    expect(runDetail(oneOff.wfRunId).targetSnapshot?.envPick).toBe("default");
    expect(runDetail(oneOff.wfRunId).targetSnapshot?.urlFrom).toBe("url");
  });
});

describe("U-02 · 项目材料到底有没有被读", () => {
  it("图上写死了路径时记成 graphPinned，而不是假装注入成功", async () => {
    project = { id: "p1", name: "Acme", materials: ["docs/prd.md", "docs/checkout.md"] };
    const def = getGraph(GRAPH)!;
    const specNode = def.nodes.find((n) => n.type === "source.spec");
    const { wfRunId } = await startRun({ graphId: GRAPH, target: { projectId: "p1" } });
    const m = runDetail(wfRunId).materials;
    if (specNode) {
      const params = (specNode.params ?? {}) as { paths?: string[]; path?: string; text?: string };
      const pinned = (Array.isArray(params.paths) && params.paths.length) || !!params.path || !!params.text;
      if (pinned) {
        // 这正是内置 g1 的情况：项目挂了 PRD，可这次跑的是图上那份 mock。
        expect(m?.graphPinned?.some((x) => x.node === specNode.id)).toBe(true);
        expect(m?.injected?.[specNode.id]).toBeUndefined();
      } else {
        expect(m?.injected?.[specNode.id]).toEqual(["docs/prd.md", "docs/checkout.md"]);
      }
    }
  });
});

describe("U-09 · 上游产物不在就不许重跑", () => {
  it("缺上游时说得出缺的是哪一个", async () => {
    const { wfRunId } = await startRun({ graphId: GRAPH, target: { url: "http://127.0.0.1:5301" } });
    const order = topoOrder(getGraph(GRAPH)!);
    expect(await missingUpstream(wfRunId, order[0]!)).toBeUndefined(); // 根节点没有上游
    if (order[1]) expect(await missingUpstream(wfRunId, order[1]!)).toBe(order[0]);
    await outputStore.set(wfRunId, order[0]!, { ok: true });
    if (order[1]) expect(await missingUpstream(wfRunId, order[1]!)).toBeUndefined();
  });
});

describe("U-12 · 取消要分得清停下了和进程已经不在了", () => {
  it("agent 还在 → requested；agent 没了 → agent-gone 且运行就地判为已取消", async () => {
    const a = await startRun({ graphId: GRAPH, target: { url: "http://127.0.0.1:5301" } });
    expect((await cancelRun(a.wfRunId)).result).toBe("requested");

    cancelOk = false;
    const b = await startRun({ graphId: GRAPH, target: { url: "http://127.0.0.1:5301" } });
    expect((await cancelRun(b.wfRunId)).result).toBe("agent-gone");
    expect(String(outputStore.getRun(b.wfRunId)?.status)).toBe("cancelled");

    expect((await cancelRun("wf-never-existed")).result).toBe("unknown-run");
  });
});

describe("U-11 · 续跑点按产物反推", () => {
  it("does not attribute today's models to a legacy run without a snapshot", async () => {
    const { wfRunId } = await startRun({ graphId: GRAPH, target: {} });
    const row = outputStore.getRun(wfRunId)!;
    outputStore.saveRun({ ...row, detail: { ...(row.detail ?? {}), modelRoles: undefined } });
    await expect(startRun({ graphId: GRAPH, wfRunId, target: {} })).rejects.toThrow("legacy_run_model_snapshot_missing");
  });
  it("什么都没产出 = 接不上（那叫整跑）", async () => {
    const { wfRunId } = await startRun({ graphId: GRAPH, target: { url: "http://127.0.0.1:5301" } });
    expect(await resumePoint(wfRunId)).toBeUndefined();
  });
});
