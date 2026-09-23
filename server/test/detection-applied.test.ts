import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * 变异注不进去时，不许报成「用例没抓到」。
 *
 * 实测撞到的：拿 PetClinic 那次运行跑 `/api/evals/detection`，5 个变异体全部「活下来」，
 * `mutationScore: 0`。而 `curl` 一比就知道 `/` 和 `/?defect=no-error` 的响应**逐字节相同**
 * ——那套 `?defect=` 注入只有内置 fixture 认，指向任何真实产品都会被忽略。
 *
 * 一个「0 分」读起来是「这套用例什么都抓不到」，事实是「这次实验根本没发生」。
 * 把工具自己的失败伪装成用例集的盲区，会让杀掉率虚低，而虚低的那部分看起来像真发现。
 */

const outputs: Record<string, unknown> = {};
const executed: string[] = [];

vi.mock("../src/graphs.js", () => ({
  nodeOutput: async (wfRunId: string, nodeId: string) => outputs[`${wfRunId}:${nodeId}`],
  allOutputs: async () => ({}),
  getGraph: () => undefined,
  runPromptDigest: () => ({}),
  startRun: async () => ({}),
  outputStore: { getRun: () => undefined, listRuns: () => [], saveRun: () => {} },
}));
vi.mock("../src/db.js", () => ({ listCases: () => [], saveEval: () => {}, listEvals: () => [], getEval: () => undefined }));

const { runDetectionEval, setCaseExecutor } = await import("../src/evals.js");

// 用例执行器是注入进来的（`setCaseExecutor`），测试里换成一个只记账不干活的。
setCaseExecutor(async (_target, kase) => {
  executed.push((kase as { caseId: string }).caseId);
  return { status: "passed" } as never;
});

const HEALTHY = "<html>healthy</html>";
beforeEach(() => {
  executed.length = 0;
  outputs["wf-1:repair"] = {
    code: [{ caseId: "c1", title: "c1", actions: [{ kind: "action", text: "点一下" }], uses: [] }],
    fragments: [],
  };
});

/** 一个只会返回同一段 HTML 的端点——正是「不认 ?defect= 的真实产品」的样子。 */
const stubFetch = (bodyFor: (url: string) => string) =>
  vi.stubGlobal("fetch", async (url: string | URL) =>
    ({ ok: true, text: async () => bodyFor(String(url)) }) as never);

describe("变异注不进去的时候", () => {
  it("报 applied=no，而且**不进分母**——不是「活下来」", async () => {
    stubFetch(() => HEALTHY); // 不管带不带 ?defect=，返回的都一样
    const r = await runDetectionEval({ wfRunId: "wf-1", defects: ["no-error"], limit: 1 });
    expect(r.mutants[0]!.applied).toBe("no");
    expect(r.notApplied).toBe(1);
    // 没有可评变异时不能用零分冒充有效测量。
    expect(r.mutationScore).toBeNull();
    expect(r.validity).toBe("unobservable");
    // 健康版那一轮照跑（它在量误报率，跟变异无关）；关键是**变异那一轮一条都不跑**——
    // 在健康版上再跑一整轮，除了烧钱什么也说明不了。所以总执行数就是健康版那一条。
    expect(executed).toEqual(["c1"]);
    expect(r.mutants[0]!.ran).toBe(0);
  });

  it("注得进去就照常跑并计分", async () => {
    stubFetch((u) => (u.includes("defect=") ? "<html>broken</html>" : HEALTHY));
    const r = await runDetectionEval({ wfRunId: "wf-1", defects: ["no-error"], limit: 1 });
    expect(r.mutants[0]!.applied).toBe("yes");
    expect(r.notApplied).toBe(0);
    // 健康版一轮 + 变异版一轮
    expect(executed).toEqual(["c1", "c1"]);
  });

  it("页面本身每次都在变时报 unknown，而不是硬判", async () => {
    let n = 0;
    stubFetch(() => `<html>${n++}</html>`); // 两遍健康版就不一样
    const r = await runDetectionEval({ wfRunId: "wf-1", defects: ["no-error"], limit: 1 });
    expect(r.mutants[0]!.applied).toBe("unknown");
    // unknown 不执行变异，也不计分；只有健康对照运行。
    expect(executed).toEqual(["c1"]);
    expect(r.mutationScore).toBeNull();
    expect(r.unknownInjection).toBe(1);
  });
});
