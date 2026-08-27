import type { ModelClient } from "../model/client.js";
import type { CandidateCase, CoverageResult, GoldChecklist, GoldItem } from "./coverage.js";

/**
 * Semantic adjudication of the items keyword matching missed.
 *
 * Why this is a *second* number and not a replacement: the primary coverage figure has to
 * be reproducible, because paired comparison between two versions is the whole point of
 * having it — and a model in the middle of the measurement makes the same run score
 * differently twice. So the deterministic pass stays the headline, and this runs only over
 * what it missed.
 *
 * Why it exists at all: the deterministic pass under-reads. Observed on a real batch — a
 * case asserting «不显示文案 "Invalid username or password"» was scored as missing a gold
 * item phrased «不显示错误». Reporting that as a gap is a lie of a different kind.
 *
 * The trade this makes explicit: `coverage` is a lower bound you can compare across runs,
 * `semanticCoverage` is a better estimate you cannot. Both are printed, always labelled.
 */

export interface SemanticMatch {
  goldId: string;
  caseId: string;
  reason: string;
}

export interface SemanticCoverage {
  /** Coverage after the adjudicated matches are added. Model-assisted: not comparable. */
  coverage: number;
  heldOutCoverage: number;
  matched: SemanticMatch[];
  /** Still missing after adjudication — these are real gaps. */
  stillMissing: string[];
  /** Model calls spent, so the cost of measuring stays visible. */
  calls: number;
  tokens: number;
}

const STABLE = [
  "You decide whether a test case covers a checklist item.",
  "",
  "Cover means: running that case would exercise the behaviour the item describes AND its",
  "assertion would catch the item's failure. Mentioning the same feature is not covering it.",
  "Different wording for the same behaviour IS covering it.",
  "",
  'Return JSON only: {"covered": true|false, "caseIndex": <index or -1>, "reason": "<one short line>"}',
].join("\n");

function variable(item: GoldItem, cases: CandidateCase[]): string {
  return [
    `CHECKLIST ITEM: ${item.title}`,
    item.designMethod ? `DESIGN METHOD: ${item.designMethod}` : "",
    "",
    "CANDIDATE CASES:",
    ...cases.map((c, i) => `[${i}] ${c.title}\n    steps: ${c.steps.join(" / ")}\n    asserts: ${c.expected}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Adjudicate the misses. Only the misses: asking about items the keywords already matched
 * would spend model time to confirm what is already known, and would let the model *remove*
 * a match, which would make the primary number depend on it after all.
 */
export async function adjudicateMisses(
  gold: GoldChecklist,
  cases: CandidateCase[],
  deterministic: CoverageResult,
  model: ModelClient,
  opts: { maxCandidates?: number } = {},
): Promise<SemanticCoverage> {
  const maxCandidates = opts.maxCandidates ?? 40;
  const shortlist = cases.slice(0, maxCandidates);
  const matched: SemanticMatch[] = [];
  const stillMissing: string[] = [];
  let calls = 0;
  let tokens = 0;

  for (const item of deterministic.misses) {
    if (!shortlist.length) {
      stillMissing.push(item.id);
      continue;
    }
    try {
      const res = await model.chat({
        stable: STABLE,
        variable: variable(item, shortlist),
        maxTokens: 200,
        label: `coverage-adjudicate:${item.id}`,
      });
      calls += 1;
      tokens += res.tokens;
      const parsed = JSON.parse(res.text.replace(/```[a-z]*\n?/gi, "").match(/\{[\s\S]*\}/)?.[0] ?? "{}") as {
        covered?: boolean;
        caseIndex?: number;
        reason?: string;
      };
      const kase = shortlist[parsed.caseIndex ?? -1];
      if (parsed.covered && kase)
        matched.push({
          goldId: item.id,
          caseId: kase.id ?? kase.title,
          reason: String(parsed.reason ?? "").slice(0, 160),
        });
      else stillMissing.push(item.id);
    } catch {
      // An adjudication that fails leaves the item missing: the safe direction is to keep
      // reporting a gap rather than to invent coverage.
      stillMissing.push(item.id);
    }
  }

  const byId = new Map(gold.items.map((i) => [i.id, i]));
  const tuning = gold.items.filter((i) => !i.heldOut);
  const held = gold.items.filter((i) => i.heldOut);
  const covered = new Set([...deterministic.hits.map((h) => h.goldId), ...matched.map((m) => m.goldId)]);

  return {
    coverage: tuning.length ? Number((tuning.filter((i) => covered.has(i.id)).length / tuning.length).toFixed(3)) : 0,
    heldOutCoverage: held.length
      ? Number((held.filter((i) => covered.has(i.id)).length / held.length).toFixed(3))
      : 0,
    matched: matched.filter((m) => byId.has(m.goldId)),
    stillMissing,
    calls,
    tokens,
  };
}
