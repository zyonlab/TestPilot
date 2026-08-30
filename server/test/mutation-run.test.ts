import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 变异测试的三条纪律，都有前车之鉴，所以都钉在这里。
 *
 * ① 先跑一遍干净的——没有基线就分不清「被变异体搞挂的」和「它本来就挂」。
 * ② 「没生效」和「活下来」必须分开，且不进分母。混为一谈会把工具自己的失败
 *    伪装成用例集的盲区，而虚低的那部分看起来像真发现。
 * ③ 变异体从**产品模型与规格**生成，用例集不参与——从用例生成变异体，
 *    量的就是「用例能不能抓到它自己」，一个必然为真的循环。
 */

const outputs: Record<string, unknown> = {};
const saved: Array<Record<string, unknown>> = [];
/** 每次执行记一笔：跑的是哪条用例、带没带变异体。用来验「先跑干净的」。 */
const calls: Array<{ caseId: string; mutantId?: string }> = [];
/** 测试指定哪些变异体「注得进去」。其余的 applied=0。 */
let appliesFor = new Set<string>();
/** 测试指定哪条用例在带某个变异体时会挂。 */
let failsWhen: (caseId: string, mutantId?: string) => boolean = () => false;

vi.mock("../src/graphs.js", () => ({
  nodeOutput: async (wfRunId: string, nodeId: string) => outputs[`${wfRunId}:${nodeId}`],
  outputStore: { getRun: () => ({ detail: { target: { url: "http://sut.invalid" } } }) },
  executeCaseDirect: async (
    _t: unknown,
    k: { caseId: string },
    _f: unknown,
    mutation?: { id: string },
  ) => {
    calls.push({ caseId: k.caseId, mutantId: mutation?.id });
    return {
      status: failsWhen(k.caseId, mutation?.id) ? "failed" : "passed",
      mutationApplied: mutation ? (appliesFor.has(mutation.id) ? 3 : 0) : undefined,
    };
  },
}));
vi.mock("../src/mutation.js", () => ({
  saveMutationReport: (r: Record<string, unknown>) => saved.push(r),
}));
vi.mock("../src/procs.js", () => ({ bus: { publish: () => {} } }));

const { runMutation } = await import("../src/mutationRun.js");

beforeEach(() => {
  calls.length = 0;
  saved.length = 0;
  appliesFor = new Set();
  failsWhen = () => false;
  for (const k of Object.keys(outputs)) delete outputs[k];
  outputs["wf-1:repair"] = {
    code: [
      { caseId: "c1", title: "c1", actions: [{ kind: "action", text: "点" }], uses: [] },
      { caseId: "c2", title: "c2", actions: [{ kind: "action", text: "点" }], uses: [] },
    ],
    fragments: [],
  };
  // 规则正文里带引号的界面文案 → text 算子的来源。用例集不参与。
  outputs["wf-1:spec"] = {
    rules: [
      { id: "R-1", text: '登录失败时显示「Invalid username or password」' },
      { id: "R-2", text: '面板顶部显示「Welcome」' },
    ],
  };
});

describe("变异测试的入口", () => {
  it("先跑一遍干净的，再跑每个变异体", async () => {
    await runMutation({ wfRunId: "wf-1", limit: 1 });
    // 头两次执行不带变异体：那是基线。
    expect(calls.slice(0, 2).every((c) => c.mutantId === undefined)).toBe(true);
    expect(calls.slice(0, 2).map((c) => c.caseId)).toEqual(["c1", "c2"]);
    // 之后每一轮都带同一个变异体 id。
    expect(calls.slice(2).every((c) => c.mutantId !== undefined)).toBe(true);
  });

  it("注不进去的记 notApplied，**不算活下来**，也不进分母", async () => {
    // 一个都不生效
    await runMutation({ wfRunId: "wf-1", limit: 1 });
    const r = saved[0]!;
    expect(r.notApplied).toBeGreaterThan(0);
    expect(r.survived).toBe(0);
    // 分母为零时分数是 0，但 notApplied 说明了它是什么意思——不是「一个都没抓到」。
    expect(r.killed).toBe(0);
  });

  it("生效了、没人叫，才算活下来（盲区）", async () => {
    const ids = ["M-1", "M-2", "M-3", "M-4"];
    appliesFor = new Set(ids);
    await runMutation({ wfRunId: "wf-1", limit: 1 });
    const r = saved[0]!;
    expect(r.notApplied).toBe(0);
    expect(r.survived).toBeGreaterThan(0);
    expect(r.score).toBe(0);
  });

  it("生效了、有用例新挂了，算杀掉", async () => {
    appliesFor = new Set(["M-1", "M-2", "M-3", "M-4"]);
    failsWhen = (_c, m) => !!m; // 带变异体就挂
    await runMutation({ wfRunId: "wf-1", limit: 1 });
    const r = saved[0]!;
    expect(r.killed).toBeGreaterThan(0);
    expect(r.survived).toBe(0);
    expect(r.score).toBe(1);
  });

  it("本来就挂着的用例不算「抓住了」——没有干净跑就分不清这两件事", async () => {
    appliesFor = new Set(["M-1", "M-2", "M-3", "M-4"]);
    failsWhen = (c) => c === "c1"; // c1 干净跑也挂
    await runMutation({ wfRunId: "wf-1", limit: 1 });
    const r = saved[0]!;
    // c1 在两边都挂，不是新失败，所以它不构成 kill。
    expect(r.killed).toBe(0);
    expect(r.survived).toBeGreaterThan(0);
  });

  it("生成不出变异体时如实报错，而不是给一份 0 分的报告", async () => {
    outputs["wf-1:spec"] = { rules: [] };
    await expect(runMutation({ wfRunId: "wf-1", limit: 1 })).rejects.toThrow(/生成不出变异体/);
    expect(saved).toHaveLength(0);
  });
});
