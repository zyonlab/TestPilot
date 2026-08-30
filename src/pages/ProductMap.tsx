import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useT } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import { API_BASE } from "@/lib/base";
import { stopReason } from "@/lib/stopReason";

/**
 * 产品地图：探索走出来的那张状态流图。
 *
 * ## 为什么非画不可
 *
 * 探索产出 13 个状态、64 条转移，而在此之前界面上关于它只有一句「explore · 19.5s」。
 * 后果不是「少一张图」，是**缺口清单读不懂**：复核的人会看到
 *
 *     这条路走过，没有用例验它
 *     /owners 走到 http://localhost:8080/owners/find → /owners/find
 *
 * 他没有任何地图可以把这句话放上去。同理「探索停下来是因为：采满 18 屏的上限」——
 * 他看不见采了哪 18 屏、剩下什么没采。整条流水线的地基是这张图，
 * 而要对产出物负责的那个人从头到尾看不见它。
 *
 * ## 这张图上每一样东西都对应一个判断
 *
 * 它不是「把数据画出来」。图上的每一种视觉差别都必须回答复核的人的一个问题：
 *
 *   实线 vs 虚线   这条路我们**走过**吗？（虚线＝只在页面上看见这个链接，没点进去）
 *   琥珀色边       走过了，但**没有用例验它** —— 点得开，右边告诉你缺的是什么
 *   节点角标       这一屏上有几条没验的路、几个没进去的入口
 *
 * 没有对应判断的视觉差别一律不做：颜色越多，人越要先学一套图例才看得懂，
 * 而**要先学才能看的图，等于没有图**。
 */

const API = API_BASE;

interface MapGraph {
  entry?: string;
  abstraction?: string;
  states: Array<{ id: string; route?: string; title?: string; controls?: string[] }>;
  transitions: Array<{
    from: string;
    to?: string;
    walked?: boolean;
    ok?: boolean;
    kind?: string;
    label?: string;
  }>;
  unvisited?: string[];
  stoppedBecause?: string;
  stopped?: { kind: string; n?: number };
}

export interface MapGap {
  reach: "missed" | "unseen" | "blind";
  kind: string;
  what: string;
  detail?: string;
  anchor?: { kind: "edge"; from: string; to: string } | { kind: "state"; id: string };
}

/**
 * 状态 id 里的 `~1` 是同路由多状态的内部消歧符，**不能原样给人看**：
 * 复核的人看到 `/owners/1/edit~1` 会以为那是个地址，去浏览器里找不到它。
 * 但两个同路由的状态又必须分得开，所以路由照常显示，变体单独标一个小角标。
 */
const plainRoute = (id: string): string => id.split("~")[0] ?? id;
const variantOf = (id: string): number => {
  const n = id.split("~")[1];
  return n ? Number(n) + 1 : 0;
};

const edgeKey = (from: string, to: string): string => `${from}->${to}`;

/**
 * 一个状态属于哪个模块。
 *
 * 和规格里 `computeModules` 用的是同一条规则：路由的第一段。哈希路由（`/#/search`）
 * 的第一段在 `#/` 之后——不剥掉它，整个单页应用会聚成一个叫 `#` 的模块。
 *
 * 复制这条规则而不是从服务端取聚类结果，是因为这张图要在**没有规格**的时候也画得出来：
 * 探索刚跑完、规格还没生成时，模块归属仍然是算得出来的事实。规格能提供的是**名字**，
 * 那才是要去服务端取的东西。
 */
