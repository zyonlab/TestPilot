import type { SfgTransition, StateFlowGraph } from "./sfg.js";

/**
 * 从状态转移图里**算**出流程与模块。
 *
 * 「从入口到终点有哪些路径」是图算法，不是模型推断。把它交给模型，等于把一个确定性问题
 * 变成一个会漏、会编、且不可复现的问题——而这条流水线反复用同一条原则：
 * **能查出来的不要问模型**（出处用字符串定位、代码用正则解析不求值、判据用程序判定）。
 *
 * 模型在这一层只做一件它无可替代的事：**给算出来的路径命名，说出它对用户意味着什么**。
 * 那是意图，图上看不出来。
 */

export interface Flow {
  /** `F-1`、`F-2`…… 稳定编号，故事与用例都引用它。 */
  id: string;
  /** 路径上的状态，从入口到终点。 */
  path: string[];
  /** 走完这条路径的动作序列——**这就是用例的步骤**。 */
  steps: Array<{ from: string; to: string; how: string; kind: SfgTransition["action"]["kind"] }>;
  /** 终点。它是这条流程「做完了什么」的标志。 */
  endsAt: string;
  /** 涉及的路由，去重。用来把流程归到模块。 */
  routes: string[];
  /**
   * 同终点的其他路径有几条。
   *
   * 到同一个地方常有好几条路——绕不绕商品详情页都能进结账。全都列出来，骨架上就是
   * 一堆只差几步的近似重复，人读不下去；全都丢掉，又等于说这个产品只有一条路。
   * 所以取最短的一条为主，其余记个数：**信息不丢，但列表能看**。
   */
  variants: number;
  /**
   * 这条流程的终点是否只是同一路由上的状态变化（比如抽屉打开）。
   *
   * 打开一个抽屉不是「做完了一件事」。不过滤掉——它仍是可达状态、仍要算覆盖——
   * 只是标出来，让骨架和命名那一层知道它不该当主线。
   */
  inPage: boolean;
}

export interface Module {
  /** 路由前缀，或 `/` 表示根。 */
  id: string;
  routes: string[];
  flowIds: string[];
}

const howOf = (t: SfgTransition): string =>
  t.action.kind === "goto"
    ? `走到 ${t.action.target}`
    : t.action.kind === "login"
      ? "登录"
      : `点「${t.action.target}」`;

/**
 * 枚举入口到各终点的路径。
 *
 * 只走**换了状态**的边（`from !== to`）：原地不动的边不推进流程，把它算进去会让同一条
 * 流程出现无数个只差几次空点击的变体。
 *
 * 深度与条数都有上限——一个有环的图路径数是指数级的，而流程是给人读的东西，
 * 几十条就已经没人看得完了。截断了要说出来，不静默丢弃。
 */
export function computeFlows(
  graph: StateFlowGraph,
  opts: { maxDepth?: number; maxFlows?: number } = {},
): { flows: Flow[]; truncated: boolean } {
  const maxDepth = opts.maxDepth ?? 8;
  const maxFlows = opts.maxFlows ?? 40;

  const out = new Map<string, SfgTransition[]>();
  for (const t of graph.transitions) {
    if (!t.ok || !t.to || t.to === t.from) continue;
    out.set(t.from, [...(out.get(t.from) ?? []), t]);
  }

  const entry = graph.entry || graph.states[0]?.id;
  if (!entry) return { flows: [], truncated: false };

  type Raw = Omit<Flow, "id" | "variants" | "inPage">;
  const raw: Raw[] = [];
  let truncated = false;

  const walk = (at: string, path: string[], steps: Flow["steps"], seen: Set<string>): void => {
    if (raw.length >= maxFlows) {
      truncated = true;
      return;
    }
    const next = (out.get(at) ?? []).filter((t) => !seen.has(t.to!));
    // 走不下去了 —— 这是一条流程的终点。深度用尽也算终点，但它是被截断的那种。
    if (!next.length || path.length > maxDepth) {
      if (steps.length)
        raw.push({
          path: [...path],
          steps: [...steps],
          endsAt: at,
          routes: [...new Set(path.map((p) => p.split("#")[0]))],
        });
      if (path.length > maxDepth) truncated = true;
      return;
    }
    for (const t of next) {
      seen.add(t.to!);
      walk(t.to!, [...path, t.to!], [...steps, { from: t.from, to: t.to!, how: howOf(t), kind: t.action.kind }], seen);
      seen.delete(t.to!);
    }
  };

  walk(entry, [entry], [], new Set([entry]));

  // 同终点收敛：最短的一条为主，其余只记个数。
  const byEnd = new Map<string, Raw[]>();
  for (const r of raw) byEnd.set(r.endsAt, [...(byEnd.get(r.endsAt) ?? []), r]);
  const flows: Flow[] = [...byEnd.entries()]
    .map(([endsAt, group]) => {
      const sorted = [...group].sort((a, b) => a.steps.length - b.steps.length);
      const primary = sorted[0];
      const last = primary.steps.at(-1);
      return {
        ...primary,
        endsAt,
        variants: group.length - 1,
        // 终点与它的前一个状态同路由 → 这一步只换了页内状态。
        inPage: !!last && last.from.split("#")[0] === last.to.split("#")[0],
      };
    })
    // 换了路由的排前面：它们是「做完了一件事」，页内状态变化不是。
    .sort((a, b) => Number(a.inPage) - Number(b.inPage) || a.steps.length - b.steps.length)
    .map((f, i) => ({ ...f, id: `F-${i + 1}` }));

  return { flows, truncated };
}

/**
 * 按路由前缀把流程归到模块。
 *
 * 确定性聚类：取每条路由的第一段路径（`/checkout-step-one.html` → `checkout`），
 * 同一段的归一组。**不问模型**——模块划分是路由结构的事实，命名才是判断。
 */
export function computeModules(graph: StateFlowGraph, flows: Flow[]): Module[] {
  const seg = (route: string): string => {
    const s = route.replace(/^\//, "").split(/[/.\-]/)[0];
    return s || "/";
  };
  const byId = new Map<string, Module>();
  for (const st of graph.states) {
    const id = seg(st.route);
    const m = byId.get(id) ?? { id, routes: [], flowIds: [] };
    if (!m.routes.includes(st.route)) m.routes.push(st.route);
    byId.set(id, m);
  }
  for (const f of flows) {
    // 一条流程可能横跨模块——它归到**终点**所在的模块：流程是以「做完了什么」命名的。
    const id = seg(f.endsAt.split("#")[0]);
    const m = byId.get(id);
    if (m && !m.flowIds.includes(f.id)) m.flowIds.push(f.id);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** 交给模型命名时用的紧凑表示：只有结构，没有页面正文。 */
export function describeFlows(flows: Flow[], modules: Module[], truncated: boolean): string {
  return [
    "===== 算出来的流程 =====",
    `${flows.length} 条${truncated ? "（已截断：图上路径过多或过深）" : ""}`,
    ...flows.map(
      (f) =>
        `- ${f.id}　${f.steps.map((s) => s.how).join(" → ")}　终点 ${f.endsAt}` +
        `${f.variants ? `　（另有 ${f.variants} 条路径到此）` : ""}${f.inPage ? "　[页内状态]" : ""}`,
    ),
    "",
    "模块（按路由前缀聚类）：",
    ...modules.map((m) => `- ${m.id}　路由 ${m.routes.join(", ")}　流程 ${m.flowIds.join(", ") || "（无）"}`),
  ].join("\n");
}
