/**
 * Coverage against a human-written gold checklist.
 *
 * This is the first number of the two-stage score: how much of what *should* have been
 * thought of actually was. The published benchmark for this task reports coverage
 * consistently below 70% — i.e. a third of the gold items are never even imagined — which
 * is why decomposition gets measured separately from judging.
 *
 * Matching is deterministic keyword rules, not a model. That buys reproducibility (the
 * same run scores the same twice, so a paired comparison means something) and costs
 * recall on wording the checklist did not anticipate. The alternative — asking a model to
 * align predictions with gold — puts a layer of model error inside the measurement itself.
 */

export interface GoldMatch {
  /** Case title + steps must contain at least one of these. */
  anyOf?: string[];
  /** …and all of these. */
  allOf?: string[];
  /** The case's assertion must contain at least one of these. */
  assertAnyOf?: string[];
}

export interface GoldItem {
  id: string;
  title: string;
  story?: string;
  designMethod?: string;
  expectTier?: number;
  /** Never used for tuning; scored separately so improvements cannot be fitted to it. */
  heldOut?: boolean;
  match: GoldMatch;
}

export interface GoldChecklist {
  id: string;
  items: GoldItem[];
  outOfScope?: string[];
}

export interface CandidateCase {
  id?: string;
  title: string;
  steps: string[];
  expected: string;
}

export interface CoverageHit {
  goldId: string;
  by: string[];
}

export interface CoverageResult {
  /** Covered gold items ÷ all gold items, tuning set only. */
  coverage: number;
  hits: CoverageHit[];
  misses: GoldItem[];
  /** Cases that matched no gold item: either genuinely new, or out of scope. */
  extras: CandidateCase[];
  /** The held-out slice, scored on its own so a rising number cannot be fitted. */
  heldOut: { coverage: number; hits: string[]; misses: string[] };
  totals: { gold: number; heldOut: number; cases: number };
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

const caseText = (c: CandidateCase): string => norm([c.title, ...c.steps].join(" "));

function matches(item: GoldItem, c: CandidateCase): boolean {
  const body = caseText(c);
  const assertion = norm(c.expected ?? "");
  const { anyOf, allOf, assertAnyOf } = item.match;
  // Every clause that is present must hold: a case about the right thing that asserts
  // nothing relevant has not covered the item, it has only mentioned it.
  if (anyOf?.length && !anyOf.some((k) => body.includes(norm(k)))) return false;
  if (allOf?.length && !allOf.every((k) => body.includes(norm(k)))) return false;
  if (assertAnyOf?.length && !assertAnyOf.some((k) => assertion.includes(norm(k)))) return false;
  return Boolean(anyOf?.length || allOf?.length || assertAnyOf?.length);
}

export function scoreCoverage(gold: GoldChecklist, cases: CandidateCase[]): CoverageResult {
  const label = (c: CandidateCase, i: number): string => c.id ?? c.title ?? `case-${i}`;

  const hits: CoverageHit[] = [];
  const misses: GoldItem[] = [];
  const covered = new Set<string>();
  const usedCases = new Set<string>();

  for (const item of gold.items) {
    const by = cases.filter((c) => matches(item, c)).map((c, i) => label(c, i));
    if (by.length) {
      hits.push({ goldId: item.id, by });
      covered.add(item.id);
      for (const b of by) usedCases.add(b);
    } else {
      misses.push(item);
    }
  }

  const extras = cases.filter((c, i) => !usedCases.has(label(c, i)));
  const tuning = gold.items.filter((i) => !i.heldOut);
  const held = gold.items.filter((i) => i.heldOut);

  return {
    coverage: tuning.length ? tuning.filter((i) => covered.has(i.id)).length / tuning.length : 0,
    hits,
    misses,
    extras,
    heldOut: {
      coverage: held.length ? held.filter((i) => covered.has(i.id)).length / held.length : 0,
      hits: held.filter((i) => covered.has(i.id)).map((i) => i.id),
      misses: held.filter((i) => !covered.has(i.id)).map((i) => i.id),
    },
    totals: { gold: tuning.length, heldOut: held.length, cases: cases.length },
  };
}

/**
 * Which design methods the produced suite actually used, against what the checklist
 * expected. A suite that is all happy-path scores badly here even when coverage looks fine.
 */
export function methodMix(gold: GoldChecklist, result: CoverageResult): Record<string, { expected: number; covered: number }> {
  const mix: Record<string, { expected: number; covered: number }> = {};
  const covered = new Set(result.hits.map((h) => h.goldId));
  for (const item of gold.items) {
    const key = item.designMethod ?? "unspecified";
    mix[key] ??= { expected: 0, covered: 0 };
    mix[key].expected += 1;
    if (covered.has(item.id)) mix[key].covered += 1;
  }
  return mix;
}
