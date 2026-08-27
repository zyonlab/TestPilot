import { z } from "zod";
import type { ModelClient } from "@testpilot/harness-core";

/**
 * The harness critic.
 *
 * It reads what went wrong and proposes changes to the *harness* — a prompt, a gate rule, a
 * parameter — rather than to any individual case. This is the one part of the
 * harness-and-weights co-evolution loop that can be cashed today: it needs failure traces,
 * which exist, and not fine-tuning, which does not.
 *
 * The rule that makes it safe: **the critic proposes, the paired evaluation decides.** A
 * model asked to judge its own suggestion will praise it — the failure mode is documented
 * and this project has no human approval step to fall back on, so a suggestion that cannot
 * be expressed as a runnable A/B is marked as such instead of being quietly adopted.
 */

export const SuggestionSchema = z.object({
  title: z.string().min(1),
  /** Which part of the harness to change. */
  target: z.enum(["prompt", "gate-rule", "node-param", "graph", "fixture", "other"]),
  /** What to change, concretely enough to act on. */
  change: z.string().min(1),
  /** The evidence this rests on — counts and examples, not impressions. */
  evidence: z.string().min(1),
  /** How it could be proven: an ablation switch, or a parameter to compare. */
  test: z
    .object({
      kind: z.enum(["ablation", "param", "manual"]),
      /** For ablation: the switch name. For param: "node.param=value". */
      handle: z.string().optional(),
    })
    .default({ kind: "manual" }),
  expectedEffect: z.string().default(""),
  /**
   * Set when a proposal breaks one of the standing rules — it is kept and shown, not
   * dropped. A suggestion that had to be refused is evidence about the critic.
   */
  inadmissible: z.string().optional(),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

export interface CritiqueEvidence {
  runs: number;
  /** Gate findings by rule, most frequent first. */
  gateFindings: Array<{ rule: string; count: number; examples: string[] }>;
  /** Execution failures by attribution — infra failures are not the harness's fault. */
  failures: { infra: number; locate: number; assert: number };
  /** Cases whose assertion was weakened or which disappeared during repair. */
  degraded: string[];
  /** Gold items nothing covered, which is a decomposition problem, not a judging one. */
  coverageMisses: string[];
  /** What repair rounds actually changed. */
  repairChanges: Record<string, number>;
  /** Cost, so a suggestion can be weighed against what it would cost to adopt. */
  spend: { calls: number; tokens: number };
}

const STABLE = [
  "You review an automated test-generation harness and propose improvements to the HARNESS,",
  "not to individual test cases.",
  "",
  "You will be given aggregated evidence from recent runs: gate findings by rule, failures",
  "split by attribution, cases whose assertions were weakened during repair, uncovered",
  "checklist items, and cost.",
  "",
  "Rules:",
  "- Propose at most 4 changes, ordered by how much evidence supports them.",
  "- Every proposal must cite the specific numbers it rests on. No impressions.",
  "- `infra` failures are environment problems. Never propose harness changes for those.",
  "- Checklist items nothing covered are a DECOMPOSITION problem, not a judging one: the",
  "  gates only ever see cases that exist. Propose changes to story planning or case design",
  "  for those, never to a gate rule — tightening a gate cannot invent a missing case.",
  "- Prefer a change that can be PROVEN: name an ablation switch to compare against, or a",
  "  node parameter to vary. If a proposal cannot be tested that way, say so honestly with",
  '  kind "manual" — an untestable claim presented as testable is worse than no proposal.',
  "- Do not propose weakening a gate to make numbers look better. The gates exist because",
  "  a suite that reports green while asserting nothing is the failure this system guards against.",
  "- Never propose putting the checklist, or any item of it, into a prompt. The checklist is",
  "  the measuring instrument; a harness that has been shown it stops measuring anything and",
  "  starts reciting. Propose changes to how the source material is read instead.",
  "",
  'Return JSON only: {"suggestions":[{"title":"...","target":"prompt","change":"...",',
  '"evidence":"...","test":{"kind":"ablation","handle":"design-methods"},"expectedEffect":"..."}]}',
].join("\n");

function variable(e: CritiqueEvidence): string {
  return [
    `RUNS ANALYSED: ${e.runs}`,
    "",
    "GATE FINDINGS (rule × count):",
    ...e.gateFindings.map((f) => `- ${f.rule}: ${f.count}${f.examples[0] ? ` e.g. "${f.examples[0].slice(0, 120)}"` : ""}`),
    "",
    `EXECUTION FAILURES: infra ${e.failures.infra}, locate ${e.failures.locate}, assert ${e.failures.assert}`,
    `ASSERTIONS WEAKENED DURING REPAIR: ${e.degraded.length ? e.degraded.join(", ") : "none"}`,
    `REPAIR CHANGES: ${Object.entries(e.repairChanges).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
    "",
    `CHECKLIST ITEMS NOTHING COVERED: ${e.coverageMisses.join(", ") || "none"}`,
    `COST: ${e.spend.calls} model calls, ${e.spend.tokens} tokens`,
  ].join("\n");
}

/**
 * Fold raw run material into the aggregate the critic reasons over.
 *
 * Aggregated rather than raw on purpose: handing a model twenty full traces invites it to
 * fix the last thing it read. Counts make the frequent problems the visible ones.
 */
export function collectEvidence(input: {
  gateFindings?: Array<{ rule: string; message: string; severity?: string }>;
  outcomes?: Array<{ failKind?: string; status: string }>;
  degraded?: string[];
  repairRounds?: Array<{ changes: string[] }>;
  coverageMisses?: string[];
  spend?: { calls?: number; tokens?: number };
  runs?: number;
}): CritiqueEvidence {
  const byRule = new Map<string, { count: number; examples: string[] }>();
  for (const f of input.gateFindings ?? []) {
    const hit = byRule.get(f.rule) ?? { count: 0, examples: [] };
    hit.count += 1;
    if (hit.examples.length < 2) hit.examples.push(f.message);
    byRule.set(f.rule, hit);
  }

  const failures = { infra: 0, locate: 0, assert: 0 };
  for (const o of input.outcomes ?? []) {
    if (o.status !== "failed") continue;
    const kind = (o.failKind ?? "assert") as keyof typeof failures;
    if (kind in failures) failures[kind] += 1;
  }

  const repairChanges: Record<string, number> = {};
  for (const r of input.repairRounds ?? [])
    for (const c of r.changes) repairChanges[c] = (repairChanges[c] ?? 0) + 1;

  return {
    runs: input.runs ?? 1,
    gateFindings: [...byRule.entries()]
      .map(([rule, v]) => ({ rule, count: v.count, examples: v.examples }))
      .sort((a, b) => b.count - a.count),
    failures,
    degraded: input.degraded ?? [],
    coverageMisses: input.coverageMisses ?? [],
    repairChanges,
    spend: { calls: input.spend?.calls ?? 0, tokens: input.spend?.tokens ?? 0 },
  };
}

export interface Critique {
  suggestions: Suggestion[];
  evidence: CritiqueEvidence;
  /** Suggestions that name a switch or parameter can be settled by a paired evaluation. */
  testable: number;
  spend: { calls: number; tokens: number };
}

/**
 * Did the proposal quote a checklist item back at us?
 *
 * Compared on a normalised, punctuation-free form: the interesting case is a paraphrase
 * close enough to be a recitation, not a byte-for-byte copy.
 */
function recitedChecklistItem(change: string, misses: string[]): string | undefined {
  const norm = (t: string) => t.replace(/[\s"'“”「」『』（）()·,.，。:：;；]/g, "").toLowerCase();
  const hay = norm(change);
  for (const miss of misses) {
    const needle = norm(miss);
    // Short ids ("S-03") are references, not recitations; only real text counts.
    if (needle.length >= 8 && hay.includes(needle)) return miss;
  }
  return undefined;
}

export async function critique(
  evidence: CritiqueEvidence,
  model: ModelClient,
  opts: { ablatable?: string[] } = {},
): Promise<Critique> {
  const res = await model.chat({
    stable: opts.ablatable?.length
      ? `${STABLE}\n\nAVAILABLE ABLATION SWITCHES: ${opts.ablatable.join(", ")}`
      : STABLE,
    variable: variable(evidence),
    maxTokens: 1500,
    label: "harness-critic",
  });

  const cleaned = res.text.replace(/```[a-z]*\n?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("harness-critic: no JSON object in the reply");
  const parsed = z
    .object({ suggestions: z.array(SuggestionSchema) })
    .safeParse(JSON.parse(cleaned.slice(start, end + 1)));
  if (!parsed.success) throw new Error(`harness-critic: ${parsed.error.issues[0]?.message ?? "bad shape"}`);

  const suggestions = parsed.data.suggestions.map((s) => {
    // The checklist ban, enforced on the output rather than only stated in the prompt.
    // It was stated, and the critic crossed it anyway — quoting two uncovered items inside
    // the change it proposed. An instruction nothing checks is the failure mode this
    // project keeps rediscovering: the gate is what makes a rule real.
    const recited = recitedChecklistItem(s.change, evidence.coverageMisses);
    const marked = recited
      ? {
          ...s,
          inadmissible: `it puts a checklist item into a prompt ("${recited.slice(0, 40)}…") — the checklist is the measuring instrument, and a harness shown it stops measuring and starts reciting`,
        }
      : s;
    // A switch the harness does not have cannot be compared; downgrading beats pretending.
    if (marked.test.kind === "ablation" && opts.ablatable && !opts.ablatable.includes(marked.test.handle ?? ""))
      return { ...marked, test: { kind: "manual" as const }, expectedEffect: `${marked.expectedEffect} (no such ablation switch: ${marked.test.handle})` };
    return marked;
  });

  return {
    suggestions,
    evidence,
    // An inadmissible proposal is not something a paired evaluation should be spent on.
    testable: suggestions.filter((s) => s.test.kind !== "manual" && !s.inadmissible).length,
    spend: { calls: 1, tokens: res.tokens },
  };
}
