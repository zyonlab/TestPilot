/**
 * 成本账的聚合（07 T-21）：脚本 `scripts/cost-report.mjs` 与网关 `GET /api/projects/:id/cost` **共用这一份**。
 * 输入是 runs 表的行（已按 startedAt 倒序）与退化账本；输出 `{ cases, totals }`——脚本 `--json` 打印的就是它，
 * 端点返回的也是它，两边逐字段一致由构造保证（`server/test/cost-shared.test.ts` 钉住）。
 */
export const median = (xs) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const spread = (xs) => (xs.length ? `${Math.min(...xs)}–${Math.max(...xs)}` : "—");
export const fmtMs = (ms) => (ms === undefined ? "—" : ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : `${(ms / 1000).toFixed(0)}s`);


export const PHASES = ["launchMs", "loginMs", "settleMs", "stepsMs", "assertMs", "teardownMs"];

export function aggregate(rows, degrades, { last = 10, usdPerMtok } = {}) {
const byCase = new Map();
for (const r of rows) {
  const list = byCase.get(r.caseId) ?? [];
  if (list.length >= last) continue;
  list.push(r);
  byCase.set(r.caseId, list);
}

const table = [];
let totals = { runs: 0, tokens: 0, modelCalls: 0, modelMs: 0, wallMs: 0, hits: 0, misses: 0, stale: 0, machine: 0, judge: 0, overlapped: 0, passed: 0, failures: { infra: 0, locate: 0, assert: 0, unknown: 0 }, unobservable: 0, healedRuns: 0, degraded: { total: 0, blocked: 0 }, phases: Object.fromEntries(PHASES.map((k) => [k, 0])), phasedRuns: 0, attribution: { runner: 0, window: 0 } };
for (const [caseId, runs] of byCase) {
  const spends = runs.map((r) => (r.spendJson ? JSON.parse(r.spendJson) : undefined));
  const withSpend = spends.filter(Boolean);
  const wall = runs.map((r) => r.durationMs);
  const oracles = runs.flatMap((r) => JSON.parse(r.oracleJson || "[]"));
  const machine = oracles.filter((o) => o.decidedBy === "machine").length;
  const judge = oracles.filter((o) => o.decidedBy === "judge").length;
  const tokens = withSpend.map((s) => s.tokens);
  const modelMs = withSpend.map((s) => s.modelMs);
  const hits = withSpend.reduce((a, s) => a + s.cacheHits, 0);
  const misses = withSpend.reduce((a, s) => a + s.cacheMisses, 0);
  const stale = withSpend.reduce((a, s) => a + s.cacheStale, 0);
  const PH = ["launchMs", "loginMs", "settleMs", "stepsMs", "assertMs", "teardownMs"];
  const phased = withSpend.filter((s) => s.phases);
  // 归账方式（07 T-04）：runner = 从跑它的 runner 自己的目录读，精确；window = 共享目录按时间窗，并发 > 1 会串。
  const attribution = { runner: withSpend.filter((s) => s.attribution === "runner").length, window: withSpend.filter((s) => s.attribution !== "runner").length };
  const phaseMedian = Object.fromEntries(PH.map((k) => [k, median(phased.map((s) => s.phases[k]))]));
  const passed = runs.filter((r) => r.status === "passed").length;
  /**
   * 失败分三类报（07 T-03）：夜间回归的核心指标是「早上人要看几条」，一个环境超时和一个真断言失败
   * 在表里不能长得一样。`failKind` 由 `server/src/db.ts` 的 `classifyFailure` 落库，这里只数不判。
   * `unobservable` 单独一列——它不是失败（None ≠ 0），不进任何分母，但要看得见。
   */
  const failed = runs.filter((r) => r.status !== "passed" && r.status !== "unobservable");
  const failures = { infra: 0, locate: 0, assert: 0, unknown: 0 };
  for (const r of failed) failures[r.failKind && r.failKind in failures ? r.failKind : r.infraError ? "infra" : "unknown"] += 1;
  const unobservable = runs.filter((r) => r.status === "unobservable").length;
  // 自愈（07 T-16）：这几次里自愈成功的次数，以及这条用例被记过的退化（改弱判据）几次 / 其中被拦几次。
  const healedRuns = runs.filter((r) => r.healed).length;
  const degradeRows = degrades.filter((d) => d.caseId === caseId);
  const degraded = { total: degradeRows.length, blocked: degradeRows.filter((d) => d.blocked).length };
  const infra = failures.infra;
  const row = {
    caseId,
    title: runs[0].caseTitle,
    priority: runs[0].priority,
    n: runs.length,
    passRate: runs.length ? passed / runs.length : 0,
    infra,
    failures,
    unobservable,
    healedRuns,
    degraded,
    phasedRuns: phased.length,
    phaseMedian,
    attribution,
    wallMedian: median(wall),
    wallSpread: spread(wall),
    modelCallsMedian: median(withSpend.map((s) => s.modelCalls)),
    modelMsMedian: median(modelMs),
    tokensMedian: median(tokens),
    cacheHitRate: hits + misses + stale ? hits / (hits + misses + stale) : undefined,
    stale,
    oracleMachineShare: machine + judge ? machine / (machine + judge) : undefined,
    usdMedian: usdPerMtok !== undefined && median(tokens) !== undefined ? (median(tokens) / 1e6) * usdPerMtok : undefined,
  };
  table.push(row);
  totals.runs += runs.length;
  totals.passed += passed;
  for (const k of Object.keys(failures)) totals.failures[k] += failures[k];
  totals.unobservable += unobservable;
  totals.healedRuns += healedRuns;
  totals.degraded.total += degraded.total;
  totals.degraded.blocked += degraded.blocked;
  for (const sp of phased) { totals.phasedRuns += 1; for (const k of PHASES) totals.phases[k] += sp.phases[k] ?? 0; }
  totals.attribution.runner += attribution.runner;
  totals.attribution.window += attribution.window;
  totals.tokens += tokens.reduce((a, b) => a + b, 0);
  totals.modelCalls += withSpend.reduce((a, s) => a + s.modelCalls, 0);
  totals.modelMs += modelMs.reduce((a, b) => a + b, 0);
  totals.wallMs += wall.reduce((a, b) => a + b, 0);
  totals.hits += hits;
  totals.misses += misses;
  totals.stale += stale;
  totals.machine += machine;
  totals.judge += judge;
}
table.sort((a, b) => (a.priority > b.priority ? 1 : a.priority < b.priority ? -1 : (b.wallMedian ?? 0) - (a.wallMedian ?? 0)));
  return { cases: table, totals };
}

export const PHASE_LABEL = { launchMs: "起浏览器", loginMs: "登录态", settleMs: "settle", stepsMs: "步骤", assertMs: "判据", teardownMs: "teardown" };
