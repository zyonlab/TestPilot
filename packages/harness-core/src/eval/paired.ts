/**
 * Comparing two versions on the same set of items.
 *
 * Paired, not split into two groups: the variation between items is much larger than the
 * effect any harness change has, so two random halves already differ before anything is
 * changed. Running both versions over every item and subtracting cancels that out.
 *
 * (The name for this is a within-subject design. It is not a randomised controlled trial —
 * in an RCT each subject sees one arm; here every item sees both.)
 */

export interface PairedBinary {
  id: string;
  a: boolean;
  b: boolean;
}

export interface McNemarResult {
  /** Items where A succeeded and B did not. */
  aOnly: number;
  /** …and the other way round. */
  bOnly: number;
  bothPassed: number;
  bothFailed: number;
  /** Two-sided exact binomial p-value on the disagreements. */
  p: number;
  /** Plain-language reading, because a p-value alone gets misread. */
  reading: string;
}

/**
 * McNemar's test, exact rather than the chi-squared approximation.
 *
 * Only the items the two versions *disagree* on carry information: an item both got right
 * says the item was easy, not that the versions are alike. With twenty items — a realistic
 * batch here — the chi-squared approximation's assumptions do not hold, so the exact
 * binomial is used instead.
 */
export function mcnemar(pairs: PairedBinary[]): McNemarResult {
  const aOnly = pairs.filter((p) => p.a && !p.b).length;
  const bOnly = pairs.filter((p) => !p.a && p.b).length;
  const bothPassed = pairs.filter((p) => p.a && p.b).length;
  const bothFailed = pairs.filter((p) => !p.a && !p.b).length;
  const n = aOnly + bOnly;

  if (n === 0)
    return {
      aOnly,
      bOnly,
      bothPassed,
      bothFailed,
      p: 1,
      reading: "the two versions agreed on every item — there is nothing to compare",
    };

  const k = Math.min(aOnly, bOnly);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += choose(n, i);
  const p = Math.min(1, (2 * tail) / 2 ** n);

  const better = bOnly > aOnly ? "B" : aOnly > bOnly ? "A" : "neither";
  const reading =
    better === "neither"
      ? `${n} items disagreed, evenly split — no direction`
      : p < 0.05
        ? `${better} is better on ${n} disagreeing items (p = ${p.toFixed(3)})`
        : `${better} looks better on ${n} disagreeing items, but the difference could easily be chance (p = ${p.toFixed(3)})`;

  return { aOnly, bOnly, bothPassed, bothFailed, p: Number(p.toFixed(4)), reading };
}

function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

export interface PairedNumeric {
  id: string;
  a: number;
  b: number;
}

export interface NumericComparison {
  n: number;
  meanA: number;
  meanB: number;
  meanDelta: number;
  /** How many items moved in each direction, which a mean can hide entirely. */
  improved: number;
  worsened: number;
  unchanged: number;
}

/**
 * Paired numbers (coverage, cost, duration). Reported with the direction counts, because
 * a mean that improved while most items got worse is a real and common shape — the
 * published domain-tuning result this project cites moved +0.0098 overall while several of
 * its batches went backwards.
 */
export function comparePaired(pairs: PairedNumeric[]): NumericComparison {
  const n = pairs.length;
  const sum = (f: (p: PairedNumeric) => number) => pairs.reduce((t, p) => t + f(p), 0);
  const mean = (f: (p: PairedNumeric) => number) => (n ? Number((sum(f) / n).toFixed(4)) : 0);
  return {
    n,
    meanA: mean((p) => p.a),
    meanB: mean((p) => p.b),
    meanDelta: mean((p) => p.b - p.a),
    improved: pairs.filter((p) => p.b > p.a).length,
    worsened: pairs.filter((p) => p.b < p.a).length,
    unchanged: pairs.filter((p) => p.b === p.a).length,
  };
}
