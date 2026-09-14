import type { ExplorationReport } from "../domain/report.js";

/** 一个控件在页面上的文案与它当时的选择器。 */
export interface LocatorHint {
  label: string;
  selector: string;
  featureId?: string;
}

/**
 * 从探索回执里抽出**定位提示表**。
 *
 * 为什么不把选择器写进用例：文本用例是端无关的，同一条用例以后要能变成 iOS 或 Android 的
 * 用例，选择器进去就钉死在 web 上了。所以选择器留在执行侧，按**文案**索引——用例说
 * 「点击 Balances」，执行侧查这张表，查到就先试那个选择器。
 *
 * 一个文案只留一条：同一个文案在探索里出现多次（比如两次点 Cross）说明它在不同状态下
 * 都被点过，取最后一次——那是最接近最终页面结构的一次。
 */
export function locatorHints(report: Pick<ExplorationReport, "observations">): LocatorHint[] {
  const byLabel = new Map<string, LocatorHint>();
  for (const o of report.observations) {
    // 只认点击：goto 的 target 是地址，probe 是故意造的坏输入，都不是「这个控件在哪」。
    if (o.action?.kind !== "click") continue;
    const label = o.action.target.trim();
    const selector = o.action.selector.trim();
    if (!label || !selector) continue;
    byLabel.set(label, { label, selector, featureId: o.featureId });
  }
  // 长文案排前面：执行侧按「步骤里包含哪个文案」匹配，先看到更具体的那个。
  return [...byLabel.values()].sort((a, b) => b.label.length - a.label.length);
}

/** 会把一个控件按下去的动词。填值、断言、滚动不在内——那些交给模型。 */
const CLICK_VERB = /点击|点开|点选|勾选|选择|展开|切到|切换到|click|check|select|expand/gi;

/**
 * 这一步该点哪个控件。
 *
 * **只看动词之后那一截**，不看整句。第一版取「整句里提到的最长文案」，在真跑里点错了两次：
 * 「在订单簿区域顶部的 Order Book / Trades 切换处点击 **Trades**」被判成 Order Book
 * （更长），于是切换根本没发生、断言报「页面上仍有 Spread」；
 * 「在下单面板的 Market / Limit / Pro 一行里点击 **Pro**」同理点成了 Market。
 * 句子前半截说的是**它在哪**，后半截才是**点哪个**。
 *
 * 动词之后那一截里没有认识的文案就返回 undefined——交回模型，而不是猜一个。
 */
export function pickLocator(step: string, hints: LocatorHint[]): LocatorHint | undefined {
  if (!hints.length) return undefined;
  CLICK_VERB.lastIndex = 0;
  let end = -1;
  for (let m = CLICK_VERB.exec(step); m; m = CLICK_VERB.exec(step)) end = m.index + m[0].length;
  if (end < 0) return undefined;
  const tail = step.slice(end);
  return hints.filter((h) => h.label && tail.includes(h.label)).sort((a, b) => b.label.length - a.label.length)[0];
}

/**
 * 这条提示现在还算不算数。
 *
 * 两件事同时成立才用：**恰好命中一个**元素，且它的可见文本**仍然包含**当初的文案。
 * 任何一条不成立都返回原因——缓存的 xpath 会随 DOM 过时，照点会点错东西，
 * 而「点错了」比「没用上」难查得多。
 */
export function locatorUsable(label: string, count: number, text: string): { ok: true } | { ok: false; why: string } {
  if (count !== 1) return { ok: false, why: `不唯一（命中 ${count} 个）` };
  if (!text.includes(label)) return { ok: false, why: `已过时（这里现在是「${text.trim().slice(0, 24)}」）` };
  return { ok: true };
}
