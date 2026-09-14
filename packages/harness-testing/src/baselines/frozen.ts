/**
 * 基准应用的「冻结校验」：跑之前对一次指纹，跑完再对一次。
 *
 * ## 为什么需要它
 *
 * 冻结基准的全部意义是**同一次操作在任何时候都产出同样的结果**，历史数字才可比。
 * 但流水线自己生成的用例里就有「新增主人」这一类——它们填的是格式合法的值，
 * 能通过校验，于是**真的落库**。探测用的坏值走保留域名（`.invalid`）不落库，
 * 正例用例没有这层保护，也不该有：它们本来就该测真实提交。
 *
 * 2026-08-29 实测的后果：PetClinic 数据库里多出 3 个 John Doe，主人数从 10 漂到 13，
 * 黄金清单 G-03「空姓氏搜索返回全部主人（10 条）」当场失真。
 * 而这件事**没有任何机制会报警**——是顺手数了一下才发现的，
 * 在那之前跑出来的数字都带着一个没人知道的偏移。
 *
 * ## 所以防线放在哪
 *
 * 不在用例侧（不该拦真实提交），在基准侧：跑之前确认它是干净的，
 * 跑完确认它还是干净的。**跑完那一次同样重要**——只查跑前，
 * 这一批数字是干净的，下一批就带着上一批留下的漂移，而且照样不会有人知道。
 */

export interface FrozenSpec {
  url: string;
  headers?: Record<string, string>;
  /** 列表页上应该有多少条记录。**这是个下界式的强断言**：多了少了都算漂移。 */
  ownerCount?: number;
  /** 页面上必须出现的字面量。缺了说明种子数据被改过。 */
  mustContain?: string[];
}

export interface FrozenVerdict {
  ok: boolean;
  /** 说人话的差异。ok 时是空的。 */
  drift: string[];
  observed: { count?: number; missing: string[] };
}

/** 列表页上的记录数。按详情页链接去重数——同一条记录页面上可能有多个链接指向它。 */
export const countRecords = (html: string, pattern = /\/owners\/(\d+)/g): number =>
  new Set([...html.matchAll(pattern)].map((m) => m[1])).size;

export async function checkFrozen(
  spec: FrozenSpec,
  fetchImpl: typeof fetch = fetch,
): Promise<FrozenVerdict> {
  const html = await (await fetchImpl(spec.url, { headers: spec.headers })).text();
  const drift: string[] = [];

  let count: number | undefined;
  if (spec.ownerCount !== undefined) {
    count = countRecords(html);
    if (count !== spec.ownerCount)
      drift.push(
        `记录数 ${count}，应该是 ${spec.ownerCount}` +
          (count > spec.ownerCount
            ? `——多出 ${count - spec.ownerCount} 条，多半是某条用例真的提交了表单`
            : `——少了 ${spec.ownerCount - count} 条`),
      );
  }

  const missing = (spec.mustContain ?? []).filter((s) => !html.includes(s));
  if (missing.length) drift.push(`种子数据里这些不见了：${missing.join("、")}`);

  return { ok: drift.length === 0, drift, observed: { count, missing } };
}

/**
 * 跑实验前后各调一次。
 *
 * **漂移了就抛，不是打条日志。**一个只记在日志里的警告，等于没有——
 * 上一次那 3 个 John Doe 要是有日志，也是躺在 20 万行输出里没人看见。
 * 数据已经脏了还继续跑，产出的是一批看起来正常、其实不可比的数字，
 * 那比直接失败糟得多。
 */
export async function assertFrozen(spec: FrozenSpec, when: string): Promise<void> {
  const v = await checkFrozen(spec);
  if (!v.ok) throw new Error(`基准应用${when}不是冻结状态：${v.drift.join("；")}`);
}
