/**
 * 变异算子：往跑着的产品里注入一个人造缺陷，看这套用例会不会叫。
 *
 * 我们能证明「用例**说得出**自己验什么」（判据兑现率 100%、89% 说得出覆盖哪条转移），
 * 证明不了「用例**真的验得住**」。一套全绿的用例集有两种可能——产品是好的，
 * 或者用例根本是瞎的，而全绿这件事本身分不清是哪一种。
 *
 * 经典变异测试往**源码**里注缺陷，需要源码和重新构建；我们是黑盒的。但变异测试的本质是
 * 「注入一个缺陷，看抓不抓得到」——**缺陷注在哪是实现细节**。我们控制着浏览器，
 * 就注在响应/DOM 这一层。
 *
 * ## 一条决定成败的规矩
 *
 * **变异体只能从产品的事实生成，绝不能从用例的判据生成。**
 *
 * 拿用例自己声称要验的字符串去改，杀掉率必然接近 100%，而那个数一文不值——
 * 它量的是「用例能不能发现自己写下的东西被改了」，那是同义反复。所以这里的输入只有
 * **图**（探索走出来的界面、控件、链接）和**规格**（从材料里摘的规则），
 * 用例集在生成变异体的时候一眼都不能看。
 *
 * 这条规矩和黄金清单「由人写、不由模型生成」是同一个道理：**考卷不能由考生出**。
 *
 * ## 报告的规矩
 *
 * 报杀掉率时**必须同时报活下来的那些**。只报一个百分比，等于把最有价值的那半截藏起来
 * ——一个活下来的变异体的意思是「产品这里坏了，没人会发现」，那正是要交给人看的东西
 * （接到故事图的缺口那一栏，见 `server/src/gaps.ts`）。
 *
 * ## 等价变异体
 *
 * 有些改动本来就不该被任何用例发现（改一段没人断言的装饰文案）。它们活下来不是缺陷。
 * 经典变异测试至今没有干净的自动判别办法，这里也没有——**只能靠算子设计得克制，
 * 并且如实报出来**。所以每个变异体都带 `from`：它是从产品的哪一条事实生成的，
 * 人可以据此判断「这条本来就该没人管吗」。
 */

/** 算子表。每一条都是可关掉、可横比的——一个只有作者知道注了什么的变异得分没有意义。 */
export const OPERATORS = {
  /** 把界面上一句话改成一句**近似但不同**的话。校验消息、标题、按钮文案都属于这一类。 */
  text: "text",
  /** 让一个控件从界面上消失。 */
  hide: "hide",
  /** 把一条链接指向别处。 */
  relink: "relink",
  /** 从一组重复项里删掉一个（列表少一行）。 */
  dropOne: "dropOne",
} as const;

export type MutationOperator = (typeof OPERATORS)[keyof typeof OPERATORS];

export interface Mutant {
  id: string;
  operator: MutationOperator;
  /** 人话：这个变异体把产品改成了什么样。报告里给人看的就是这一句。 */
  what: string;
  /** **它是从产品的哪一条事实生成的。**判断等价变异体要靠它。 */
  from: string;
  /** 注入时要找的东西（一段文字、一个控件文案、一个 href）。 */
  target: string;
  /** 换成什么（`text` 与 `relink` 用）。 */
  replacement?: string;
}

interface GraphLike {
  states?: Array<{ id: string; route?: string; title?: string; controls?: string[] }>;
  transitions?: Array<{ from: string; to?: string; action?: { kind?: string; target?: string } }>;
}
interface SpecLike {
  rules?: Array<{ id: string; text: string; evidence?: string }>;
}

/**
 * 把一句话改成**近似但不同**的一句。
 *
 * 「近似」是有意的：改得面目全非，任何一个宽松的断言都能抓到，那考的不是用例的精度。
 * 只动一个词，考的才是「这条断言到底逐字对了没有」——而逐字引用正是这条流水线
 * 从材料到判据一路坚持的事。
 */
export function nearMiss(s: string): string {
  const swaps: Array<[RegExp, string]> = [
    [/\bempty\b/i, "blank"],
    [/\bnot\b/i, "never"],
    [/\bfound\b/i, "located"],
    [/\brequired\b/i, "mandatory"],
    [/\binvalid\b/i, "incorrect"],
    [/不能为空/, "不可为空"],
    [/未找到/, "没找到"],
    [/必填/, "必须填写"],
  ];
  for (const [re, to] of swaps) if (re.test(s)) return s.replace(re, to);
  // 没有可换的词就改末尾一个字符——仍然是「近似但不同」。
  return s.length > 3 ? `${s.slice(0, -1)}${s.slice(-1) === "." ? "!" : "."}` : `${s}.`;
}

/** 控件的采集串是 `tag[type]: 文案 -> href`，取中间那段人看的文案。 */
export function labelOf(control: string): string {
  const m = /^[^:]*:\s*([\s\S]*?)(?:\s*->\s*\S+)?$/.exec(control);
  return (m?.[1] ?? control).trim();
}

const isJunkLabel = (l: string): boolean =>
  !l || l.length < 2 || l.length > 60 || l.startsWith("（无可见文案") || /^[\s\d.]+$/.test(l);

/**
 * 从图和规格生成变异体。**用例集不参与。**
 *
 * `limit` 是每一类算子最多产几个：变异测试的成本是「变异体数 × 跑一遍用例集」，
 * 而跑一遍要一小时。先少而有代表性，再谈规模。
 */
export function generateMutants(
  input: { graph?: GraphLike; spec?: SpecLike },
  limit = 4,
): Mutant[] {
  const { graph, spec } = input;
  const out: Mutant[] = [];
  const seen = new Set<string>();
  const push = (m: Omit<Mutant, "id">) => {
    const key = `${m.operator}::${m.target}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...m, id: `M-${out.length + 1}` });
  };

  /**
   * ① 改文案。取自**规格规则的 evidence**——那是从材料里逐字摘的产品原话，
   * 而不是用例声称要断言的东西。两者可能重叠，但来源不同，这一点是这条规矩的全部。
   */
  for (const r of (spec?.rules ?? []).slice()) {
    const ev = (r.evidence ?? "").trim();
    if (!ev || ev.length < 4 || ev.length > 80) continue;
    if (out.filter((m) => m.operator === "text").length >= limit) break;
    push({
      operator: "text",
      target: ev,
      replacement: nearMiss(ev),
      what: `把界面上的「${ev}」改成「${nearMiss(ev)}」`,
      from: `规格规则 ${r.id} 引用的产品原话`,
    });
  }

  /** ② 藏控件。取自图上真实采到的控件文案。 */
  const labels: string[] = [];
  for (const st of graph?.states ?? [])
    for (const c of st.controls ?? []) {
      const l = labelOf(c);
      if (!isJunkLabel(l) && !labels.includes(l)) labels.push(l);
    }
  for (const l of labels.slice(0, limit))
    push({
      operator: "hide",
      target: l,
      what: `让控件「${l}」从界面上消失`,
      from: `图上采到的控件`,
    });

  /** ③ 断链接。取自图上真实走过的 goto 转移。 */
  const hrefs: string[] = [];
  for (const t of graph?.transitions ?? [])
    if (t.action?.kind === "goto" && t.action.target && !hrefs.includes(t.action.target))
      hrefs.push(t.action.target);
  for (const h of hrefs.slice(0, limit))
    push({
      operator: "relink",
      target: h,
      replacement: "/__mutated__",
      what: `把指向「${h}」的链接改指到别处`,
      from: `图上走过的一条转移`,
    });

  return out;
}
