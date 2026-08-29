import { z } from "zod";

/**
 * 状态转移图（state-flow graph）。
 *
 * 探索本来就在走这张图——每一轮都清楚「在 A 屏做了 X，到了 B 屏」——此前只把走到的**点**
 * 留下来，走过的**边**全部丢掉。于是产出的材料里只有一张张屏幕的静态清单，下游整理出的
 * 规格也就只有「X 页显示 Y」，一条转移、一条守卫、一条领域规则都没有。
 *
 * 这个产物不是新发明：Crawljax（Mesbah 等，ICWE 2008 / TWEB 2012）把它叫
 * **state-flow graph**，是自动化 Web GUI 测试（AWGT）领域十五年来的标准中间产物。
 * 典型循环是「检查页面 → 状态抽象 → 并入状态转移图 → 选下一个动作 → 派发」，
 * 我们的探索循环就是它。
 *
 * 边记到什么粒度，参照 ScenGen（ASE 2026）：每次交互记成一条语义完整的条目——
 * 动作类型、目标控件、输入数据、结果。只记 (from, to) 的三元组在下游写不出用例，
 * 因为「怎么走过去的」正是用例的步骤。
 */

/** 一次动作。`goto` 与 `click` 不花模型调用，`login` 是探索里唯一必须问模型的一步。 */
export const SfgActionSchema = z.object({
  /**
   * `probe` 是**做实验**：故意把表单空着提交，看产品说什么。
   *
   * 它和其余三种性质不同——那三种是「走到某处」，它是「故意造一个坏输入」。
   * 遍历永远走不到校验状态，因为通往它们的边需要有人故意去踩。
   */
  kind: z.enum(["goto", "click", "login", "probe"]),
  /** 人能看懂的目标：控件的可见文案，或它指向的地址。 */
  target: z.string().default(""),
  /** 怎么再找到它。可复现的关键：`data-test` / `#id` / 一条 nth-of-type 路径。 */
  selector: z.string().default(""),
  /** 输入了什么（登录这类步骤）。占位符原样保留，明文永不落盘。 */
  input: z.string().optional(),
});
export type SfgAction = z.infer<typeof SfgActionSchema>;

export const SfgTransitionSchema = z.object({
  from: z.string().min(1),
  to: z.string().optional(),
  action: SfgActionSchema,
  /**
   * 走通了没有。**走不通也是一条边**——它记的是「这条路走不过去」，
   * 而那正是下游「没有答案的地方」的来源之一。
   */
  ok: z.boolean(),
  /** 没走通的原因，或走通了但没换状态。 */
  note: z.string().optional(),
  /**
   * 这条边是**走过**的，还是只是**看见**的。
   *
   * 探索按地址全局记「去过没去过」，所以一个页面只会被从某一处进入一次——图里因此只留下
   * 遍历实际走的那条边，退化成一棵生成树。而 PetClinic 每页都有全局导航栏：那些没被走过的
   * 链接是真实存在的导航选项，丢掉它们，最短路径算出来的就还是遍历顺序。
   *
   * 看见的边照记，但标出来：**我们确认了这个链接存在，没有确认它真的跳到那里**。
   * 两者混作一谈，图就在声称一些没验证过的事。
   */
  walked: z.boolean().default(true),
});
export type SfgTransition = z.infer<typeof SfgTransitionSchema>;

export const SfgStateSchema = z.object({
  /** 稳定标识：`<路由>#<抽象出来的状态序号>`。 */
  id: z.string().min(1),
  /** 路由。同一路由的不同可见状态是它的子节点，不是另一条路由。 */
  route: z.string().default(""),
  title: z.string().default(""),
  /** 这一屏上能做什么——控件的可见文案。状态抽象多数就建立在它上面。 */
  controls: z.array(z.string()).default([]),
});
export type SfgState = z.infer<typeof SfgStateSchema>;

export const StateFlowGraphSchema = z.object({
  /**
   * 用的是哪一种状态抽象。
   *
   * **必须记下来**：横比六种抽象的实证研究把它认定为测试有效性的关键变量——
   * 抽象过松会把没探索过的当成已探索（漏测），过紧会把探索过的当成新的（冗余）。
   * 一次探索的结果如果说不出自己用的哪把尺子，它就没法和另一次比较。
   */
  abstraction: z.string().default("route+controls"),
  entry: z.string().default(""),
  states: z.array(SfgStateSchema).default([]),
  transitions: z.array(SfgTransitionSchema).default([]),
  /** 为什么停下来。一份薄图要能说出自己为什么薄。 */
  stoppedBecause: z.string().default(""),
  /**
   * 停下来的原因，结构化的那一份。界面靠它翻译；
   * `stoppedBecause` 那句中文留着，旧运行只有它。
   */
  stopped: z.object({ kind: z.string(), n: z.number().optional() }).optional(),
  /**
   * **看见过、但那个地址从来没变成一个状态。**
   *
   * 「看见但没走过」的链接此前只在目标路由**确实到过**时才补成边——那条规矩是对的
   * （补一条指向未知地方的边，等于凭空声称那里有一屏），但它的副作用是：
   * **真正没去过的地址被整个丢掉了**。
   *
   * 而那恰恰是最该告诉人的一类：「这个产品有这个入口，我们一次都没进去」。
   * 它不该变成一条边（那会让图说谎），但它必须活下来。所以单独存一份地址清单。
   */
  unvisited: z.array(z.string()).default([]),
});
export type StateFlowGraph = z.infer<typeof StateFlowGraphSchema>;