const moduleOf = (route: string): string => {
  const s = route
    .replace(/^\/?#\//, "")
    .replace(/^\//, "")
    .split(/[/.\-]/)[0];
  return s || "/";
};

/**
 * 模块的配色。
 *
 * 十档循环，取自同一个色相环上等距的几个点——不是随机色：随机色会让相邻的两个模块
 * 撞成看不出差别的两种蓝，而人正是靠「这两块颜色不一样」来判断边界在哪的。
 * 只染节点的左边一条竖杠，不染整块：整块着色会盖过「走过 / 没走过」这条更要紧的区分。
 */
const MODULE_HUES = [210, 145, 35, 280, 0, 190, 95, 320, 55, 255];
const hueOf = (mod: string, all: string[]): number =>
  MODULE_HUES[Math.max(0, all.indexOf(mod)) % MODULE_HUES.length]!;

/**
 * 按「离入口几步」分层。
 *
 * 用 BFS 而不是力导向：力导向每次刷新布局都不一样，而**一张每次打开都长得不一样的图
 * 没法被记住**——复核的人第二次进来时得重新找一遍自己上次看的那一屏。
 * 分层布局是确定的，同一次运行永远画成同一个样子。
 */
function layout(graph: MapGraph): Map<string, { x: number; y: number }> {
  const entry = graph.entry ?? graph.states[0]?.id ?? "";
  const out = new Map<string, string[]>();
  for (const t of graph.transitions) {
    if (!t.to || t.from === t.to) continue;
    if (!out.has(t.from)) out.set(t.from, []);
    out.get(t.from)!.push(t.to);
  }

  const depth = new Map<string, number>([[entry, 0]]);
  let frontier = [entry];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier)
      for (const to of out.get(id) ?? [])
        if (!depth.has(to)) {
          depth.set(to, (depth.get(id) ?? 0) + 1);
          next.push(to);
        }
    frontier = next;
  }
  // 走不到的状态（探索里偶尔有）排在最后一列，而不是丢掉——丢掉就等于说它不存在。
  const maxDepth = Math.max(0, ...depth.values());
  for (const s of graph.states) if (!depth.has(s.id)) depth.set(s.id, maxDepth + 1);

  const byDepth = new Map<number, string[]>();
  for (const s of graph.states) {
    const d = depth.get(s.id) ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(s.id);
  }

  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, ids] of byDepth)
    ids.forEach((id, i) => pos.set(id, { x: d * 232, y: i * 116 - ((ids.length - 1) * 116) / 2 }));
  return pos;
}

interface StateData extends Record<string, unknown> {
  route: string;
  variant: number;
  title?: string;
  controls: number;
  isEntry: boolean;
  /** 从这一屏出发、走过但没有用例验的路有几条。 */
  missed: number;
  /** 在这一屏上看见、但一次都没进去的入口有几个。 */
  unseen: number;
  focused: boolean;
  /** 这一屏的业务名。规格给的，可能没有——没有就只显示路由。 */
  name?: string;
  /** 属于哪个模块，以及它的色相。按路由第一段算，和规格里的 computeModules 同一条规则。 */
  module: string;
  moduleName?: string;
  hue: number;
  /** 筛掉了：仍然画，但压暗。整块消失会让人以为图变小了，而实际上是他自己筛的。 */
  dimmed: boolean;
}

function StateNode({ data, selected }: NodeProps) {
  const t = useT();
  const d = data as StateData;
  return (
    <div
      className={cn(
        "relative w-[168px] overflow-hidden rounded-xl border-2 px-2.5 py-1.5 shadow-sm transition-opacity",
        d.isEntry ? "border-primary/60 bg-primary/5" : "border-border bg-card",
        (selected || d.focused) && "ring-2 ring-primary",
        d.dimmed && "opacity-25",
      )}
    >
      {/* 模块只染左边一条竖杠。整块着色会盖过「走过 / 没走过」——那条区分更要紧。 */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: `hsl(${d.hue} 65% 55%)` }}
        title={d.moduleName ?? d.module}
      />
      <Handle type="target" position={Position.Left} className="!h-2 !w-2" />
      <div className="flex items-baseline gap-1.5">
        <span
          className={cn(
            "truncate font-medium text-foreground",
            d.name ? "text-[12px]" : "font-mono text-[12px]",
          )}
          title={d.name ? d.route : undefined}
        >
          {d.name ?? d.route}
        </span>
        {d.variant > 0 && (
          <span
            className="shrink-0 rounded bg-muted px-1 font-mono text-[9px] text-muted-foreground"
            title={t("map.variantWhy")}
          >
            {t("map.variant", { n: d.variant })}
          </span>
        )}
      </div>
      {d.name && (
        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{d.route}</div>
      )}
      {d.title && <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{d.title}</div>}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px]">
        <span className="text-muted-foreground">{t("map.controls", { n: d.controls })}</span>
        {d.missed > 0 && (
          <span className="text-amber-600 dark:text-amber-500">{t("map.missedOut", { n: d.missed })}</span>
        )}
        {d.unseen > 0 && (
          <span className="text-muted-foreground/70">{t("map.unseenHere", { n: d.unseen })}</span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2" />
    </div>
  );
}

