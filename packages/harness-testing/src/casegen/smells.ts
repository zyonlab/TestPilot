/**
 * 需求异味：规格里那些**写法上就注定验不了**的句子。
 *
 * 出自 Femmer、Méndez Fernández、Wagner、Eder，
 * *Rapid quality assurance with Requirements Smells*，Journal of Systems and Software 2017。
 * 那篇工作的贡献不是「需求要写好」这句废话，而是把「写得不好」落成一组**可自动检测的
 * 词法模式**——不需要人、不需要参考答案、不需要跑任何东西。
 *
 * ## 为什么这条流水线特别需要它
 *
 * 规格是模型写的，而模型最擅长写的恰恰是这一类句子：「正确显示」「合理提示」
 * 「适当的反馈」「等等」。它们读起来很像规格，**而且下游一层都拦不住**——
 * 拆故事时它变成一条模糊的故事，设计用例时它变成一条含糊的断言，
 * 直到执行那一刻才发现没有任何东西可判。
 *
 * ISO/IEC/IEEE 29148 把「可验证」列为需求的质量特征之一。异味检测是它的一个**可执行的
 * 近似**：一条带主观语言的需求，几乎注定不可验证。
 *
 * ## 一条纪律：报，不拦
 *
 * 和门禁①一样——异味是**警告不是判决**。一条「页面**合理地**提示错误」可能是材料原文
 * 就那么写的，那时该改的是材料不是规格。**把写作风格问题做成硬拦截，只会让人学会
 * 绕过检查，而不是学会写清楚。**
 */

export interface Smell {
  ruleId: string;
  /** 人话：这句话哪里不对。 */
  what: string;
  /** 命中的那个词。人要判断这是不是误报，靠它。 */
  hit: string;
  /** 出在哪条规则上。 */
  where: string;
}

interface Rule {
  id: string;
  /** 只匹配词，不匹配句——匹配句会让误报率高到没人看。 */
  re: RegExp;
  what: string;
}

/**
 * 规则表。每一条都对应 Femmer 等列出的一类，但**词表是按中文和这条流水线的实际产出
 * 定的**——直接照搬英文词表在中文规格上一条都命不中。
 */
export const SMELL_RULES: Rule[] = [
  {
    /**
     * 「正确」有两种用法，只有一种是异味：
     *
     *   条件（**不是**异味）：「凭证不正确时拒绝登录」「密码不正确时显示错误」
     *   质量声明（是异味）：  「正确显示主人列表」「正确地处理提交」
     *
     * 第一版不分这两种，在人写的需求文档上 5 处命中里 4 处是「不正确时」——
     * **80% 误报**。一个误报这么高的检查器比没有更糟：人会学会无视它，
     * 连带无视那 20% 真的。
     *
     * 所以「正确」只在**后面跟着动作**（正确显示/处理/返回…）或带「地」时才算，
     * 而且前面不能是「不 / 否 / 是否 / 未」。
     */
    id: "subjective",
    re: /(?<![不否未])正确(?:地|的)?(?=[显展处返跳加工运])|(?<![不否未])正确地|合理(?:地|的)?|恰当|适当|良好|友好|清晰(?:地|的)?|明显|美观|流畅|易用/,
    what: "主观语言：好不好由读的人说了算，没法写成判据",
  },
  {
    id: "vague-adverb",
    re: /基本上|通常|一般来说|大致|尽量|尽可能|适度|差不多|大概|应该会/,
    what: "模糊副词：它把一条断言变成一个倾向",
  },
  {
    id: "open-ended",
    re: /等等|以及其他|之类|诸如此类|不限于|等信息|等内容|等操作/,
    what: "开放式列举：没说完的清单，验的人不知道边界在哪",
  },
  {
    id: "comparative-no-ref",
    re: /更快|更好|更少|更多|更简洁|更方便|尽快|及时(?!性)/,
    what: "没有比较对象的比较级：比什么更快？",
  },
  {
    id: "vague-pronoun",
    re: /其(?:他|它)(?:相关)?(?:信息|内容|字段|操作)|相应(?:的)?(?:信息|内容|字段|提示)|对应(?:的)?(?:提示|信息)(?!是)/,
    what: "指代不明：「相应的提示」是哪一句提示",
  },
  {
    id: "non-verifiable",
    re: /支持|兼容|考虑到|确保(?!显示)|保证(?!金)|能够正常|运行正常|工作正常|符合预期/,
    what: "不可验证的措辞：说不出观察什么才算满足",
  },
  {
    id: "passive-no-actor",
    re: /会被(?:自动)?(?:处理|保存|更新|清除)|被(?:系统)?(?:自动)?忽略/,
    what: "无主语的被动：谁做的？在哪一屏能看到？",
  },
];

/**
 * 查一条规则文本里的异味。
 *
 * **只查 `text`，不查 `evidence`。**`evidence` 是从材料里逐字抄的产品原话——
 * 产品自己界面上写着「合理」，那不是规格的毛病，改它反而是篡改证据。
 */
export function smellsOf(rule: { id: string; text: string }): Smell[] {
  const out: Smell[] = [];
  for (const r of SMELL_RULES) {
    const m = r.re.exec(rule.text);
    if (m) out.push({ ruleId: r.id, what: r.what, hit: m[0], where: rule.id });
  }
  return out;
}

export interface SmellReport {
  smells: Smell[];
  /** 有异味的规则占比。**这是一个可以跨版本比的数**，而单看条数会被规格长度带偏。 */
  ratio: number;
  byRule: Record<string, number>;
}

export function scanSmells(rules: Array<{ id: string; text: string }>): SmellReport {
  const smells = rules.flatMap(smellsOf);
  const dirty = new Set(smells.map((s) => s.where)).size;
  const byRule: Record<string, number> = {};
  for (const s of smells) byRule[s.ruleId] = (byRule[s.ruleId] ?? 0) + 1;
  return { smells, ratio: rules.length ? Number((dirty / rules.length).toFixed(3)) : 0, byRule };
}
