import type { Mutant } from "./operators.js";

/**
 * 变异得分：这套用例集抓住了多少人造缺陷。
 *
 * ## 「杀掉」的定义要小心
 *
 * 不是「有用例失败了」，而是**「造成了干净跑时没有的失败」**。
 *
 * 干净跑（PetClinic，38 条）本来就有 3 条失败：两条基础设施问题、一条真实的断言不符。
 * 拿「失败数 > 0」当杀掉，那 3 条会把每一个变异体都算成被杀——**得分变成 100%，
 * 而它什么都没量**。所以要跟干净跑逐条比对，只认**新增的**失败。
 *
 * ## 四分类，不是两分类
 *
 * | | 含义 | 说明什么 |
 * |---|---|---|
 * | killed       | 造成了新的失败 | 用例集抓住了这个缺陷 |
 * | survived     | 变异体生效了，全套用例都跑完了，没有新失败 | **用例集对这个缺陷是瞎的** |
 * | inconclusive | 没有新失败，但有用例这一轮根本没跑成 | **不知道**——不能算进得分 |
 * | notApplied   | 变异体一处都没改到 | **工具的问题，不是用例集的问题** |
 *
 * 后两类都必须单列。把它们混进 survived，等于把工具自己的失败伪装成用例集的盲区——
 * 而那种记录看起来像真发现：「产品这里坏了没人管」，实际上产品根本没坏过。
 *
 * ## 基础设施失败要剔除，剔除之后还要记得「不知道」
 *
 * 一次模型超时造成的新失败，不是用例集抓住了缺陷。`failKind === "infra"` 的新失败不计。
 * 否则模型越不稳，变异得分越高——一个会奖励基础设施故障的指标是坏指标。
 *
 * 但只做到「不计」还不够。剔掉之后剩下零个新失败时，有两种截然不同的情形：
 *
 *   a. 全套用例都跑完了，没一条叫——**盲区**，这是真结果；
 *   b. 本来可能叫的那条用例自己挂了——**没测到**，这什么都不是。
 *
 * 2026-08-29 那次 216 次执行的跑就栽在这里：跑到一半 `qwen3.8-27b:free` 从服务商目录下架，
 * 18 个变异体里 9 个轮次撞上 404，而当时的代码把它们一律记成 survived，
 * 于是得出「改文案和藏控件全都抓不到」——一个看起来很有分量、其实是模型下架造成的结论。
 * 所以 b 单列成 inconclusive，且**不进分母**：宁可说不知道，也不要报一个假的盲区。
 */

export interface CaseOutcome {
  caseId: string;
  status: "passed" | "failed" | "unobservable";
  failKind?: string;
}

export type MutantVerdict = "killed" | "survived" | "inconclusive" | "notApplied";

export interface MutantResult {
  mutant: Mutant;
  verdict: MutantVerdict;
  applied: number;
  /** 因为这个变异体而新失败的用例。survived 时它是空的——那正是盲区的证据。 */
  killedBy: string[];
  /** 新失败里被剔掉的基础设施故障，如实记着。有它就说明这一轮的「没叫」不可信。 */
  ignoredInfra: string[];
}

export interface MutationScore {
  killed: number;
  survived: number;
  inconclusive: number;
  notApplied: number;
  /** 杀掉率。**分母只算「生效了、且这一轮跑得干净」的变异体**——其余的不知道。 */
  score: number;
  /** 分母。报分数时一起报，读者才知道这个比例是几分之几。 */
  denom: number;
  results: MutantResult[];
}

/** 干净跑里失败的用例集合——它们的失败不是任何变异体造成的。 */
export const baselineFailures = (clean: CaseOutcome[]): Set<string> =>
  new Set(clean.filter((c) => c.status === "failed").map((c) => c.caseId));

export function judgeMutant(
  mutant: Mutant,
  applied: number,
  clean: CaseOutcome[],
  mutated: CaseOutcome[],
): MutantResult {
  if (!applied) return { mutant, verdict: "notApplied", applied: 0, killedBy: [], ignoredInfra: [] };

  const wasFailing = baselineFailures(clean);
  const newlyFailed = mutated.filter((c) => c.status === "failed" && !wasFailing.has(c.caseId));
  // 模型超时之类的故障不算「抓住了缺陷」：否则模型越不稳，得分越高。
  const ignoredInfra = newlyFailed.filter((c) => c.failKind === "infra").map((c) => c.caseId);
  const killedBy = newlyFailed.filter((c) => c.failKind !== "infra").map((c) => c.caseId);

  // 有一条真失败就够了：即使同一轮还有别的用例挂了，「抓住了」这个结论不受影响。
  // 反过来「没抓住」就受影响——挂掉的那条正可能是本该叫的那条。
  const verdict: MutantVerdict = killedBy.length
    ? "killed"
    : ignoredInfra.length
      ? "inconclusive"
      : "survived";

  return { mutant, applied, verdict, killedBy, ignoredInfra };
}

export function scoreMutants(results: MutantResult[]): MutationScore {
  const killed = results.filter((r) => r.verdict === "killed").length;
  const survived = results.filter((r) => r.verdict === "survived").length;
  const inconclusive = results.filter((r) => r.verdict === "inconclusive").length;
  const notApplied = results.filter((r) => r.verdict === "notApplied").length;
  const denom = killed + survived;
  return { killed, survived, inconclusive, notApplied, score: denom ? killed / denom : 0, denom, results };
}

/**
 * 活下来的那些，说成人话。
 *
 * **报杀掉率时必须同时报这个。**一个百分比藏起了最有价值的那半截：
 * 每一条活下来的变异体都是一句「产品这里坏了，这套用例不会叫」，
 * 而那正是要交给人看的（接到故事图的缺口那一栏）。
 *
 * **只取 survived，不取 inconclusive。**后者没资格变成写给人看的缺口——
 * 让人去补一个可能根本不存在的盲区，比不报更糟。
 */
export const survivorsAsGaps = (score: MutationScore): Array<{ what: string; from: string }> =>
  score.results
    .filter((r) => r.verdict === "survived")
    .map((r) => ({ what: `${r.mutant.what}——没有任何用例因此失败`, from: r.mutant.from }));
