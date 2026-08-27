/**
 * Stage-two scoring: when the suite ran, did it judge correctly?
 *
 * Fail is the positive class. That is a deliberate choice, copied from the benchmark this
 * project follows: it makes a false alarm cost precision directly instead of being diluted
 * among a large pile of correct passes. In a suite where most things work, "accuracy" is
 * almost entirely a measure of how many passes you got right, which is the uninteresting
 * half.
 *
 * The other thing this reports is which way a version *leans*. The published result for
 * this task is that no model manages to be both precise and complete: they slide either
 * into crying wolf (~70% false alarms) or into silence (recall under 25%). Those two
 * failures need opposite fixes, and a single F1 hides which one you have.
 */

export interface DetectionCase {
  caseId: string;
  /** What the suite said. */
  predicted: "passed" | "failed";
  /** What is actually true of the product for this case. */
  actual: "passed" | "failed";
  /** Environmental failures are excluded: they are "no verdict", not a wrong verdict. */
  excluded?: boolean;
  excludeReason?: string;
}

export type Leaning = "false-alarms" | "silence" | "balanced" | "undetermined";

export interface DetectionResult {
  precision: number;
  recall: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  excluded: number;
  /** Which way this version fails, since the two failures want opposite remedies. */
  leaning: Leaning;
  falseAlarmRate: number;
}

const ratio = (a: number, b: number): number => (b ? Number((a / b).toFixed(3)) : 0);

export function scoreDetection(cases: DetectionCase[]): DetectionResult {
  const counted = cases.filter((c) => !c.excluded);
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;

  for (const c of counted) {
    if (c.predicted === "failed" && c.actual === "failed") tp += 1;
    else if (c.predicted === "failed" && c.actual === "passed") fp += 1;
    else if (c.predicted === "passed" && c.actual === "passed") tn += 1;
    else fn += 1;
  }

  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision + recall ? Number(((2 * precision * recall) / (precision + recall)).toFixed(3)) : 0;
  const falseAlarmRate = ratio(fp, tp + fp);

  // Thresholds taken from the shape of the published failure modes rather than invented:
  // roughly two-thirds false alarms on one side, roughly a quarter recall on the other.
  const leaning: Leaning =
    tp + fp + fn === 0
      ? "undetermined"
      : falseAlarmRate >= 0.5 && recall >= 0.5
        ? "false-alarms"
        : recall < 0.5 && falseAlarmRate < 0.5
          ? "silence"
          : falseAlarmRate >= 0.5
            ? "false-alarms"
            : "balanced";

  return {
    precision,
    recall,
    f1,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    excluded: cases.length - counted.length,
    leaning,
    falseAlarmRate,
  };
}

/** A one-line reading of the result, for a report a person will actually read. */
export function describeLeaning(r: DetectionResult): string {
  if (r.leaning === "undetermined") return "nothing was judged either way";
  if (r.leaning === "false-alarms")
    return `cries wolf: ${Math.round(r.falseAlarmRate * 100)}% of the failures it reported were not real`;
  if (r.leaning === "silence")
    return `stays silent: it found ${Math.round(r.recall * 100)}% of the real failures`;
  return "balanced between false alarms and misses";
}
