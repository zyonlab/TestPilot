/**
 * The components that can be switched off.
 *
 * A component nobody can disable is a component nobody can prove. This list is the only
 * place that answers "what is provable in this harness", and every entry has to be
 * something a node actually reads — a switch that changes nothing would make the ablation
 * report a lie.
 */
export const ABLATABLE = {
  /** design.cases stops naming the design methods; it just asks for test cases. */
  designMethods: "design-methods",
  /** gate.textcase stops grading assertion hardness and stops flagging vague ones. */
  oracleGrading: "oracle-grading",
  /** gate.textcase stops de-duplicating by key. */
  dedupe: "dedupe",
  /** codegen stops lifting shared prologues into fragments. */
  fragments: "fragments",
  /** repair.loop executes but never tries to fix. */
  repair: "repair",
} as const;

export type Ablatable = (typeof ABLATABLE)[keyof typeof ABLATABLE];

export const ALL_ABLATABLE: Ablatable[] = Object.values(ABLATABLE);

/** Parse an `ABLATE=a,b` style list, rejecting names that no node reads. */
export function parseAblation(input: string | string[] | undefined): {
  on: Ablatable[];
  unknown: string[];
} {
  const raw = (Array.isArray(input) ? input : (input ?? "").split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  const on = raw.filter((r): r is Ablatable => (ALL_ABLATABLE as string[]).includes(r));
  return { on, unknown: raw.filter((r) => !(ALL_ABLATABLE as string[]).includes(r)) };
}
