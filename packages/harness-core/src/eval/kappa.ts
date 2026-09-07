/**
 * Cohen's κ for a binary judge against human labels.
 *
 * One implementation, used by both `calibrate_judge` (the MCP tool) and the audit desk's
 * calibration endpoint. They must agree to the digit: a κ the desk shows and a κ the tool
 * reports are the same measurement of the same judge, or the number means nothing.
 *
 * Raw agreement overstates a judge by 33–41 points (docs/v3/00-架构.md §5), so `kappa` is
 * the headline and `agreement` is reported only for context.
 *
 * `pe === 1` leaves κ undefined in the textbook sense: both sides put every item in the same
 * class, so the chance agreement is already 100 % and the denominator is zero. We report 0,
 * not 1 — a label set with a single answer has no discriminating power, and calling that
 * "perfect agreement" praises a judge nothing has tested.
 *
 * No minimum `n` is enforced here. Whether a κ over six pairs is worth showing is a display
 * decision that belongs to the caller; the statistic itself is well-defined for any n ≥ 1.
 */
export interface KappaResult {
  kappa: number;
  agreement: number;
  n: number;
  confusion: { bothYes: number; bothNo: number; judgeOnly: number; humanOnly: number };
}

export function cohensKappa(pairs: Array<{ judge: boolean; human: boolean }>): KappaResult {
  const n = pairs.length;
  const d = n || 1;
  const bothYes = pairs.filter((p) => p.judge && p.human).length;
  const bothNo = pairs.filter((p) => !p.judge && !p.human).length;
  const judgeOnly = pairs.filter((p) => p.judge && !p.human).length;
  const humanOnly = pairs.filter((p) => !p.judge && p.human).length;

  const po = (bothYes + bothNo) / d;
  const pJudgeYes = (bothYes + judgeOnly) / d;
  const pHumanYes = (bothYes + humanOnly) / d;
  const pe = pJudgeYes * pHumanYes + (1 - pJudgeYes) * (1 - pHumanYes);
  const kappa = 1 - pe === 0 ? 0 : (po - pe) / (1 - pe);
  return {
    kappa: Number(kappa.toFixed(3)),
    agreement: Number(po.toFixed(3)),
    n,
    confusion: { bothYes, bothNo, judgeOnly, humanOnly },
  };
}
