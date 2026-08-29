/**
 * 缺口：这个产品有、而这批用例没有的那些东西。
 *
 * 故事图此前只画「有什么」——活动、故事、用例。人拿它没法回答**「缺了什么」**，
 * 而那正是复核这件事的目的：读图是为了判断哪些有效、哪些漏了。
 *
 * 更难堪的是，缺口**早就算出来了，只是没给人看**：没被任何用例覆盖的转移只进了评测、
 * 规格里的「没有答案的地方」只留在正文、**看见但没走过**的链接和**走不通**的路
 * 只躺在图的 JSON 里。后两条的字面意思就是「这个产品有这个入口，我们没进去」——
 * 正是要交给人判断的那一类。
 *
 * 这个模块把它们拢到一处，并且按**人要怎么处置**分成两类：
 *
 *   没测到（missed）  我们看见了、走过了，但没写用例   → 现在就能补一条
 *   没看到（unseen）  探索根本没进去                  → 得让探索再走一次
 *
 * 这条分界是整个模块存在的理由。把两类混在一起报，人只能得到一个焦虑的数字；
 * 分开报，每一条都对应一个明确的下一步。
 */

/**
 * 缺口按**人要怎么处置**分类，不按它从哪来分类。
 *
 *   missed  没测到——看见了、走过了，但没有用例验它      → 补一条用例
 *   unseen  没看到——探索根本没进去                    → 让探索再走一次
 *   blind   验不住——**测了，但那条断言拦不住这个变更**   → 现有用例不够严，改断言
 *
 * 第三类是变异测试带来的，也是三类里**最可行动**的一类：它不但说「这里有问题」，
 * 还说得出「把什么改成什么，你们这套用例不会叫」。前两类只能说「这里没人管」。
 *
 * 它也比前两类更难堪：`missed` 和 `unseen` 是没做到，`blind` 是**做了但没用**
 * ——一条全绿的用例守着一个它根本守不住的地方。
 */
export type GapReach = "missed" | "unseen" | "blind";

export interface Gap {
  /** 归到故事图的哪一列。空表示它不属于任何模块（例如规格层面的疑问）。 */
  activity?: string;
  reach: GapReach;
  kind: "transition" | "flow" | "module" | "link" | "blocked" | "unknown" | "mutant";
  /** 一句人话。不用行话，不放选择器。 */
  what: string;
  /** 证据：转移 id、地址、原始错误。人要追下去时靠它。 */
  detail?: string;
}

interface GraphLike {
  states?: Array<{ id: string; route?: string; title?: string; controls?: string[] }>;
  transitions?: Array<{
    from: string;
    to?: string;
    ok?: boolean;
    walked?: boolean;
    note?: string;
    action?: { kind?: string; target?: string };
  }>;
  stoppedBecause?: string;
  /** 看见过、但那个地址从来没变成一个状态。真正的「没进去」只有这些。 */
  unvisited?: string[];
}

interface SpecLike {
  modules?: Array<{ id: string; name?: string; flowIds?: string[]; routes?: string[] }>;
  flows?: Array<{ id: string; name?: string; transitions?: string[]; steps?: string[]; endsAt?: string }>;
  unknowns?: string[];
}

interface CaseLike {
  id: string;
  storyId?: string;
  covers?: string[];
}

interface StoryLike {
  id: string;
  flowId?: string;
  activity?: string;
}

/**
 * 状态 id 里的 `~1` 是同路由多状态的内部消歧符。**它不该出现在给人看的字里。**
 * 一个复核的人看到 `/owners/1/edit~1` 只会以为那是个地址，然后去浏览器里找不到它。
 */
const plainState = (id: string): string => id.split("~")[0];

/** 一句话描述一条转移，给人看的那种。 */
const describeEdge = (t: NonNullable<GraphLike["transitions"]>[number]): string => {
  const how = t.action?.kind === "goto" ? `走到 ${t.action.target ?? ""}` : `点「${t.action?.target ?? "?"}」`;
  return `${plainState(t.from)} ${how}${t.to ? ` → ${plainState(t.to)}` : ""}`;
};

/** 一个活下来的变异体：产品被改成了这样，而没有任何用例因此失败。 */
export interface SurvivingMutant {
  what: string;
  from: string;
  /** 它改的是哪一段文字/控件——用来把它落到故事图的哪一列。 */
  target?: string;
}

