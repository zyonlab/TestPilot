/**
 * 两次（或多次）执行之间的对比：谁修好了、谁回归了、谁只是在抖。
 *
 * 为什么不能只比「通过数」：同一批 35 条用例在 Hyperliquid 主网上连跑五次，通过数是
 * 29、29、32、30、32——看起来稳定，而失败的**是不同的六条**（docs/v3/23 §12.5）。
 * 只看总数会把「修好了一条、又坏了一条」读成「没变化」，把一次抖动读成一次回归。
 * 判决要落在**每条用例**上，而且要能说出「这条到底是回归了，还是它本来就时好时坏」。
 */

export type CaseVerdict = "passed" | "failed" | "not_run" | "unobservable";

export interface ExecutionSnapshot {
  executionId: string;
  /** 编译产物的版本。不同版本之间的差异可能来自用例本身，不能算回归。 */
  codeRevision?: string;
  at?: string;
  results: Array<{ caseId: string; status: CaseVerdict; failureCode?: string }>;
}

export type CaseChange = "fixed" | "regressed" | "still-passing" | "still-failing" | "flaky" | "appeared" | "disappeared";

export interface CaseComparison {
  caseId: string;
  baseline: CaseVerdict | null;
  current: CaseVerdict | null;
  change: CaseChange;
  /** 判决翻转了几次。1 是变了一次并稳住，≥2 才是抖。 */
  flips: number;
  /** 这条用例在参与对比的各次执行里分别是什么判决——抖不抖一眼能看出来。 */
  history: CaseVerdict[];
  failureCode?: string;
}

export interface ComparisonSummary {
  fixed: number; regressed: number; flaky: number;
  stillPassing: number; stillFailing: number; appeared: number; disappeared: number;
  sameCodeRevision: boolean;
}

/**
 * 抖 = **判决翻转不止一次**。
 *
 * 第一版的判据是「出现过不止一种判决」，太粗：`P→F→F→F→F` 被判成抖，而它其实是
 * 一次回归然后稳住了——那是产品（或用例）真的坏了，不是运气。真跑的五次执行里，
 * 12 条被判成「抖」的用例里有 8 条是这种「变了一次就稳住」。
 *
 * 数翻转次数就分得开：变一次并稳住是**真变化**（fixed / regressed），
 * 变两次以上才是**真抖**（`P→P→P→F→P`、`F→P→P→F→P`）。
 *
 * 两个点分不出抖和变，所以至少要三次观测。
 */
function transitions(history: CaseVerdict[]): number {
  const settled = history.filter((v) => v === "passed" || v === "failed");
  let n = 0;
  for (let i = 1; i < settled.length; i++) if (settled[i] !== settled[i - 1]) n++;
  return n;
}
function isFlaky(history: CaseVerdict[]): boolean {
  return history.length >= 3 && transitions(history) >= 2;
}

export function compareExecutions(baseline: ExecutionSnapshot, current: ExecutionSnapshot, between: ExecutionSnapshot[] = []): { cases: CaseComparison[]; summary: ComparisonSummary } {
  const order = [baseline, ...between, current];
  const byCase = new Map<string, CaseVerdict[]>();
  const ids = new Set<string>();
  for (const snap of order) for (const r of snap.results) ids.add(r.caseId);
  for (const id of ids) byCase.set(id, order.map((s) => s.results.find((r) => r.caseId === id)?.status).filter((v): v is CaseVerdict => !!v));

  const verdict = (snap: ExecutionSnapshot, id: string) => snap.results.find((r) => r.caseId === id)?.status ?? null;
  const cases: CaseComparison[] = [...ids].sort().map((caseId) => {
    const b = verdict(baseline, caseId), c = verdict(current, caseId);
    const history = byCase.get(caseId) ?? [];
    const failureCode = current.results.find((r) => r.caseId === caseId)?.failureCode;
    const flips = transitions(history);
    let change: CaseChange;
    if (b === null) change = "appeared";
    else if (c === null) change = "disappeared";
    else if (isFlaky(history)) change = "flaky";
    else if (b !== "passed" && c === "passed") change = "fixed";
    else if (b === "passed" && c !== "passed") change = "regressed";
    else change = c === "passed" ? "still-passing" : "still-failing";
    return { caseId, baseline: b, current: c, change, history, flips, ...(failureCode ? { failureCode } : {}) };
  });

  const count = (k: CaseChange) => cases.filter((x) => x.change === k).length;
  return { cases, summary: {
    fixed: count("fixed"), regressed: count("regressed"), flaky: count("flaky"),
    stillPassing: count("still-passing"), stillFailing: count("still-failing"),
    appeared: count("appeared"), disappeared: count("disappeared"),
    sameCodeRevision: !!baseline.codeRevision && baseline.codeRevision === current.codeRevision,
  } };
}

/** 一句人能读的话。界面和报告共用它，免得两处各写一遍口径。 */
export function describeComparison(s: ComparisonSummary): string {
  const bits = [`修好 ${s.fixed}`, `回归 ${s.regressed}`, `抖 ${s.flaky}`, `仍绿 ${s.stillPassing}`, `仍红 ${s.stillFailing}`];
  if (s.appeared) bits.push(`新增 ${s.appeared}`);
  if (s.disappeared) bits.push(`不再执行 ${s.disappeared}`);
  if (!s.sameCodeRevision) bits.push("注意：两次执行的编译版本不同，差异可能来自用例本身而不是产品");
  return bits.join(" · ");
}