/**
 * 状态抽象：把一屏映射成一个可比较的键。
 *
 * 做成一族可替换的函数而不是写死一个，是因为实证研究的核心结论就是**这是关键变量**，
 * 而且不同探索策略适配不同的抽象——严格细粒度的利于 model-based（我们这一类），
 * 紧凑的利于 RL-based。写死了就没法参与消融，也没法和别人的结果比。
 */
export type Abstraction = (screen: { url: string; controls: string[]; title?: string }) => string;

/**
 * 路由。**包含 `#/` 开头的哈希。**
 *
 * 单页应用普遍用哈希路由：`#/search`、`#/basket`、`#/login` 是三个不同的界面。
 * 早先这里返回 `pathname + search`，把哈希整个丢掉——于是 OWASP Juice Shop 的
 * 20 个状态**全部**抽象成同一个 `/`，一个购物网站被压成了一个路由。而这在下游
 * 完全看不出来：图是满的、规格是齐的，只是它描述的是「一屏」。
 *
 * `#section` 这种纯锚点不是路由，不算——否则同一页的目录跳转会炸出一堆假状态。
 * 区分标准就是那个 `/`，也正是所有哈希路由库的约定。
 */
const routeOf = (u: string): string => {
  try {
    const x = new URL(u);
    return x.pathname + x.search + (x.hash.startsWith("#/") ? x.hash : "");
  } catch {
    return u;
  }
};

/** 去掉查询串、保留哈希路由。`/p?a=1#/x?b=2` → `/p#/x`。 */
const pathOf = (u: string): string => {
  const r = routeOf(u);
  const i = r.indexOf("#");
  if (i < 0) return r.split("?")[0];
  return r.slice(0, i).split("?")[0] + r.slice(i).split("?")[0];
};

/**
 * 控件文案里的数字是**数据**，不是结构。
 *
 * 购物车角标（`Your Basket 0 → 1 → 5`）、未读数、结果条数——每变一次，控件集合就变一次，
 * 于是同一个搜索页在 Juice Shop 上裂成 11 个「新状态」，探索把预算全花在原地。这正是
 * 抽象过紧的那一头：不是漏测，是冗余。
 *
 * 反过来说，如果某个数字真的决定了界面（分页第 2 页、筛选结果），它会出现在路由或
 * 查询串里——`url+controls` 那把尺子照样量得到。所以归一化数字丢掉的是角标，不是分页。
 */
const numless = (c: string): string => c.replace(/\d+/g, "#");

export const ABSTRACTIONS: Record<string, Abstraction> = {
  /** 只看路由。最紧凑：同一页面的任何状态变化都看不见。 */
  route: (s) => pathOf(s.url),
  /** 路由 + 可见控件集合。默认：控件是「这一屏能做什么」，而探索问的正是这个。 */
  "route+controls": (s) => `${pathOf(s.url)}|${[...s.controls].sort().join("|")}`,
  /** 路由 + 控件 + 标题。更严：标题变了就算另一个状态。 */
  "route+controls+title": (s) =>
    `${pathOf(s.url)}|${s.title ?? ""}|${[...s.controls].sort().join("|")}`,
  /** 连查询串一起算。最严：分页、筛选各算一个状态。 */
  "url+controls": (s) => `${routeOf(s.url)}|${[...s.controls].sort().join("|")}`,
  /**
   * 默认。路由 + 控件，但控件文案里的数字归一化——见 `numless`。
   *
   * 名字里带 `/norm` 是为了让**旧图仍然诚实**：一次探索用了哪把尺子会跟着图记下来，
   * 悄悄改掉 `route+controls` 的含义，会让此前所有记着这个名字的图从此说谎。
   */
  "route+controls/norm": (s) =>
    `${pathOf(s.url)}|${[...s.controls].map(numless).sort().join("|")}`,
};

export const abstractionOf = (name?: string): Abstraction =>
  ABSTRACTIONS[name ?? ""] ?? ABSTRACTIONS["route+controls/norm"];

export { routeOf, pathOf };

/** 图的一段人类可读摘要，跟着材料一起交给下游——LLM 吃结构，不吃原始屏幕转储。 */
export function describeGraph(g: StateFlowGraph): string {
  const lines = [
    "===== 状态转移图 =====",
    `状态抽象：${g.abstraction}　入口：${g.entry}`,
    `${g.states.length} 个状态，${g.transitions.length} 条转移；停止原因：${g.stoppedBecause}`,
    "",
    "状态：",
    ...g.states.map((s) => `- ${s.id}　${s.title || "(无标题)"}　${s.controls.length} 个控件`),
    "",
    "转移：",
    ...g.transitions.map((t) => {
      const how =
        t.action.kind === "goto"
          ? `走到 ${t.action.target}`
          : t.action.kind === "login"
            ? "登录"
            : t.action.kind === "probe"
              ? `空着提交「${t.action.target.replace("（空表单）", "")}」`
              : `点「${t.action.target}」`;
      const mark = t.walked === false ? "（未走过·仅见链接）" : "";
      return t.ok && t.to
        ? `- ${t.from} --[${how}]${mark}--> ${t.to}`
        : `- ${t.from} --[${how}]--> ✗ ${t.note ?? "没走通"}`;
    }),
  ];
  return lines.join("\n");
}