export function computeGaps(input: {
  graph?: GraphLike;
  spec?: SpecLike;
  cases?: CaseLike[];
  stories?: StoryLike[];
  survivors?: SurvivingMutant[];
}): Gap[] {
  const { graph, spec, cases = [], stories = [], survivors = [] } = input;
  const gaps: Gap[] = [];

  /**
   * 路由 → 活动名。故事图的列是活动（模块名），缺口必须落到同一列里，
   * 否则人得在两套坐标之间自己换算——那正是要避免的理解成本。
   */
  const activityOfRoute = new Map<string, string>();
  const activityOfFlow = new Map<string, string>();
  for (const m of spec?.modules ?? []) {
    const name = m.name || m.id;
    for (const r of m.routes ?? []) activityOfRoute.set(r, name);
    for (const f of m.flowIds ?? []) activityOfFlow.set(f, name);
  }
  /** 状态 id 去掉同路由消歧后缀，才对得上模块登记的路由。 */
  const activityOfState = (id: string): string | undefined => activityOfRoute.get(id.split("~")[0]);

  // ① 走过、但没有任何用例声称覆盖的转移。
  const covered = new Set(cases.flatMap((c) => c.covers ?? []));
  for (const t of graph?.transitions ?? []) {
    if (!t.to || t.walked === false || t.ok === false) continue;
    if (t.from === t.to) continue; // 自环不构成「一条没验的路」
    const id = `${t.from}->${t.to}`;
    if (covered.has(id)) continue;
    gaps.push({
      activity: activityOfState(t.from),
      reach: "missed",
      kind: "transition",
      what: `这条路走过，没有用例验它`,
      detail: describeEdge(t),
    });
  }

  /**
   * ② 真正没进去的地址。
   *
   * 第一版用的是图里 `walked: false` 的边——**那些全是假缺口**。补那种边的规矩是
   * 「只在目标路由确实到过时才补」（否则图会凭空声称那里有一屏），所以它们的意思其实是
   * 「这条链接没走，但那一屏我们从别的路进去过」——不是缺口。人看到
   * 「`/owners/find` 走到 `/vets` 没进去」而 `/vets` 明明在图里，只会觉得这东西在瞎报。
   *
   * **一个假缺口比没有缺口更糟**：它消耗信任，而信任是这一整块信息唯一的价值。
   *
   * 真正没进去的是 `graph.unvisited` —— 看见过、而那个地址从来没变成一个状态。
   */
  for (const href of graph?.unvisited ?? [])
    gaps.push({
      activity: activityOfRoute.get(href.split("?")[0]),
      reach: "unseen",
      kind: "link",
      what: `这个入口一次都没进去`,
      detail: href,
    });

  // ③ 试过、但走不通的路。
  for (const t of graph?.transitions ?? []) {
    if (t.ok !== false) continue;
    gaps.push({
      activity: activityOfState(t.from),
      reach: "unseen",
      kind: "blocked",
      what: `这一步试过，走不通`,
      detail: `${describeEdge(t)}${t.note ? ` —— ${t.note}` : ""}`,
    });
  }

  // ④ 算出了流程，却没有故事挂在上面。有这条路径，没人为它写故事。
  const storiedFlows = new Set(stories.map((s) => s.flowId).filter(Boolean) as string[]);
  for (const f of spec?.flows ?? []) {
    if (storiedFlows.has(f.id)) continue;
    /**
     * 只写 `F-8` 等于没写：复核的人不知道 F-8 是什么，也没法判断它该不该有故事。
     * 有名字用名字，没名字就把这条路径本身摊开——**路径是它唯一说得清自己的方式**。
     */
    const path = (f.steps ?? []).join(" → ");
    gaps.push({
      activity: activityOfFlow.get(f.id),
      reach: "missed",
      kind: "flow",
      what: `这条流程没有故事`,
      detail: f.name && f.name !== "(未命名)" ? `${f.name}（${f.id}）` : path || f.id,
    });
  }

  // ⑤ 一条故事都没有的模块。**空白也要画出来**——一整块功能没人管，
  //    比任何单条缺口都严重，而它恰恰是「什么都不显示」时最容易被忽略的。
  const busyActivities = new Set(stories.map((s) => s.activity).filter(Boolean) as string[]);
  for (const m of spec?.modules ?? []) {
    const name = m.name || m.id;
    if (busyActivities.has(name)) continue;
    gaps.push({
      activity: name,
      reach: "missed",
      kind: "module",
      what: `这一块没有任何故事`,
      detail: (m.routes ?? []).slice(0, 6).join("、"),
    });
  }

  // ⑥ 规格自己承认没答案的地方。它不属于任何模块——那正是它的性质。
  for (const u of spec?.unknowns ?? [])
    gaps.push({ reach: "unseen", kind: "unknown", what: `材料里没有答案`, detail: u });

  /**
   * ⑦ 活下来的变异体。
   *
   * 它落到哪一列：看它改的那段文字出现在哪个状态上，再由那个状态的路由反查模块。
   * 找不到就不归类——**宁可不归类，也不要归错**：一条挂错列的缺口会让人去检查
   * 一块本来没问题的功能。
   */
  for (const m of survivors) {
    const at = m.target
      ? (graph?.states ?? []).find((st) =>
          (st.controls ?? []).some((c) => c.toLowerCase().includes(m.target!.toLowerCase())),
        )
      : undefined;
    gaps.push({
      activity: at ? activityOfState(at.id) : undefined,
      reach: "blind",
      kind: "mutant",
      what: m.what,
      detail: m.from,
    });
  }

  /**
   * **去重。**
   *
   * 一个入口从五个状态上都看得见，它是**一个**缺口（「这个入口没进去」），不是五个。
   * 实测一次运行报出 46 条「看见没进去」，一列 55 条——人看不动，而看不动的清单
   * 等于没有清单。缺口的价值在于**能被读完**。
   *
   * 身份取「哪一类 + 说的是什么」：转移天然唯一；链接按目标地址算，谁看见的不重要。
   *
   * **`detail` 不总是身份。**变异缺口的 `detail` 是它的**来源**（「图上走过的一条转移」），
   * 而来源是许多变异体共有的——拿它当身份，四条盲区会被合并成三条，
   * 而且是静默合并。实测掉的正是「把指向 /owners/1 的链接改指到别处」那条。
   * 对变异缺口，身份是 `what`：它说的是哪一个具体缺陷。
   */
  const seen = new Set<string>();
  return gaps.filter((g) => {
    const key =
      g.kind === "link"
        ? `link::${(g.detail ?? "").replace(/^.*?走到 /, "")}`
        : g.kind === "mutant"
          ? `mutant::${g.what}`
          : `${g.kind}::${g.detail ?? g.what}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 探索为什么停下来。它决定了「没看到」那一类缺口该不该怪探索。 */
export const stoppedBecause = (graph?: GraphLike): string | undefined => graph?.stoppedBecause;
