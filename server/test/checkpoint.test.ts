import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 「撑不撑得住三天」不用真跑三天来回答——它是四个可以分别定价的洞，
 * 每一个都能在秒级重现。这里钉住的是其中三个：
 *
 * ① 崩溃的运行有自动恢复入口，而且知道从第几步接上；
 * ② 反复 kill / resume 之后，步骤史是**累加**的，不是被最后一段覆盖；
 * ③ 上限与已花费跨段仍然是整次运行的，不会因为恢复动作被清零。
 */
vi.mock("./../src/model.js", () => ({ model: {}, reconfigureModel: () => {} }));
vi.mock("../src/settings.js", () => ({ getSettings: () => ({ prompts: { explore: "x" } }) }));
vi.mock("../src/db.js", () => ({
  ARTIFACT_DIR: "/tmp",
  getProject: () => undefined,
  getSecretValues: () => ({}),
  resolveEnvironment: () => undefined,
  listEnvironments: () => [],
}));

const g = await import("../src/graphs.js");
const { startRun, runDetail, outputStore, listGraphs, resumePoint, reconcileOrphanedRuns } = g;
const GRAPH = listGraphs().find((x) => x.id === "g1-text-cases")!.id;

/** 假装一段跑完了：写下产物与这一段的步骤史，就像 runtime 那样。 */
async function segment(wfRunId: string, nodes: string[], spend: { calls: number; tokens: number }) {
  for (const n of nodes) await outputStore.set(wfRunId, n, { ok: n });
  const row = outputStore.getRun(wfRunId)!;
  outputStore.saveRun({
    id: wfRunId,
    graphId: String(row.graphId),
    graphVersion: Number(row.graphVersion),
    status: "running",
    startedAt: String(row.startedAt),
    detail: {
      ...(row.detail as Record<string, unknown>),
      nodes: [
        ...(((row.detail as { nodes?: unknown[] }).nodes ?? []) as unknown[]),
        ...nodes.map((n) => ({ nodeId: n, type: "x", status: "done", ms: 1000, spend })),
      ],
      spend,
    },
  });
}

/** 拔电源：进程没了，运行记录停在 running 上。 */
function kill(): void {
  reconcileOrphanedRuns(() => {});
}

beforeEach(() => vi.clearAllMocks());

describe("U-64 · 反复中断再接上", () => {
  it("崩了三次接三次：步骤史累加，接上的地方每次都对", async () => {
    const { wfRunId } = await startRun({ graphId: GRAPH, budget: { calls: 100 } });

    await segment(wfRunId, ["docs"], { calls: 3, tokens: 300 });
    kill();
    expect(String(outputStore.getRun(wfRunId)!.status)).toBe("interrupted");
    let point = await resumePoint(wfRunId);
    // 产物是事实：跑过一步，所以接上的地方是第二步，而不是从头。
    expect(point?.done).toEqual(["docs"]);
    expect(point?.from).toBe("spec");

    await segment(wfRunId, ["spec"], { calls: 7, tokens: 900 });
    kill();
    point = await resumePoint(wfRunId);
    expect(point?.done).toEqual(["docs", "spec"]);
    expect(point?.from).toBe("stories");

    await segment(wfRunId, ["stories"], { calls: 11, tokens: 1500 });
    kill();
    point = await resumePoint(wfRunId);
    expect(point?.done).toEqual(["docs", "spec", "stories"]);

    // 三段的步骤史都还在——被最后一段覆盖的话，一次跑了三步的运行会显示成只跑了一步。
    const detail = runDetail(wfRunId);
    expect((detail.nodes ?? []).map((n) => n.nodeId)).toEqual(["docs", "spec", "stories"]);
    // 上限跨段还是整次运行的上限，没有因为恢复被清零。
    expect(detail.budget?.calls).toBe(100);
    expect(detail.spend?.calls).toBe(11);
  });

  it("一步都没跑成的运行没有「接上」这回事——那叫整跑", async () => {
    /*
     * 直接写一条什么都没产出的运行记录。
     *
     * 不走 startRun：那会真的把图跑起来，而 `source.spec` 只是读一个文件，
     * 在测试里几毫秒就跑完了——于是「一步都没跑成」这个状态根本构造不出来。
     */
    const wfRunId = `wf-nothing-${Math.random().toString(36).slice(2, 8)}`;
    outputStore.saveRun({
      id: wfRunId,
      graphId: GRAPH,
      graphVersion: 1,
      status: "interrupted",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      detail: {},
    });
    // 从第一步开始那叫整跑，不叫续跑。把两者混成一个按钮，
    // 会让「接着跑」在最该提醒人的时候悄悄重跑二十分钟。
    expect(await resumePoint(wfRunId)).toBeUndefined();
  });

  it("跑完的运行不会被 reconcile 改写成 interrupted", async () => {
    const { wfRunId } = await startRun({ graphId: GRAPH });
    const row = outputStore.getRun(wfRunId)!;
    outputStore.saveRun({
      id: wfRunId,
      graphId: String(row.graphId),
      graphVersion: Number(row.graphVersion),
      status: "done",
      startedAt: String(row.startedAt),
      finishedAt: new Date().toISOString(),
      detail: row.detail,
    });
    kill();
    expect(String(outputStore.getRun(wfRunId)!.status)).toBe("done");
  });
});
