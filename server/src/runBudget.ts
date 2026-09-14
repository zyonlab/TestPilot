/** Limits are captured per workflow attempt; model prices may be unknown, so these are call/time limits. */
export interface RunBudget { plannerCalls: number; executorCalls: number; wallMs: number }
export function configuredRunBudget(): RunBudget {
  const integer = (key: string, fallback: number, zero = false) => { const n = process.env[key] === undefined ? fallback : Number(process.env[key]); if (!Number.isInteger(n) || n < (zero ? 0 : 1)) throw new Error(`invalid_budget_${key}`); return n; };
  return { plannerCalls: integer('TP_PLANNER_MAX_CALLS', 100, true), executorCalls: integer('TP_EXECUTOR_MAX_CALLS', 100, true), wallMs: integer('TP_RUN_MAX_MS', 600_000) };
}

/**
 * 单元循环的预算按单元数放大。
 *
 * 默认的 100 次调用 / 10 分钟是给「一次写整份」那条路径定的。开了工作单元之后，
 * 一个单元至少是 claim + retrieve + write 三次调用，再加上模型自己的思考轮次；
 * 2026-09-11 实测（docs/v3/22）：Penguin 在 10 分钟里做完 6 个故事单元和 4 个用例单元，
 * 然后被墙钟掐断——`run-budget.json` 里写着 `wallMs: 600000`，而运行本身没有任何问题。
 * 一个会因为拆得更细而被自己的预算杀掉的机制，等于没有这个机制。
 *
 * 放大不是取消：每单元的份额固定，上限仍然存在，而且写进 run-budget.json，
 * 这次运行为什么能跑这么久是查得出来的。显式配了 env 就以 env 为准，不再放大。
 */
export const PER_UNIT_BUDGET = Object.freeze({ plannerCalls: 12, wallMs: 240_000, maxWallMs: 6 * 3600_000, maxPlannerCalls: 2000 });
export function unitRunBudget(units: number, base = configuredRunBudget()): RunBudget {
  if (units <= 0) return base;
  const scaled = {
    plannerCalls: process.env.TP_PLANNER_MAX_CALLS === undefined ? Math.min(PER_UNIT_BUDGET.maxPlannerCalls, Math.max(base.plannerCalls, units * PER_UNIT_BUDGET.plannerCalls)) : base.plannerCalls,
    executorCalls: base.executorCalls,
    wallMs: process.env.TP_RUN_MAX_MS === undefined ? Math.min(PER_UNIT_BUDGET.maxWallMs, Math.max(base.wallMs, units * PER_UNIT_BUDGET.wallMs)) : base.wallMs,
  };
  return scaled;
}

/**
 * 批次执行的预算按用例条数放大。
 *
 * 2026-09-13 实测（exec-1f7d2cdd）：81 条用例拿着一份 `configuredRunBudget()`
 * ——`wallMs: 600000`、`executorCalls: 100`。而 TC-001 一条就跑了 186 秒、转发 4 次调用。
 * 就算模型端一次 429 都不出，这批也只够跑到第三条，然后以 `budget_exhausted` 收场，
 * 剩下 78 条记成 `not_run`：一次什么都没测出来的执行。
 *
 * 跟 `unitRunBudget` 是同一条——**预算是按「一次运行」发的，而工作被拆成了 N 份**。
 *
 * 每条的份额取实测的两倍：TC-001 跑了 186 秒、转发 4 次调用，重跑时 TC-001/TC-002
 * 是 122 秒和 172 秒。所以 360 秒 / 12 次调用，留出重试和慢页面的余量。
 * （第一版我写的是 150 秒，还在注释里说那是「实测的两倍」——实测明明是 186 秒。
 * 81 条 × 150 秒 = 3.375 小时，而实际节奏就是 2.5 分钟一条，正好会在最后几条上
 * 被自己的预算掐断。数写错了，比没写更难发现。）
 *
 * 上限仍在，显式配了 env 就以 env 为准。
 */
export const PER_CASE_BUDGET = Object.freeze({ executorCalls: 12, wallMs: 360_000, maxWallMs: 6 * 3600_000, maxExecutorCalls: 2000 });
export function caseRunBudget(cases: number, base = configuredRunBudget()): RunBudget {
  if (cases <= 0) return base;
  return {
    plannerCalls: base.plannerCalls,
    executorCalls: process.env.TP_EXECUTOR_MAX_CALLS === undefined ? Math.min(PER_CASE_BUDGET.maxExecutorCalls, Math.max(base.executorCalls, cases * PER_CASE_BUDGET.executorCalls)) : base.executorCalls,
    wallMs: process.env.TP_RUN_MAX_MS === undefined ? Math.min(PER_CASE_BUDGET.maxWallMs, Math.max(base.wallMs, cases * PER_CASE_BUDGET.wallMs)) : base.wallMs,
  };
}
