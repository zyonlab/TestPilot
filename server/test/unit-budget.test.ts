import { afterEach, describe, expect, it, vi } from "vitest";
import { PER_CASE_BUDGET, PER_UNIT_BUDGET, caseRunBudget, configuredRunBudget, unitRunBudget } from "../src/runBudget.js";

/**
 * 单元循环的预算按单元数放大（docs/v3/22）。
 * 这条测试钉的是一次真实事故：Penguin 在默认的 10 分钟里做完 10 个单元后被墙钟掐断，
 * 而运行本身没有任何问题——一个会因为拆得更细而被自己的预算杀掉的机制等于没有。
 */
afterEach(() => vi.unstubAllEnvs());

it("单元越多，墙钟与规划调用越宽，但不超过上限", () => {
  const base = configuredRunBudget();
  expect(unitRunBudget(0)).toEqual(base);
  const small = unitRunBudget(2);
  // 单元很少时不该比默认更紧。
  expect(small.wallMs).toBeGreaterThanOrEqual(base.wallMs);
  expect(small.plannerCalls).toBeGreaterThanOrEqual(base.plannerCalls);
  const big = unitRunBudget(28);
  expect(big.wallMs).toBe(28 * PER_UNIT_BUDGET.wallMs);
  expect(big.plannerCalls).toBe(28 * PER_UNIT_BUDGET.plannerCalls);
  expect(unitRunBudget(100000).wallMs).toBe(PER_UNIT_BUDGET.maxWallMs);
  expect(unitRunBudget(100000).plannerCalls).toBe(PER_UNIT_BUDGET.maxPlannerCalls);
  // 执行器预算不受影响：单元循环只影响规划。
  expect(big.executorCalls).toBe(base.executorCalls);
});

it("显式配了 env 就以 env 为准，不再放大", () => {
  vi.stubEnv("TP_RUN_MAX_MS", "900000");
  vi.stubEnv("TP_PLANNER_MAX_CALLS", "42");
  const b = unitRunBudget(28);
  expect(b.wallMs).toBe(900_000);
  expect(b.plannerCalls).toBe(42);
});

/**
 * 2026-09-13 exec-1f7d2cdd：81 条用例拿着一份「一次运行」的预算（600 秒 / 100 次调用），
 * 而一条就跑了 186 秒。就算模型端一次都不出错，也只够跑到第三条。
 */
describe("批次执行的预算按用例条数放大", () => {
  it("81 条不能还是 10 分钟", () => {
    const base = configuredRunBudget();
    const b = caseRunBudget(81, base);
    // 81 × 360 秒越过了 6 小时的天花板，于是按天花板发——放大有上限，这是上限在起作用。
    expect(b.wallMs).toBe(PER_CASE_BUDGET.maxWallMs);
    expect(caseRunBudget(20, base).wallMs).toBe(20 * PER_CASE_BUDGET.wallMs);
    expect(b.executorCalls).toBe(81 * PER_CASE_BUDGET.executorCalls);
    // 规划预算不受影响：批次执行只花执行器。
    expect(b.plannerCalls).toBe(base.plannerCalls);
  });

  it("上限仍在，0 条不放大", () => {
    expect(caseRunBudget(100000).wallMs).toBe(PER_CASE_BUDGET.maxWallMs);
    expect(caseRunBudget(100000).executorCalls).toBe(PER_CASE_BUDGET.maxExecutorCalls);
    expect(caseRunBudget(0)).toEqual(configuredRunBudget());
  });

  it("显式配了 env 就以 env 为准", () => {
    vi.stubEnv("TP_RUN_MAX_MS", "900000");
    vi.stubEnv("TP_EXECUTOR_MAX_CALLS", "42");
    const b = caseRunBudget(81);
    expect(b.wallMs).toBe(900_000);
    expect(b.executorCalls).toBe(42);
  });
});
