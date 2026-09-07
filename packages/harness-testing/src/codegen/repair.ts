import type { Action, CodeCase, ExecOutcome, RepairChange } from "./types.js";

/**
 * Telling an honest fix from a fix that just made the report green.
 *
 * A repair loop optimises whatever it is told to optimise, and "make the test pass" has a
 * shortest path that does not involve fixing anything: weaken the assertion, or delete the
 * case. In the published study of an autonomous repair system, that shortest path was
 * taken often enough to move the reported convergence rate from 70% to 50% once it was
 * discounted. This project does not gate on human approval, so the only defence left is to
 * *measure* it — which requires knowing what each round actually changed.
 */

const literals = (s: string): string[] => [...s.matchAll(/[「『"'`“”]([^」』"'`“”]{2,})[」』"'`“”]/g)].map((m) => m[1]);

const assertionsOf = (actions: Action[]): string[] => actions.filter((a) => a.kind === "assert").map((a) => a.text);

/**
 * Did the assertion get weaker? Three signals, deliberately generous — a false alarm here
 * costs a line in a report, a miss costs the report its meaning:
 *   the assertion disappeared;
 *   a quoted literal it used to check disappeared;
 *   it lost a third of its length (a specific claim replaced by a vague one).
 */
export function assertionWeakened(before: Action[], after: Action[]): boolean {
  const b = assertionsOf(before);
  const a = assertionsOf(after);
  if (b.length && !a.length) return true;
  if (a.length < b.length) return true;
  for (const [i, prev] of b.entries()) {
    const next = a[i];
    if (next === undefined) return true;
    const lostLiteral = literals(prev).some((lit) => !next.includes(lit));
    if (lostLiteral) return true;
    if (next.trim().length < prev.trim().length * 0.67) return true;
  }
  return false;
}

const WAIT = /wait|等待|until|直到/i;

export function classifyRepair(before: CodeCase | undefined, after: CodeCase | undefined): RepairChange[] {
  if (before && !after) return ["case-removed"];
  if (!before || !after) return ["none"];

  const changes: RepairChange[] = [];
  if (assertionWeakened(before.actions, after.actions)) changes.push("assertion-semantics");

  const beforeSteps = before.actions.filter((x) => x.kind !== "assert");
  const afterSteps = after.actions.filter((x) => x.kind !== "assert");
  const addedWaits = afterSteps.filter((s) => WAIT.test(s.text)).length - beforeSteps.filter((s) => WAIT.test(s.text)).length;
  if (addedWaits > 0) changes.push("waiting");
  if (afterSteps.length !== beforeSteps.length) changes.push("structure");
  else if (afterSteps.some((s, i) => s.text !== beforeSteps[i]?.text)) changes.push("selector-wording");

  return changes.length ? changes : ["none"];
}

export interface RepairTally {
  loosePassRate: number;
  strictPassRate: number;
  degraded: string[];
}

/**
 * The two rates, side by side.
 *
 * Loose counts every green. Strict discounts the ones that only went green after their
 * assertion was weakened or after the case disappeared. Publishing only the first is the
 * failure mode this whole mechanism exists to prevent.
 */
export function tally(outcomes: ExecOutcome[], degradedIds: Iterable<string>): RepairTally {
  const degraded = [...new Set(degradedIds)];
  const total = outcomes.length;
  const passed = outcomes.filter((o) => o.status === "passed");
  const honest = passed.filter((o) => !degraded.includes(o.caseId));
  return {
    loosePassRate: total ? Number((passed.length / total).toFixed(3)) : 0,
    strictPassRate: total ? Number((honest.length / total).toFixed(3)) : 0,
    degraded,
  };
}

/**
 * Should the loop keep going?
 *
 * Two limits, because one is not enough: a cap on rounds, and a cap on rounds that changed
 * nothing. In the case study behind this design, a repair loop ran to its 16-round ceiling
 * over a hundred times and produced no artefact at all — the ceiling existed, the progress
 * check did not.
 */
export function shouldContinue(opts: {
  round: number;
  maxRounds: number;
  roundsWithoutProgress: number;
  maxWithoutProgress: number;
  lastFailKind?: ExecOutcome["failKind"];
}): { go: boolean; because: string; reason?: RepairStopReason; n?: number } {
  /*
   * 两样一起返回：`because` 是给日志和 CLI 读的一句英文，`reason` 是给界面本地化用的码。
   *
   * 只给英文句子的后果是它会原样出现在中文和日文界面上——和 readiness 那条
   * 服务端拼中文的毛病是同一类，只是方向反了。而只给码又会让 CLI 的输出变成
   * 一串 `no-progress`，那对着终端看日志的人反而更差。所以两样都给。
   */
  if (opts.round >= opts.maxRounds)
    return { go: false, because: `hit the ${opts.maxRounds}-round limit`, reason: "round-limit", n: opts.maxRounds };
  if (opts.roundsWithoutProgress >= opts.maxWithoutProgress)
    return {
      go: false,
      because: `${opts.roundsWithoutProgress} rounds changed nothing`,
      reason: "no-progress",
      n: opts.roundsWithoutProgress,
    };
  if (opts.lastFailKind === "infra")
    // Retrying a broken environment burns the budget without ever addressing the fault,
    // and it would file an environment outage as a product defect.
    return { go: false, because: "the failure was environmental, not the test's", reason: "infra" };
  return { go: true, because: "" };
}

/** 为什么停下。`because` 那句英文的机器可读版本，界面拿它去查词条。 */
export type RepairStopReason = "round-limit" | "no-progress" | "infra";
