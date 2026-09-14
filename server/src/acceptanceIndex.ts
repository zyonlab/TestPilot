/**
 * 验收准则的编号，以及「这条准则要不要用户动手」。
 *
 * **为什么要编号。** 2026-09-13 实测 81 条用例：`acRefs` 共 85 条，其中 **21 条是模型
 * 自己改写的**——故事里根本没有那句话——而 16 条连 `When` 都改了，方向高度一致：
 *
 * ```
 * S-08 说：        When 用户输入超出 szDecimals 小数位的数量 ／ 用户切换计价单位
 * TC-016/017 改成：When 用户查看 Size 输入框旁
 * S-10 说：        When 用户勾选 Reduce Only 并提交
 * TC-020 改成：    When 用户查看面板
 * ```
 *
 * **故事里那个有业务含量的动作，被换成了「看一眼」。** 之后整条链是闭合的：用例不需要动作
 * → 步骤只剩「打开 + 看」（81 条里 24 条）→ 判据退化成「页面上有这个字面量」→
 * 在初始页面上就成立（实测 `trade-panel.order-entry` 通过 9 条里 6 条是这样）。
 *
 * 根因是 `acRefs` 收的是自由文本。给准则编号、让 `acRefs` 只能填编号，改写就无处可去——
 * 这和 `featureIds` 认领模块、叶子扇出报数是同一条老教训：**是事实就当数据交出去，
 * 别让模型重写**。
 *
 * 编号按冻结后的顺序派（`S-05/AC-2`）。故事在用例节点开始前就冻结了
 * （`stories_frozen_after_case_design`），所以顺序是稳的。
 */

/** 用户真的动了手，而不只是看了一眼。 */
/**
 * **动作动词表是拿真语料调出来的，不是想出来的。**
 *
 * 2026-09-14 第一版只认「点击/单击/双击」，而重跑那一轮模型写的是「用户点「Limit」」
 * ——光杆的「点」。154 条真实验收准则里，判成动作的从 89 条掉到本该有的 107 条，
 * 12 条故事被误报成「一条动作型准则都没有」，而契约正拿这份错标注在教模型写用例。
 *
 * 所以光杆的「点」要认，但得排掉名词性用法：`节点/终点/观点/重点/焦点/地点/起点`
 * 用负向后顾排，`点差/点位/点评` 用负向先行排。同理 `按` 只认 `按下/按住/长按`
 * （否则「按钮」全中），`输入` 不认 `输入框`，`选择` 不认 `选择器/选择框`。
 * `挂单` 也不能进表——「查看挂单档位」里它是名词。
 *
 * 第三版（同日）补的：重写时把 `打开/关闭` 弄丢了，`执行/设为/切到/勾上` 也没有,
 * 于是「打开持仓面板」「执行 Transfer to Spot」「将杠杆设为 20x」又被判成看一眼。
 * 三轮运行的 258 条去重语料现在判出 173 条动作型，剩下的逐条复核过：
 * 全是 `用户查看X` / `页面加载完成` / `订单成交` / `行情触及 TP 价` 这类观察与系统事件。
 */
const ACTION =
  /(?<![节终观重焦特优缺地时起热盲难要看论支据零冰卖买基]) ?点(?![差位评子心缀])|单击|双击|敲|按下|按住|长按|填入|填写|键入|粘贴|输入(?!框)|勾选|取消勾选|勾上|选择(?!器|框)|选中|选定|切换(?!器)|切到|滚动|拖动|拖拽|悬停|提交|上传|清空|设置|设为|设成|执行|打开|关闭|展开|收起|滑动|调整|修改|启用|停用|连接|断开|下单|撤单|撤掉|撤销|取消|平仓|开仓|转账|充值|提现|划转|刷新|重新加载|重新进入|返回|跳转|click|tap|type|fill|enter|select|toggle|scroll|drag|hover|submit|upload|press|connect|disconnect|cancel|enable|disable|reload|refresh|open|close/i;

export interface AcceptanceEntry {
  id: string;
  storyId: string;
  index: number;
  text: string;
  /** `When` 子句的原文；写法不含 When 时为空。 */
  when: string;
  /** 这条准则要求用户动手（而不只是看一眼）。 */
  actionable: boolean;
}

export function acceptanceWhen(text: string): string {
  // 只认子句开头的 When（句首，或 `/ ， ; 换行` 之后）——2026-09-14 实测模型两种分隔都用——`Then …when 用户…` 里的 when 不是子句。
  return (/(?:^|[/,，;；\n])\s*When\s+([^/,，;；\n]+)/i.exec(text))?.[1]?.trim() ?? "";
}
export function acceptanceIsActionable(text: string): boolean {
  const when = acceptanceWhen(text);
  // 没写 When 的准则按整句判断：有动作动词就算动作型，宁可宽，不要把真动作误判成看一眼。
  return ACTION.test(when || text);
}
export function acceptanceId(storyId: string, index: number): string {
  return `${storyId}/AC-${index + 1}`;
}

export function acceptanceIndex(
  stories: Array<{ id: string; acceptance?: string[] }>,
): AcceptanceEntry[] {
  return stories.flatMap((s) =>
    (s.acceptance ?? []).map((text, index) => ({
      id: acceptanceId(s.id, index),
      storyId: s.id,
      index,
      text,
      when: acceptanceWhen(text),
      actionable: acceptanceIsActionable(text),
    })),
  );
}

export interface AcceptanceFinding { code: string; storyId: string; message: string }

/**
 * 一条故事**一条动作型准则都没有**。
 *
 * 不拦——2026-09-13 实测 29 条故事里有 3 条是这样（S-02 看读数、S-03 理解资金费、
 * S-14 确认账户模式），它们说的确实是「产品显示什么」，那是合法的展示型需求。
 * 但它要被说出来：一条没有任何动作的故事，下游只会长出「打开页面 + 看一眼」的用例，
 * 而那种用例的判据在初始页面上就成立——**它通过时什么都没证明**。
 * 写故事的那一方看到这条，可以补上动作，也可以确认它就是展示型的。
 */
export function checkStories(
  stories: Array<{ id: string; title?: string; acceptance?: string[] }>,
): AcceptanceFinding[] {
  const out: AcceptanceFinding[] = [];
  for (const s of stories) {
    const acs = s.acceptance ?? [];
    if (!acs.length) continue;
    if (!acs.some(acceptanceIsActionable))
      out.push({
        code: "story_has_no_actionable_criterion",
        storyId: s.id,
        message: `「${s.title ?? s.id}」的 ${acs.length} 条验收准则没有一条要求用户动手（When: ${acs.map((a) => acceptanceWhen(a) || a.slice(0, 20)).join(" / ")}）——下游只会长出「打开页面就看一眼」的用例`,
      });
  }
  return out;
}
