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

export type GapReach = "missed" | "unseen";

export interface Gap {
  /** 归到故事图的哪一列。空表示它不属于任何模块（例如规格层面的疑问）。 */
  activity?: string;
  reach: GapReach;
  kind: "transition" | "flow" | "module" | "link" | "blocked" | "unknown";
  /** 一句人话。不用行话，不放选择器。 */
  what: string;
  /** 证据：转移 id、地址、原始错误。人要追下去时靠它。 */
  detail?: string;
}

interface GraphLike {
  states?: Array<{ id: string; route?: string; title?: string }>;
  transitions?: Array<{
    from: string;
    to?: string;
    ok?: boolean;
    walked?: boolean;
    note?: string;
    action?: { kind?: string; target?: string };
  }>;
  stoppedBecause?: string;
}

interface SpecLike {
  modules?: Array<{ id: string; name?: string; flowIds?: string[]; routes?: string[] }>;
  flows?: Array<{ id: string; name?: string; transitions?: string[] }>;
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

/** 一句话描述一条转移，给人看的那种。 */
const describeEdge = (t: NonNullable<GraphLike["transitions"]>[number]): string => {
  const how = t.action?.kind === "goto" ? `走到 ${t.action.target ?? ""}` : `点「${t.action?.target ?? "?"}」`;
  return `${t.from} ${how}${t.to ? ` → ${t.to}` : ""}`;
};

export function computeGaps(input: {
  graph?: GraphLike;
  spec?: SpecLike;
  cases?: CaseLike[];
  stories?: StoryLike[];
}): Gap[] {
  const { graph, spec, cases = [], stories = [] } = input;
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

  // ② 看见了链接、但没走进去的地方。**产品有这个入口，探索没进去。**
  for (const t of graph?.transitions ?? []) {
    if (t.walked !== false) continue;
    gaps.push({
      activity: activityOfState(t.from),
      reach: "unseen",
      kind: "link",
      what: `这个入口看见了，探索没进去`,
      detail: describeEdge(t),
    });
  }

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
    gaps.push({
      activity: activityOfFlow.get(f.id),
      reach: "missed",
      kind: "flow",
      what: `这条流程没有故事`,
      detail: `${f.id}${f.name ? ` ${f.name}` : ""}`,
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
   * **去重。**
   *
   * 一个入口从五个状态上都看得见，它是**一个**缺口（「这个入口没进去」），不是五个。
   * 实测一次运行报出 46 条「看见没进去」，一列 55 条——人看不动，而看不动的清单
   * 等于没有清单。缺口的价值在于**能被读完**。
   *
   * 身份取「哪一类 + 说的是什么」：转移天然唯一；链接按目标地址算，谁看见的不重要。
   */
  const seen = new Set<string>();
  return gaps.filter((g) => {
    const key =
      g.kind === "link"
        ? `link::${(g.detail ?? "").replace(/^.*?走到 /, "")}`
        : `${g.kind}::${g.detail ?? g.what}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 探索为什么停下来。它决定了「没看到」那一类缺口该不该怪探索。 */
export const stoppedBecause = (graph?: GraphLike): string | undefined => graph?.stoppedBecause;