const nodeTypes = { state: StateNode };

const LEGEND_KEY = "productmap:legend";

/**
 * 图例。**它是这张图的一部分，不是装饰**——上面每一条都对应一个复核时要做的判断。
 *
 * 但它只在**第一次**是必需的：读过一遍之后，它就只是一块压在图上的东西
 * （实测它正好盖住了从缺口跳过来要看的那个节点）。所以可以收起，并且记住这个选择——
 * 每次进来都要再关一次的东西，跟不能关一样烦人。
 */
function Legend({ stopped }: { stopped?: string }) {
  const t = useT();
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(LEGEND_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen((v) => {
      try {
        localStorage.setItem(LEGEND_KEY, v ? "0" : "1");
      } catch {
        /* 隐私模式下存不了，那就只在这一次里生效 */
      }
      return !v;
    });
  };

  if (!open)
    return (
      <button
        onClick={toggle}
        className="rounded-lg border border-border bg-card/95 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
      >
        {t("map.legendCollapsed")}
      </button>
    );

  return (
    <div className="max-w-[290px] rounded-lg border border-border bg-card/95 p-2.5 text-[11px] shadow-sm backdrop-blur">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="font-medium text-foreground">{t("map.legendTitle")}</span>
        <button onClick={toggle} className="text-[10.5px] text-muted-foreground hover:text-foreground">
          {t("map.legendHide")}
        </button>
      </div>
      <ul className="space-y-1 text-muted-foreground">
        <li className="flex items-center gap-2">
          <svg width="26" height="6" aria-hidden>
            <line x1="0" y1="3" x2="26" y2="3" stroke="currentColor" strokeWidth="2" />
          </svg>
          {t("map.legendWalked")}
        </li>
        <li className="flex items-center gap-2 text-amber-600 dark:text-amber-500">
          <svg width="26" height="6" aria-hidden>
            <line x1="0" y1="3" x2="26" y2="3" stroke="currentColor" strokeWidth="2" />
          </svg>
          {t("map.legendMissedPre")}<span className="font-medium">{t("map.legendMissed")}</span> {t("map.legendClickable")}
        </li>
        <li className="flex items-center gap-2">
          <svg width="26" height="6" aria-hidden>
            <line
              x1="0"
              y1="3"
              x2="26"
              y2="3"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray="4 3"
              opacity="0.5"
            />
          </svg>
          {t("map.legendUnseen")}
        </li>
      </ul>
      {stopped && (
        <div className="mt-2 border-t border-border pt-1.5 text-[10.5px] text-muted-foreground">
          {t("map.stoppedBecause")}<span className="text-foreground">{stopped}</span>
          <div className="mt-0.5 opacity-80">{t("map.stoppedMeaning")}</div>
        </div>
      )}
    </div>
  );
}

