import { createHash } from 'node:crypto';
import { canonicalJSON } from '@testpilot/harness-core/run-contracts';

/**
 * 改这个版本号 = 让此前所有缓存失效。键的构成一变就必须跳，否则旧缓存会被当成新键的命中。
 */
export const CACHE_POLICY_VERSION='structure-v5';

export function cacheDigest(value:unknown):string { return createHash('sha256').update(canonicalJSON(value)).digest('hex'); }

/**
 * 缓存键 = 这条用例 + 它的上下文 + **首屏的结构**。
 *
 * 2026-09-14 实测：原来的键把 `page.content()`（整份 HTML）和一张截图的哈希放了进去。
 * 在实时行情页上这两样每秒都在变——价格、倒计时、盘口行——于是缓存键几乎必然每次不同。
 * 同一批 10 条用例重跑，47 次模型调用只降到 28 次，而其中三条降到 0 的是**运气**
 * （截图恰好落在数据还没渲染出来的骨架期）。一个只在骨架期命中的缓存等于没有缓存。
 *
 * 但也不能干脆不看页面：缓存里存的是「点哪个元素」的计划，页面结构变了还照着点，
 * 会点到不存在的东西，而那种失败看起来像产品坏了（memory：缓存 xpath 随 DOM 过时）。
 *
 * 所以看**结构**不看内容：可见控件的身份（标签 + 角色）。控件增删、改名、换位置，
 * 键就变，缓存正确地失效；价格跳动、倒计时走字，键不变，缓存正确地命中。
 */
export function scopedCacheId(id:string|undefined, context:unknown, page:{url:string;structure:string}):string|undefined {
 return id ? `tp-${CACHE_POLICY_VERSION}-${cacheDigest({id,context,page})}` : undefined;
}

/**
 * 首屏的结构指纹。
 *
 * 只取**可见的交互控件**，取它们的角色与标签，排序后哈希：
 *   - 不取正文：整页文本里全是会动的数字；
 *   - 不取截图：一个像素变了就变；
 *   - **标签里的数字串抹掉**：`Positions (1)` 与 `Positions (2)` 是同一个控件。
 *     这会丢掉「持仓数变了」这个信号，但那个信号本来就该由用例的判据去抓，
 *     不该由缓存键去抓——键的职责是「这一屏还是不是原来那一屏」。
 */
export const CONTROL_SELECTOR =
 'button,a,input,select,textarea,summary,[role=button],[role=tab],[role=link],[role=checkbox],[role=switch]';

/**
 * 一个控件的身份。**抽成纯函数**是为了它能被测到：探针本体要在浏览器里执行，
 * 而「数字变了指纹不变、控件变了指纹变」这两条性质才是这个设计的全部意义，
 * 它们不该只能靠真跑一次浏览器来验。
 */
export function controlIdentity(el:{tag:string;role?:string|null;label?:string|null}):string {
 return `${el.tag}:${el.role ?? ''}:${(el.label ?? '').trim().replace(/[0-9]+/g,'#').slice(0,48)}`;
}

/** 一屏控件 → 指纹。排序让 DOM 顺序的抖动不影响结果。 */
export function structureOf(controls:ReadonlyArray<{tag:string;role?:string|null;label?:string|null}>):string {
 return controls.map(controlIdentity).sort().join('|');
}

/** 在页面里执行的探针。它只负责采集，判定逻辑在上面那两个纯函数里（同一套规则写两遍会漂）。 */
export const STRUCTURE_PROBE = `[...document.querySelectorAll(${JSON.stringify(CONTROL_SELECTOR)})]
  .filter((el) => el.offsetParent !== null)
  .map((el) => ({ tag: el.tagName, role: el.getAttribute('role'),
    label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent }))`;
