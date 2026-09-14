import { createHash } from "node:crypto";
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
  /**
   * 预算：判了几条、上限是多少、是不是因为预算停的。
   *
   * 借 commerce-agents 的 analysis delegate：一个藏在工具后面的模型调用要有行数 / 墙钟 /
   * 调用次数的硬顶，超了就停，**停下来的事实要报出来**，而不是让一个跑了一半的结果
   * 看起来像跑完的。
   */
  budget?: { calls: number; maxCalls: number; elapsedMs: number; timeoutMs: number; stopped: "none" | "calls" | "timeout" };
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

/**
 * 判官口径的指纹：`STABLE` 提示词的 sha256 前 16 位（见文件末尾的 `judgePromptDigest`）。
 *
 * 借 commerce-agents 的 `commerce-evals`：judge 的模型或 rubric 一改，存量 verdict 全部失效，
 * 所以录制结果要带上模型 + rubric 的指纹。语义覆盖是「模型判的」那一栏，这个数和判官模型名
 * 一起进 `ScoreboardEntry.semantic.judge`；两条条目的 judge 不同，它们的 semantic 不可比。
 */
const STABLE = [
  "You decide whether a test case covers a checklist item.",
  "",
  "Cover means: running that case would exercise the behaviour the item describes AND its",
  "assertion would catch the item's failure. Mentioning the same feature is not covering it.",
  "Different wording for the same behaviour IS covering it.",
  "",
  // 口径（2026-09-04 钉死）。κ=0.235 的复盘：判官系统性比人严，分歧集中在下面这几条。
  // 写进 STABLE 而不是留给模型自己判，是因为口径是校准的对象——它变了，promptDigest 变，
  // 旧的 κ 与语义栏就不再可比，这正是我们想要的：口径的每次变动都被看见。
  "Rulings that settle the usual disagreements:",
  "- Reaching the screen or tab where the behaviour lives, without asserting anything the",
  "  item names, is NOT covering it (switching to a tab is not viewing its contents).",
  "- A case whose assertion names the item's literal text, number, or state IS covering it,",
  "  even when its steps reach that state by a different route than the item implies.",
  "- A negative item (a refusal, a validation message) is covered only by a case that",
  "  asserts the refusal itself; a happy-path case through the same form does not cover it.",
  "- When the case's assertion is vague (\"works\", \"correct\", \"as expected\"), it covers",
  "  nothing, whatever its title says.",
  "- Decide from the case's steps and assertion only. Do not infer what the author",
  "  probably meant, and do not reward a case for being thorough about something else.",
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
  opts: { maxCandidates?: number; maxCalls?: number; timeoutMs?: number } = {},
): Promise<SemanticCoverage> {
  const maxCandidates = opts.maxCandidates ?? 40;
  // 判官是一个 delegate：只拿 brief（清单项 + 候选用例），只回一个 schema 化的判决，
  // 有调用次数与墙钟两道预算。它看到的东西不进任何写路径——这里没有写路径可进。
  const maxCalls = opts.maxCalls ?? 60;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const started = Date.now();
  let stopped: "none" | "calls" | "timeout" = "none";
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
    if (calls >= maxCalls) stopped = "calls";
    else if (Date.now() - started > timeoutMs) stopped = "timeout";
    if (stopped !== "none") {
      // 预算用完：剩下的一律记 missing。少报覆盖比多报安全，而且 budget 会说出停在了哪。
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
    budget: { calls, maxCalls, elapsedMs: Date.now() - started, timeoutMs, stopped },
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

/** `STABLE` 的 sha256 前 16 位：判官口径的指纹。 */
export function judgePromptDigest(): string {
  return createHash("sha256").update(STABLE).digest("hex").slice(0, 16);
}