/** 选中一屏或一条路之后，右边说清楚它是什么、缺什么。 */
function Detail({
  title,
  subtitle,
  controls,
  gaps,
  onClose,
}: {
  title: string;
  subtitle?: string;
  controls?: string[];
  gaps: MapGap[];
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="flex h-full w-[300px] flex-none flex-col overflow-hidden border-l border-border bg-card">
      <div className="flex items-start gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px] font-medium text-foreground">{title}</div>
          {subtitle && <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">{subtitle}</div>}
        </div>
        <button
          onClick={onClose}
          className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
          aria-label={t("map.close")}
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto px-3 py-2.5">
        {gaps.length > 0 && (
          <div>
            <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("map.detailGaps", { n: gaps.length })}
            </div>
            <ul className="space-y-1.5">
              {gaps.map((g, i) => (
                <li
                  key={i}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-[11px]",
                    g.reach === "missed"
                      ? "border-amber-500/40 bg-amber-500/5"
                      : "border-border bg-muted/40",
                  )}
                >
                  <div className="text-foreground">{g.what}</div>
                  {g.detail && (
                    <div className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground">
                      {g.detail}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {controls && controls.length > 0 && (
          <div>
            <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("map.detailControls", { n: controls.length })}
            </div>
            <ul className="space-y-0.5 font-mono text-[10.5px] text-muted-foreground">
              {controls.map((c, i) => (
                <li key={i} className="truncate" title={c}>
                  {c}
                </li>
              ))}
            </ul>
          </div>
        )}
        {gaps.length === 0 && !controls?.length && (
          <div className="text-[11px] text-muted-foreground">{t("map.detailNone")}</div>
        )}
      </div>
    </div>
  );
}

/**
 * @param focus 从缺口清单点过来时要高亮哪一处。形如 `edge:/a->/b` 或 `state:/a`。
 */
export function ProductMap({ focusRun, focus }: { focusRun?: string; focus?: string }) {
  const t = useT();
  const [runId, setRunId] = useState<string | undefined>(focusRun);
  const [graph, setGraph] = useState<MapGraph | undefined>();
  const [gaps, setGaps] = useState<MapGap[]>([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<{ kind: "state"; id: string } | { kind: "edge"; id: string } | null>(
    null,
  );
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  /**
   * 找东西的两个手段：按模块看，和搜。
   *
   * 13 屏时靠拖拽还行，几百个 URL 的真实产品不行——而这张图的价值恰恰在产品大的时候。
   * 筛掉的节点压暗而不是移除：整块消失会让人以为图变小了，而实际上是他自己筛的。
   */
  const [pickedModule, setPickedModule] = useState("");
  const [q, setQ] = useState("");
  /** 模块的人话名字。规格节点里有（聚类是算的，名字才交给模型）——没有就退回代码词。 */
  const [moduleNames, setModuleNames] = useState<Record<string, string>>({});
  /**
   * 每一屏的人话名字。
   *
   * 路由是**地址**，不是名字：`/owners/1/edit` 说得出它在哪，说不出它是什么。
   * 13 屏时靠路由还读得下去，几百个 URL 的产品上，一张按地址命名的图没人读得完。
   * 名字有就用，没有就仍然显示路由——不显示假名字，也不因为没名字就不画。
   */
  const [screenNames, setScreenNames] = useState<Record<string, string>>({});

  useEffect(() => setRunId(focusRun), [focusRun]);

  useEffect(() => {
    let live = true;
    void (async () => {
      setLoading(true);
      // 没指定运行时，退到复核列表里最近那一次——跟复核队列的默认落点保持一致，
      // 否则同一个抽屉里两个 tab 停在两次不同的运行上，人会以为数据对不上。
      let id = runId;
      if (!id) {
        const { runs } = (await fetch(`${API}/api/review`).then((r) => r.json())) as {
          runs?: Array<{ wfRunId: string }>;
        };
        id = runs?.[0]?.wfRunId;
        if (live && id) setRunId(id);
      }
      if (!id) {
        if (live) setLoading(false);
        return;
      }
      const { batch } = (await fetch(`${API}/api/review/${id}`).then((r) => r.json())) as {
        batch?: { graph?: MapGraph; gaps?: MapGap[] };
      };
      if (!live) return;
      setGraph(batch?.graph);
      setGaps(batch?.gaps ?? []);
      setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [runId]);

  /**
   * 模块的名字来自规格节点。
   *
   * 图上算得出模块**归属**（路由第一段），算不出它叫什么——「owners」是代码词，
   * 「查找、查看与新增/编辑宠物主人」才是人话。规格里这件事的分工是对的：
   * 聚类由程序算，名字交给模型。这里只是把那个名字取回来。
   */
  useEffect(() => {
    if (!runId) return;
    let live = true;
    fetch(`${API}/api/wf/runs/${runId}/nodes/spec`)
      .then((r) => r.json())
      .then(
        (d: {
          output?: {
            modules?: Array<{ id: string; name?: string }>;
            screens?: Array<{ id: string; name?: string }>;
          };
        }) => {
          if (!live) return;
          const m: Record<string, string> = {};
          for (const x of d.output?.modules ?? []) if (x.name && x.name !== x.id) m[x.id] = x.name;
          setModuleNames(m);
          const s: Record<string, string> = {};
          for (const x of d.output?.screens ?? []) if (x.name && x.name !== x.id) s[x.id] = x.name;
          setScreenNames(s);
        },
      )
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [runId]);

  /** 图上出现过的模块，按第一次出现的顺序——顺序稳定，配色才稳定。 */
  const moduleList = useMemo(() => {
    const seen: string[] = [];
    for (const s of graph?.states ?? []) {
      const m = moduleOf(plainRoute(s.id));
      if (!seen.includes(m)) seen.push(m);
    }
    return seen;
  }, [graph]);

  // 从缺口点过来的落点。解析一次就好，之后由人自己点。
  useEffect(() => {
    if (!focus) return;
    const at = focus.indexOf(":");
    if (at < 0) return;
    const kind = focus.slice(0, at);
    const id = focus.slice(at + 1);
    if (kind === "edge") setSel({ kind: "edge", id });
    else if (kind === "state") setSel({ kind: "state", id });
  }, [focus]);

  /** 哪些边有「走过但没验」的缺口——节点角标和边的颜色都靠它。 */
  const missedEdges = useMemo(() => {
    const m = new Map<string, MapGap[]>();
    for (const g of gaps)
      if (g.anchor?.kind === "edge") {
        const k = edgeKey(g.anchor.from, g.anchor.to);
        if (!m.has(k)) m.set(k, []);
        m.get(k)!.push(g);
      }
    return m;
  }, [gaps]);

  const stateGaps = useMemo(() => {
    const m = new Map<string, MapGap[]>();
    for (const g of gaps)
      if (g.anchor?.kind === "state") {
        if (!m.has(g.anchor.id)) m.set(g.anchor.id, []);
        m.get(g.anchor.id)!.push(g);
      }
    return m;
  }, [gaps]);

  const pos = useMemo(() => (graph ? layout(graph) : new Map<string, { x: number; y: number }>()), [graph]);

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], edges: [] as Edge[] };
    const missedOut = new Map<string, number>();
    for (const [k, list] of missedEdges) {
      const from = k.split("->")[0]!;
      missedOut.set(from, (missedOut.get(from) ?? 0) + list.length);
    }

    /**
     * 页面标题只在**它能区分不同的屏**时才显示。
     *
     * PetClinic 13 个状态的 <title> 全是「PetClinic :: a Spring Framework demonstration」。
     * 把它印在每个节点上，占掉一整行、传递零信息，还把真正有区别的东西（路由、控件数、
     * 缺口角标）挤小。一个到处都一样的字段不是标识，是噪音。
     */
    const titles = new Set(graph.states.map((s) => s.title ?? ""));
    const titleTells = titles.size > 1;

    const ns: Node[] = graph.states.map((s) => ({
      id: s.id,
      type: "state",
      position: pos.get(s.id) ?? { x: 0, y: 0 },
      data: {
        route: plainRoute(s.id),
        variant: variantOf(s.id),
        // 有业务名就把它放在第一行，路由退到第二行——路由仍然要在，它是找回这一屏的唯一凭据。
        name: screenNames[s.id],
        title: titleTells ? s.title : undefined,
        controls: s.controls?.length ?? 0,
        isEntry: s.id === graph.entry,
        missed: missedOut.get(s.id) ?? 0,
        unseen: stateGaps.get(s.id)?.length ?? 0,
        focused: sel?.kind === "state" && sel.id === s.id,
        module: moduleOf(plainRoute(s.id)),
        moduleName: moduleNames[moduleOf(plainRoute(s.id))],
        hue: hueOf(moduleOf(plainRoute(s.id)), moduleList),
        dimmed:
          (!!pickedModule && moduleOf(plainRoute(s.id)) !== pickedModule) ||
          (!!q.trim() &&
            !`${plainRoute(s.id)} ${s.title ?? ""} ${screenNames[s.id] ?? ""}`
              .toLowerCase()
              .includes(q.trim().toLowerCase())),
      } satisfies StateData,
    }));

    const seen = new Set<string>();
    const es: Edge[] = [];
    for (const tr of graph.transitions) {
      if (!tr.to || tr.from === tr.to) continue;
      const k = edgeKey(tr.from, tr.to);
      // 同一对状态之间可能有多条转移（不同动作）。图上画一条，
      // 细节留给右边的面板——一对节点之间画五条平行线，谁也读不出来。
      if (seen.has(k)) continue;
      seen.add(k);
      const missed = missedEdges.has(k);
      const walked = tr.walked !== false;
      const picked = sel?.kind === "edge" && sel.id === k;
      es.push({
        id: k,
        source: tr.from,
        target: tr.to,
        /**
         * **只有「没验的」和「选中的」带标签。**
         *
         * 一度写成「选中任何一条边时所有边都显示标签」，结果是 64 条边同时冒出文字，
         * 图变成一团字——而人点那一下是为了看清**一条**边，不是为了看清全部。
         */
        label: missed || picked ? tr.label : undefined,
        animated: picked,
        style: {
          // `--primary` 存的是 HSL 三元组（`221 83% 53%`），直接塞进 stroke 是无效值，
          // 无效值不会报错、只会静默退回默认灰——表现就是「点了，边没变色」。
          stroke: picked
            ? "hsl(var(--primary))"
            : missed
              ? "rgb(217 119 6)"
              : "var(--xy-edge-stroke, #b1b1b7)",
          strokeWidth: picked ? 3 : missed ? 2 : 1.4,
          strokeDasharray: walked ? undefined : "4 3",
          opacity: walked ? 1 : 0.45,
        },
        // 选中的那条要盖在别的边上面，否则它被压在一堆灰线底下，高亮了也看不见。
        zIndex: picked ? 10 : 0,
        labelStyle: { fontSize: 10 },
        // 边标签会压在节点和别的边上。给个底色，压住了也读得出——
        // 收短目标地址已经去掉了大半噪音，剩下的靠这个兜住。
        labelBgStyle: { fill: "hsl(var(--card))", fillOpacity: 0.92 },
        labelBgPadding: [3, 1] as [number, number],
        labelBgBorderRadius: 3,
        className: missed ? "cursor-pointer" : undefined,
      });
    }
    return { nodes: ns, edges: es };
  }, [graph, pos, missedEdges, stateGaps, sel, moduleNames, moduleList, pickedModule, q, screenNames]);

  const onNodeClick = useCallback((_: unknown, n: Node) => setSel({ kind: "state", id: n.id }), []);
  const onEdgeClick = useCallback((_: unknown, e: Edge) => setSel({ kind: "edge", id: e.id }), []);

  /**
   * 从缺口点过来时，**把那一处挪到视野里**。
   *
   * 只在右边面板里显示是不够的：人点「在地图上看它」，要的就是「它在图上哪儿」。
   * 高亮一条在视野外的边，等于没高亮。
   */
  /**
   * 视野归位。**两种情况都由这里管，不用 `fitView` 那个 prop。**
   *
   * 那个 prop 会在节点数组到位时再跑一次，把刚设好的落点冲掉——表现是
   * 「点了『在地图上看它』，图缩小了，什么也没高亮」。一件事只能有一个地方决定。
   */
  useEffect(() => {
    if (!flow || !nodes.length) return;
    if (!sel) {
      void flow.fitView({ padding: 0.1, maxZoom: 1, duration: 300 });
      return;
    }
    const ids = (sel.kind === "edge" ? sel.id.split("->") : [sel.id]).filter(Boolean);
    const pts = ids.map((id) => pos.get(id)).filter(Boolean) as Array<{ x: number; y: number }>;
    if (!pts.length) return;
    // 自己算中心而不是用 fitView({nodes})：后者实测会把整张图重新缩放一遍，
    // 结果是「点了一下，图更小了」——跟这个动作要达到的效果正好相反。
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length + 84; // +半个节点宽
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length + 22;
    void flow.setCenter(cx, cy, { zoom: 1, duration: 420 });
    // 只在落点变化时归位，不跟着 nodes 每次重算跑——否则人手动拖过之后
    // 会被无声地拽回去，那种「界面自己动」是最让人失去控制感的交互。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, sel, pos, nodes.length]);

  if (loading) return <div className="p-6 text-[12px] text-muted-foreground">{t("common.loading")}</div>;

  /**
   * 没有图的时候说清楚**为什么**没有，而不是画一张空画布。
   * 老的运行里探索节点没有留下图，那是「这次运行没有」，不是「这个产品没有地图」。
   */
  if (!graph || !graph.states.length)
    return (
      <div className="space-y-2 p-6 text-[12px] text-muted-foreground">
        <div className="text-foreground">{t("map.noGraph")}</div>
        <div>{t("map.noGraphWhy")}</div>
      </div>
    );

  const selState = sel?.kind === "state" ? graph.states.find((s) => s.id === sel.id) : undefined;
  const selEdgeGaps = sel?.kind === "edge" ? (missedEdges.get(sel.id) ?? []) : [];

  const moduleCount = new Map<string, number>();
  for (const s of graph.states) {
    const m = moduleOf(plainRoute(s.id));
    moduleCount.set(m, (moduleCount.get(m) ?? 0) + 1);
  }

  return (
    <div className="flex h-full min-h-[520px] w-full flex-col">
      {/*
        模块条 + 搜索。
        13 屏时靠拖拽还行，几百个 URL 的真实产品不行——而这张图的价值恰恰在产品大的时候。
        模块不是这里发明的：它是规格里按路由聚出来的一等实体，这里只是把同一条规则用在图上，
        并把规格给它起的人话名字取回来（「owners」是代码词，「查找宠物主人」才是人话）。
      */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <input
          className="w-44 rounded-md border border-border bg-card px-2 py-1 text-[11.5px]"
          placeholder={t("map.searchPlaceholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {t("map.modules")}
        </span>
        {moduleList.map((m) => (
          <button
            key={m}
            onClick={() => setPickedModule(pickedModule === m ? "" : m)}
            title={moduleNames[m] ? `${moduleNames[m]} · ${m}` : m}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px]",
              pickedModule === m ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
            )}
          >
            <span
              aria-hidden
              className="h-2 w-2 rounded-sm"
              style={{ background: `hsl(${hueOf(m, moduleList)} 65% 55%)` }}
            />
            <span className="max-w-[140px] truncate">{moduleNames[m] ?? m}</span>
            <span className="font-mono opacity-70">{moduleCount.get(m)}</span>
          </button>
        ))}
        {(pickedModule || q) && (
          <button
            className="rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-muted"
            onClick={() => {
              setPickedModule("");
              setQ("");
            }}
          >
            {t("cases.filterClear")}
          </button>
        )}
      </div>

    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={setFlow}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          /**
           * **缩放有下限。**默认的 fitView 会为了把 13 屏全塞进抽屉而一路缩小，
           * 结果是一张看得见轮廓、读不出字的图——而读不出字的图不解决任何问题。
           * 宁可让人拖着看：看不全比看不清好，因为看不全的时候人知道自己在拖，
           * 看不清的时候人以为自己看完了。
           */
          minZoom={0.45}
          fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
        >
          <Background />
          <Controls showInteractive={false} />
          <Panel position="top-left" className="!left-3 !top-3">
            <Legend stopped={stopReason(t, graph.stopped, graph.stoppedBecause)} />
          </Panel>
          <MiniMap pannable zoomable className="!bg-muted/70" style={{ width: 108, height: 68 }} />
        </ReactFlow>
      </div>
      {sel && (
        <Detail
          title={
            sel.kind === "state"
              ? plainRoute(sel.id) + (variantOf(sel.id) ? ` · ${t("map.variant", { n: variantOf(sel.id) })}` : "")
              : `${plainRoute(sel.id.split("->")[0]!)} → ${plainRoute(sel.id.split("->")[1]!)}`
          }
          subtitle={sel.kind === "state" ? selState?.title : t("map.detailWalkedPath")}
          controls={sel.kind === "state" ? selState?.controls : undefined}
          gaps={sel.kind === "state" ? (stateGaps.get(sel.id) ?? []) : selEdgeGaps}
          onClose={() => setSel(null)}
        />
      )}
    </div>
    </div>
  );
}
