import type { ProductRulePack } from "../domain/rules.js";

export type Priority = "P0" | "P1" | "P2";
export interface PriorityVerdict {
  priority: Priority;
  /** 三项各自成立没有，界面与日志据此说明「为什么是这一档」。 */
  lifecycle: boolean;
  funds: boolean;
  frequent: boolean;
  /** 规则包没有生命周期也没有使用频度时，沿用用例自己的 priority。 */
  source: "rule" | "case";
}

/**
 * 执行优先级：**生命周期主链、影响资金、高频使用**三项，全中是 P0，中两项是 P1，其余 P2（2026-09-26 用户定）。
 *
 * - 生命周期：用例所属故事声明的 lifecycleId 在规则包的生命周期里，或它引用的功能落在某个生命周期阶段上。
 * - 资金：用例 risk.impact 是 funds-and-exposure。
 * - 高频：故事引用的功能里有规则包标成 usage=high 的。
 *
 * 哪个功能在主链上、哪个用得多是项目数据（规则包），这里只有规则本身。
 * 生成出来的 priority 以前是模型的判断——同一批 89 条里只有 34 条和这套规则一致。
 */
export function executionPriority(
  c: { priority?: string; risk?: { impact?: string } },
  story: { featureRefs?: string[]; lifecycleId?: string } | undefined,
  pack?: Pick<ProductRulePack, "lifecycle" | "features">,
): PriorityVerdict {
  const stages = pack?.lifecycle ?? [];
  const usage = new Map((pack?.features ?? []).filter((f) => f.usage).map((f) => [f.id, f.usage!]));
  const funds = c.risk?.impact === "funds-and-exposure";
  if (!stages.length && !usage.size) {
    const own = (["P0", "P1", "P2"] as const).find((p) => p === c.priority) ?? "P1";
    return { priority: own, lifecycle: false, funds, frequent: false, source: "case" };
  }
  const onChain = new Set(stages.flatMap((s) => s.featureIds));
  const refs = story?.featureRefs ?? [];
  const lifecycle = (!!story?.lifecycleId && stages.some((s) => s.id === story.lifecycleId)) || refs.some((f) => onChain.has(f));
  const frequent = refs.some((f) => usage.get(f) === "high");
  const hits = [lifecycle, funds, frequent].filter(Boolean).length;
  return { priority: hits === 3 ? "P0" : hits === 2 ? "P1" : "P2", lifecycle, funds, frequent, source: "rule" };
}

export const PRIORITY_RULE_TEXT =
  "Priority follows one rule, not a feeling: P0 = the story is on the product lifecycle chain (its lifecycleId is a lifecycle stage, or it references a feature listed in a lifecycle stage) AND the case affects user funds (risk.impact funds-and-exposure) AND the story uses a feature marked usage=high; P1 = exactly two of the three; P2 = one or none.";
