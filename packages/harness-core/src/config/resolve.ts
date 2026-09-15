import type { HarnessConfig, HarnessConfigInput } from "./types.js";

export const DEFAULT_CONFIG: HarnessConfig = {
  model: { concurrency: 1 },
  execution: { queueConcurrency: 1, runnerCount: 1 },
  events: { keepLast: 200_000, trimMs: 10 * 60_000 },
  budget: { calls: 500, usd: 0, ms: 4 * 60 * 60_000 },
  // 与 harness-testing/src/baselines/perf.ts 的 DEFAULT_BUDGETS 一致。
  perfBudget: { ttfbMs: 800, fcpMs: 1800, domContentLoadedMs: 3000, loadMs: 5000 },
  ablate: [],
  guard: { denyHosts: [], blockIrreversible: true },
  capabilities: [],
};

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const list = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * File first, env last. The env names are the ones that already existed — renaming them
 * would break every script and README that mentions them, and the point of this file is
 * to make the knobs discoverable, not to rename them.
 */
export function resolveHarnessConfig(
  file: HarnessConfigInput = {},
  env: NodeJS.ProcessEnv = process.env,
): HarnessConfig {
  const merged: HarnessConfig = {
    model: { ...DEFAULT_CONFIG.model, ...file.model },
    execution: { ...DEFAULT_CONFIG.execution, ...file.execution },
    events: { ...DEFAULT_CONFIG.events, ...file.events },
    budget: { ...DEFAULT_CONFIG.budget, ...file.budget },
    perfBudget: { ...DEFAULT_CONFIG.perfBudget, ...file.perfBudget },
    ablate: file.ablate ?? DEFAULT_CONFIG.ablate,
    guard: { ...DEFAULT_CONFIG.guard, ...file.guard },
    capabilities: file.capabilities ?? DEFAULT_CONFIG.capabilities,
  };

  merged.model.concurrency = num(env.MODEL_CONCURRENCY, merged.model.concurrency);
  merged.execution.queueConcurrency = num(env.RUN_CONCURRENCY, merged.execution.queueConcurrency);
  // Runners track the queue unless told otherwise: one runner runs one case at a time.
  merged.execution.runnerCount = num(
    env.RUNNER_COUNT,
    Math.max(merged.execution.runnerCount, merged.execution.queueConcurrency),
  );
  merged.events.keepLast = num(env.EVENTS_KEEP, merged.events.keepLast);
  merged.events.trimMs = num(env.EVENTS_TRIM_MS, merged.events.trimMs);
  if (env.ABLATE !== undefined) merged.ablate = list(env.ABLATE);
  if (env.DENY_HOSTS) merged.guard.denyHosts = [...merged.guard.denyHosts, ...list(env.DENY_HOSTS)];
  if (env.GUARD_OFF === "1") merged.guard.blockIrreversible = false;

  return merged;
}
