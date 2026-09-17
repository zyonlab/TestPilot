import { useCallback, useEffect, useMemo, useState } from "react";
import { Artifact as ArtifactView } from "@/lib/artifact/registry";
import { StartSheet } from "@/components/StartSheet";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodesState,
  type Connection,
  type ReactFlowInstance,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Play,
  Square,
  RotateCw,
  StepForward,
  Save,
  Pencil,
  Trash2,
  X,
  History,
  Circle,
  CircleDot,
  SkipForward,
  Settings as SettingsIcon,
  FlaskConical,
  Globe,
  Plus,
  ChevronRight,
  ServerCog,
  Hand,
  SquareDashedMousePointer,
  Stethoscope,
  CircleDollarSign,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui";
import { safeGet, safeSet } from "@/lib/local";
import { useT, usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import { API_BASE, IS_OVERRIDDEN, resetApiBase } from "@/lib/base";
import {
  runFromHash,
  useWf,
  type Artifact,
  type GraphDef,
  type NodeRun,
  type NodeState,
  type Runtime,
  type TraceRow,
} from "@/lib/wf";
import { Drawer } from "@/components/overlay";
import { RunRail } from "@/components/RunRail";
import { SettingsDrawer } from "@/components/SettingsDrawer";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { ParamForm } from "@/components/ParamForm";
import { JsonView } from "@/components/JsonView";
import { DiagnoseDrawer, type DiagnoseScope } from "@/components/DiagnoseDrawer";
import { BudgetDrawer } from "@/components/BudgetDrawer";

/**
 * 项目下拉里「+ 新建项目」那一项的值。
 *
 * 用一个不可能与项目 id 相撞的哨兵，而不是空串——空串已经是「未选择项目」了，
 * 两个不同的意思共用一个值，是这个界面上已经犯过一次的错（运行下拉里的「新运行」
 * 也是 `value=""`）。
 */
import { MaterialPicker } from "@/components/MaterialPicker";
import { SpecDrawer } from "@/components/SpecDrawer";
import { StoriesDrawer } from "@/components/StoriesDrawer";
import { useStore } from "@/lib/store";

/**
 * The workflow canvas.
 *
 * Deliberately a *view of the execution graph* rather than a drawing of it: what a node
 * shows is what that node did on the selected run.
 *
 * Both the parameters and the shape are editable. Rewiring happens on a draft held in the
 * browser — half a rewiring is not a graph, and the gateway should never be asked to store
 * one — and saving produces a new version, so a finished run keeps pointing at the version
 * it actually ran. The version list next to it is what makes that pin readable: two numbers
 * and the line-by-line difference between them.
 */

const STATE_STYLE: Record<NodeState, string> = {
  idle: "border-border bg-card",
  running: "border-warn bg-warn-soft",
  done: "border-ok bg-ok-soft",
  failed: "border-bad bg-bad-soft",
  skipped: "border-border bg-muted",
  // Stopped in front of, not run: it reads as"waiting for you", not as a result.
  paused: "border-primary bg-primary-soft",
};

/** 状态片的配色。和边框同一套语义色，但它带的是字，不是只有色。 */
const STATE_CHIP: Record<string, string> = {
  idle: "bg-muted text-muted-foreground",
  running: "bg-warn text-primary-foreground",
  done: "bg-ok-soft text-ok",
  failed: "bg-bad text-primary-foreground",
  skipped: "bg-muted text-muted-foreground",
  paused: "bg-primary text-primary-foreground",
};

interface CardData extends Record<string, unknown> {
  label: string;
  /** registry 给的人话标题。没有就退回节点 id——退回，不是省略。 */
  title?: string;
  type: string;
  run: NodeRun;
  selected: boolean;
  editing: boolean;
  breakpoint: boolean;
  onToggleBreakpoint?: () => void;
  onDelete?: () => void;
}

const LEGEND_OPEN = "wf:legend";

/** 画布图例：每一行是「这个颜色 + 这个词 = 你该怎么想」。 */
function CanvasLegend() {
  const t = useT();
  /*
   * **默认收起。**
   *
   * 展开时它盖住右上那几个节点——而这条流水线是从左往右铺的，右上正是终点那几步。
   * 图例是学一次就不用再看的东西，让它默认挡住要看的东西，代价和收益是反的。
   * 展开状态记在本地：第一次点开的人下次进来还是展开的。
   */
  const [open, setOpen] = useState(() => safeGet(LEGEND_OPEN) === "1");
  const flip = () => {
    const v = !open;
    setOpen(v);
    safeSet(LEGEND_OPEN, v ? "1" : "0");
  };
  const states = ["running", "done", "failed", "paused", "skipped", "idle"] as const;
  if (!open)
    return (
      <button
        onClick={flip}
        className="rounded-lg border border-border bg-card px-2 py-1 text-[0.6875rem] text-muted-foreground shadow-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("wf.legend")}
      </button>
    );
  return (
    <div className="max-w-[14rem] rounded-lg border border-border bg-card p-2.5 shadow-sm">
      <div className="flex items-baseline gap-2">
        <span className="eyebrow">{t("wf.legend")}</span>
        <button
          onClick={flip}
          className="ml-auto text-[0.6875rem] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("wf.collapse")}
        </button>
      </div>
      <div className="mt-1.5 flex flex-col gap-1">
        {states.map((k) => (
          <div key={k} className="flex items-center gap-1.5 text-[0.6875rem]">
            <span className={cn("h-3 w-3 flex-none rounded-sm border-2", STATE_STYLE[k])} />
            <span className={cn("flex-none rounded px-1 font-mono", STATE_CHIP[k])}>{t(`wf.state.${k}`)}</span>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[0.6875rem] leading-relaxed text-muted-foreground">{t("wf.legendWhy")}</p>
    </div>
  );
}

function NodeCard({ data }: NodeProps) {
  const t = useT();
  const d = data as CardData;
  const run = d.run;
  return (
    <div
      className={cn(
        "min-w-[11.875rem] rounded-xl border-2 px-3 py-2 shadow-sm transition-colors",
        STATE_STYLE[run.state],
        d.selected && "ring-2 ring-primary",
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2" />
      <div className="flex items-center gap-1">
        {/* Set where the run should stop from the node itself: a breakpoint is about this
            node, and a list of node names in a side panel is a second place to keep in
            sync with the graph. */}
        <button
          className={cn(
            "shrink-0 transition-colors",
            d.breakpoint ? "text-bad" : "text-muted-foreground/40 hover:text-bad",
          )}
          title="breakpoint"
          onClick={(e) => {
            e.stopPropagation();
            d.onToggleBreakpoint?.();
          }}
        >
          {d.breakpoint ? <CircleDot className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
        </button>
        {/* 人话标题在上，节点 id 在下：`gate.textcase` 是给机器读的，
            而 registry 里那句"Gate: test design" 一直都发过来了，只是没人画。 */}
        <div className="font-display text-[0.8125rem] font-medium text-foreground">{d.title || d.label}</div>
        {d.editing && (
          <button
            className="ml-auto text-muted-foreground hover:text-bad"
            title="remove"
            onClick={(e) => {
              e.stopPropagation();
              d.onDelete?.();
            }}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 font-mono text-[0.6875rem] text-muted-foreground">
        <span className="min-w-0 truncate">{d.title ? `${d.label} · ${d.type}` : d.type}</span>
        {/*
          **状态要有一个词，不能只有一种颜色。**
          `03 §9.6` 把这一条写成全局约定，而节点卡此前只染边框和底色：
          红绿色觉差异的人分不出 done 和 failed，截图变成灰度之后谁都分不出，
          而这张图最常见的用法恰恰是截下来贴进工单。
        */}
        <span className={cn("flex-none rounded px-1", STATE_CHIP[run.state])}>{t(`wf.state.${run.state}`)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.6875rem] text-muted-foreground">
        {run.ms !== undefined && <span>{(run.ms / 1000).toFixed(1)}s</span>}
        {run.calls ? <span>{run.calls} calls</span> : null}
        {run.tokens ? <span>{run.tokens} tok</span> : null}
        {run.gate && <span className="text-foreground">gate {Math.round(run.gate.score * 100)}%</span>}
      </div>
      {run.error && <div className="mt-1 line-clamp-2 text-[0.6875rem] text-bad">{run.error}</div>}
      <Handle type="source" position={Position.Right} className="!h-2 !w-2" />
    </div>
  );
}

// Named `nodeCards` because the store also has `nodeTypes`: the palette of node kinds the
// gateway offers, which is a different thing entirely.
/**
 * An artefact card: what a node produced, hanging under it on the canvas.
 *
 * Aggregate plus a sample, never the whole batch — a hundred case cards on a canvas is
 * worse than a hundred rows in a table, because the table can be filtered and scanned.
 * Clicking through is what the table is for.
 */
function ArtifactCard({ data }: NodeProps) {
  const d = data as unknown as Artifact & { onOpen?: () => void };
  return (
    <div
      className={cn(
        "min-w-[10.5rem] max-w-[11.875rem] rounded-xl border bg-card px-3 py-2 shadow-sm",
        d.tone === "warn" ? "border-warn" : "border-border",
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !opacity-0" />
      <div className="text-[0.75rem] text-muted-foreground">{d.title}</div>
      <div
        className={cn(
          "font-mono text-[1.375rem] leading-tight tabular-nums",
          d.tone === "warn" ? "text-warn" : "text-primary",
        )}
      >
        {d.value}
      </div>
      <div className="font-mono text-[0.6875rem] leading-snug text-muted-foreground">{d.sub}</div>
      {d.samples && (
        <div className="mt-1 flex flex-col gap-0.5">
          {d.samples.map((x: string, i: number) => (
            <div
              key={i}
              className="truncate rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground"
            >
              {x}
            </div>
          ))}
        </div>
      )}
      {d.opens && (
        <button
          onClick={() => d.onOpen?.()}
          className="mt-1 block cursor-pointer text-[0.6875rem] text-primary hover:underline"
        >
          {d.opens.label} →
        </button>
      )}
    </div>
  );
}

const nodeCards = { card: NodeCard, artifact: ArtifactCard };

/**
 * 运行的时间戳，短到能放进一个下拉框。
 *
 * 年份不写：同一个下拉里几乎不会跨年，而多出来的四个字符会把真正要比的
 * 「几号几点」挤出可视范围。秒也不写——同一分钟内起两次运行的情况不存在。
 */
/**
 * 上限用掉了多少，压成一格。
 *
 * 只在这次运行真的给了上限时才出现：没有上限的时候写「3/—」是在暗示有个分母。
 */
function budgetLabel(r: { budget?: { calls?: number }; spend?: { calls?: number } }): string {
  const cap = r.budget?.calls;
  if (!cap) return "";
  return `${r.spend?.calls ?? 0}/${cap} calls`;
}

/**
 * 一份节点产出里认得出来的那些产物。
 *
 * 只挑**这一版登记过**的类型，其余照旧交给 JSON 视图。加一种呈现是往登记处加一条，
 * 不是改这里——这个函数只负责认，不负责画。
 */
function artifactsIn(output: unknown): Array<{ kind: string; value: unknown }> {
  if (!output || typeof output !== "object") return [];
  const o = output as { gate?: { findings?: unknown[] } };
  const out: Array<{ kind: string; value: unknown }> = [];
  if (Array.isArray(o.gate?.findings) && o.gate.findings.length)
    out.push({ kind: "findings", value: o.gate.findings });
  return out;
}

function runStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Separates one kind of control from another: scope, this run, this graph, this harness. */
const Divider = () => <span className="mx-0.5 h-5 w-px flex-none bg-border" />;

/**
 * Which material card is open, held in the URL.
 *
 * Removing the navigation should not remove the ability to send someone a link: `#/?open=cases`
 * still means"look at that batch of cases". It is a query on the one address rather than an
 * address of its own, because the card is something on top of the workspace, not a place
 * instead of it.
 */
function useOpenSurface(): [string, string, (id: string) => void] {
  const params = () => new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const read = () => params().get("open") ?? "";
  const readFocus = () => params().get("at") ?? "";
  const [id, setId] = useState(read);
  const [focus, setFocus] = useState(readFocus);
  useEffect(() => {
    const onHash = () => {
      setId(read());
      setFocus(readFocus());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /**
   * 换卡时保住 `run`，扔掉别的。
   *
   * 此前这里直接把整个查询串换成 `?open=xxx`，于是从产品地图切到复核队列，
   * 地址里的 `run` 就没了——人正在看的那一次运行悄悄变回「最近那一次」。
   * 一个只有一个地址的应用，地址里的那几个参数就是它全部的状态，不能顺手清空。
   *
   * `at`（地图落点）和筛选条件反过来要清掉：它们属于上一张卡，
   * 留着会让新打开的卡停在一个跟这次点击无关的地方。
   */
  const set = (next: string) => {
    const [path, query] = window.location.hash.split("?");
    const keep = new URLSearchParams();
    const run = new URLSearchParams(query ?? "").get("run");
    if (run) keep.set("run", run);
    if (next) keep.set("open", next);
    const q = keep.toString();
    window.location.hash = `${path || "#/"}${q ? `?${q}` : ""}`;
    setId(next);
    setFocus("");
  };
  return [id, focus, set];
}

/**
 * Layered layout: depth from the graph's edges, siblings stacked.
 *
 * A hand-rolled layout rather than a layout engine because these graphs are pipelines with
 * a handful of nodes; the engine earns its place when they branch.
 */
function layout(def: GraphDef): Record<string, { x: number; y: number }> {
  const depth = new Map<string, number>(def.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < def.nodes.length; pass++)
    for (const e of def.edges) depth.set(e.to, Math.max(depth.get(e.to) ?? 0, (depth.get(e.from) ?? 0) + 1));

  const perDepth = new Map<number, number>();
  const pos: Record<string, { x: number; y: number }> = {};
  for (const n of def.nodes) {
    const d = depth.get(n.id) ?? 0;
    const row = perDepth.get(d) ?? 0;
    perDepth.set(d, row + 1);
    // A node that was placed by hand stays where it was put; the rest get laid out.
    pos[n.id] = n.pos ?? { x: d * 260, y: row * 120 };
  }
  return pos;
}

/**
 * Versions, and what changed between two of them.
 *
 * Kept next to the canvas rather than on a page of its own: the question"what did I change
 * since the run that scored 89%" is asked while looking at the graph, not away from it.
 */
function VersionPanel({
  versions,
  diffLines,
  onDiff,
  onRunVersion,
}: {
  versions: Array<{ version: number; savedAt: string; note?: string }>;
  diffLines: string[];
  onDiff: (from: number, to: number) => void;
  /** 用某一版起一次运行。没有它，「复现半个月前那一版」只能靠 curl。 */
  onRunVersion?: (version: number) => void;
}) {
  const t = useT();
  const [from, setFrom] = useState<number | undefined>();
  const [to, setTo] = useState<number | undefined>();

  useEffect(() => {
    // Default to"the newest change": the comparison people want nine times out of ten.
    setTo(versions[0]?.version);
    setFrom(versions[1]?.version ?? versions[0]?.version);
  }, [versions]);

  if (versions.length === 0) return null;
  const pick = (value: number | undefined, set: (v: number) => void) => (
    <select
      className="min-w-0 flex-1 rounded border border-border bg-card px-1 py-0.5 font-mono text-[0.6875rem]"
      value={value ?? ""}
      onChange={(e) => set(Number(e.target.value))}
    >
      {versions.map((v) => (
        <option key={v.version} value={v.version}>
          v{v.version}
          {v.savedAt ? ` · ${new Date(v.savedAt).toLocaleString()}` : ""}
          {v.note ? ` · ${v.note}` : ""}
        </option>
      ))}
    </select>
  );

  return (
    <div className="border-b border-border p-3">
      <div className="mb-1 flex items-center gap-1.5">
        <History className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[0.6875rem] font-medium text-muted-foreground">{t("wf.versions")}</span>
      </div>
      <div className="flex items-center gap-1">
        {pick(from, setFrom)}
        <span className="text-[0.6875rem] text-muted-foreground">→</span>
        {pick(to, setTo)}
        <Button
          className="whitespace-nowrap"
          onClick={() => from !== undefined && to !== undefined && onDiff(from, to)}
          disabled={from === undefined || to === undefined}
        >
          {t("wf.diff")}
        </Button>
      </div>
      {/* 用左边那一版再跑一次。
          服务端的 `startRun` 一直收 `graphVersion`，而界面上没有任何入口——
          想复现半个月前那一版的结果，唯一的路是 curl。 */}
      {from !== undefined && onRunVersion && (
        <div className="mt-1.5">
          <Button
            className="whitespace-nowrap"
            onClick={() => onRunVersion(from)}
            title={t("wf.runVersionWhy", { ver: String(from) })}
          >
            <Play className="h-3.5 w-3.5" />
            {t("wf.runVersion", { ver: String(from) })}
          </Button>
        </div>
      )}
      {diffLines.length > 0 && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[0.6875rem] leading-relaxed text-foreground">
          {diffLines.join("\n")}
        </pre>
      )}
    </div>
  );
}

/**
 * The harness layer, as a trace rather than a scoreboard.
 *
 * Counters ("21 calls, 35.8k tokens") are not something anyone can act on. What gets asked
 * when a run comes back wrong is which nodes it entered, what it sent, whether a reply was
 * cut off, and what the gate made of it — a sequence, so it is drawn as one. Every line
 * here comes from lineage, which has recorded all of it since day one.
 */
function TracePanel({ rows, open, onToggle }: { rows: TraceRow[]; open: boolean; onToggle: () => void }) {
  const t = useT();
  const [filter, setFilter] = useState<"all" | "model" | "node" | "gate">("all");
  const shown = rows.filter(
    (r) => filter === "all" || r.kind === filter || (filter === "node" && r.kind === "run"),
  );
  const KIND: Record<TraceRow["kind"], string> = {
    run: "RUN",
    node: "NODE",
    model: "MODEL",
    gate: "GATE",
    err: "FLAG",
  };
  return (
    <div className={cn("flex flex-col border-t border-border bg-card", open && "h-[220px]")}>
      <div className="flex flex-none items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-[0.75rem] font-semibold">{t("wf.trace")}</span>
        {open &&
          (["all", "model", "node", "gate"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={cn(
                "cursor-pointer rounded px-2 py-0.5 text-[0.75rem]",
                filter === k ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {t(`wf.trace.${k}`)}
            </button>
          ))}
        <button onClick={onToggle} className="ml-auto cursor-pointer text-[0.75rem] text-muted-foreground">
          {open ? t("wf.collapse") : t("wf.expand")}
        </button>
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-auto">
          {shown.length === 0 && (
            <div className="px-3 py-2 text-[0.75rem] text-muted-foreground">{t("wf.traceEmpty")}</div>
          )}
          {shown.map((r, i) => (
            <div
              key={i}
              className="grid grid-cols-[3.625rem_3.375rem_7.5rem_minmax(0,1fr)_auto] items-baseline gap-2.5 border-b border-border/40 px-3 py-1 text-[0.75rem]"
            >
              <span className="font-mono text-[0.6875rem] text-muted-foreground/80">{r.ts}</span>
              <span
                className={cn(
                  "font-mono text-[0.6875rem]",
                  r.kind === "model" && "text-warn",
                  r.kind === "gate" && "text-ok",
                  r.kind === "err" && "text-bad",
                  r.kind === "node" && "text-primary",
                )}
              >
                {KIND[r.kind]}
              </span>
              <span className="truncate font-mono text-[0.6875rem] text-primary">{r.node}</span>
              <span className="truncate text-muted-foreground">{r.text}</span>
              <span className="whitespace-nowrap font-mono text-[0.6875rem] text-muted-foreground/80">
                {r.right}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The harness runtime rail.
 *
 * The canvas says what the pipeline produced; this says what the machinery did to produce
 * it. Admission, budget, ablation, prompt fingerprint, failure attribution and who settled
 * each verdict are properties of the harness, not of the product under test — and they used
 * to exist only as lines scrolling past in a log, which is the wrong home for state you
 * need to read at a glance mid-run.
 *
 * Every gauge here is a real reading. A cap that was never set shows the spend with no
 * denominator rather than inventing one, and a run with no execution node simply has no
 * attribution gauges — a"0 infra · 0 assert" would claim the run checked and found none.
 */
function Gauge({
  label,
  value,
  tone,
  frac,
  title,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
  frac?: number;
  title?: string;
}) {
  return (
    <div className="min-w-[6.5rem] flex-none" title={title}>
      <div className="font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div
        className={cn(
          "mt-0.5 font-mono text-[0.8125rem] tabular-nums",
          tone === "good" && "text-ok",
          tone === "warn" && "text-warn",
          tone === "bad" && "text-bad",
          !tone && "text-foreground",
        )}
      >
        {value}
      </div>
      {frac !== undefined && (
        <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-muted">
          <i
            className={cn("block h-full rounded-full", frac > 0.85 ? "bg-bad" : "bg-primary")}
            style={{ width: `${Math.min(100, Math.round(frac * 100))}%` }}
          />
        </div>
      )}
    </div>
  );
}

function RuntimeRail({
  rt,
  nodeRuns,
  open,
  onToggle,
}: {
  rt: Runtime;
  nodeRuns: Record<string, NodeRun>;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const min = (ms: number) => `${Math.round(ms / 60000)}`;
  const failEntries = Object.entries(rt.fails);
  const judged = rt.decided.machine + rt.decided.judge;

  /**
   * 最贵的一步，和最慢的一步。
   *
   * 这两个此前都只能靠问模型——网关自己读了 spend，再喂给模型用一句话念出来。让一个 LLM
   * 读一张表念给人听，说明的是这张表没被显示，不是这里需要模型。
   *
   * 两个数分开给：花的 token 最多和耗时最久常常不是同一步（一次视觉判断一步就要八九十秒，
   * token 却很少），合成一个「最贵」会把两种完全不同的问题读成一种。
   */
  const ranked = Object.entries(nodeRuns).filter(([, n]) => (n.tokens ?? 0) > 0 || (n.ms ?? 0) > 0);
  const priciest = ranked.slice().sort((a, b) => (b[1].tokens ?? 0) - (a[1].tokens ?? 0))[0];
  const slowest = ranked.slice().sort((a, b) => (b[1].ms ?? 0) - (a[1].ms ?? 0))[0];

  return (
    <div className="flex-none border-t border-border bg-card">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-[0.75rem] font-semibold">{t("wf.runtime")}</span>
        <span className="text-[0.6875rem] text-muted-foreground">{t("wf.runtimeWhy")}</span>
        <button onClick={onToggle} className="ml-auto cursor-pointer text-[0.75rem] text-muted-foreground">
          {open ? t("wf.collapse") : t("wf.expand")}
        </button>
      </div>
      {open && (
        <div className="flex gap-5 overflow-x-auto border-t border-border/60 px-3 py-2">
          <Gauge
            label={t("wf.rtGate")}
            value={`${rt.gate.active} / ${rt.gate.limit}${rt.gate.waiting ? t("wf.gateWaiting", { n: rt.gate.waiting }) : ""}`}
            tone={rt.gate.waiting ? "warn" : rt.gate.active ? "warn" : "good"}
            title={t("wf.rtGateWhy")}
          />
          <Gauge
            label={t("wf.rtCalls")}
            value={rt.budget.calls ? `${rt.spend.calls} / ${rt.budget.calls}` : String(rt.spend.calls)}
            frac={rt.budget.calls ? rt.spend.calls / rt.budget.calls : undefined}
            title={t("wf.rtBudgetWhy")}
          />
          <Gauge label={t("wf.rtTokens")} value={`${(rt.spend.tokens / 1000).toFixed(1)}k`} />
          <Gauge
            label={t("wf.rtTime")}
            value={
              rt.budget.ms ? `${min(rt.spend.ms)} / ${min(rt.budget.ms)} min` : `${min(rt.spend.ms)} min`
            }
            frac={rt.budget.ms ? rt.spend.ms / rt.budget.ms : undefined}
          />
          <Gauge
            label={t("wf.rtAblate")}
            value={rt.ablate.length ? rt.ablate.join(",") : t("wf.rtAblateNone")}
            tone={rt.ablate.length ? "warn" : "good"}
            title={t("wf.rtAblateWhy")}
          />
          <Gauge label={t("wf.rtPrompts")} value={rt.prompts || "—"} title={t("wf.rtPromptsWhy")} />
          {priciest && (
            <Gauge
              label={t("wf.rtPriciest")}
              value={`${priciest[0]} · ${((priciest[1].tokens ?? 0) / 1000).toFixed(1)}k`}
              title={t("wf.rtPriciestWhy")}
            />
          )}
          {slowest && slowest[0] !== priciest?.[0] && (
            <Gauge
              label={t("wf.rtSlowest")}
              value={`${slowest[0]} · ${Math.round((slowest[1].ms ?? 0) / 1000)}s`}
              title={t("wf.rtSlowestWhy")}
            />
          )}
          {failEntries.length > 0 && (
            <Gauge
              label={t("wf.rtFails")}
              value={failEntries.map(([k, v]) => `${k} ${v}`).join(" · ")}
              tone="warn"
              title={t("wf.rtFailsWhy")}
            />
          )}
          {judged > 0 && (
            <Gauge
              label={t("wf.rtDecided")}
              value={`machine ${rt.decided.machine} · judge ${rt.decided.judge}`}
              tone={rt.decided.machine === 0 ? "warn" : "good"}
              title={t("wf.rtDecidedWhy")}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 画布这一屏——`?open=canvas` 落到搬迁空态，画布本身不再挂载。
 *
 * 理由是 `docs/v3/history/00-架构.md` §1/§2 的那一刀：工作流的编排与运行整个换成
 * PenguinHarness——session、events、trace 都在 `:7364`，而画布画的正是这些。
 * §6 也点名了这一条：US-14（画布）是 22 条用户故事里**变差的两条之一**，
 * 补回的方式是 `run_pipeline` emit 节点事件 + `{stopAfter, from}` 参数，
 * 而不是在这里再维护一张自己的图。
 *
 * 地址保留能打开（`App.tsx` 把没有 `?open=` 但带 `?run=` 的地址也落到这里），
 * 因为「看这一次运行」这个链接被人存过、发过。
 *
 * **v3 Phase 3：这条拦截本身已经搬去 `App.tsx`**（原来这里有一个 `WorkspacePage`，
 * 函数体只是转发 `<MigratedToPenguin />`——那一层转发没有必要，应用入口直接判断
 * 「这条地址该看什么」就够了）。下面 `LegacyCanvasPage` 那一千多行**没有删**：
 * 退役是 Phase 3 剩下那部分的事，这里只是确认了没有任何路径还引用它。
 * 留着它也留着它的全部注释——那些理由在 Penguin 上重做这一屏时仍然有用。
 */

/** Phase 3：入口已经断开（曾经的 `WorkspacePage`，现已删除；见上方注释），保留代码与它的理由注释。 */
export function LegacyCanvasPage() {
  const t = useT();
  /**
   * 诊断打开在哪个对象上。
   *
   * 按需打开，而不是一条常驻的对话栏：这个产品不靠聊天驱动，跑什么、什么时候跑
   * 由画布上的按钮决定。答案附着在它解释的那个东西旁边。
   */
  const [diagnosing, setDiagnosing] = useState<DiagnoseScope | undefined>();
  const [budgetOpen, setBudgetOpen] = useState(false);
  const {
    graphs,
    selectedGraph,
    selectGraph,
    runs,
    wfRunId,
    runStatus,
    stoppedBy,
    nodeRuns,
    selectedNode,
    nodeDetail,
    log,
    ws,
    error,
    load,
    selectRun,
    selectRunNone,
    cancelNote,
    selectNode,
    start,
    cancel,
    breakpoints,
    pausedAt,
    toggleBreakpoint,
    resume,
    connect,
    saveNodeParams,
    issues,
    nodeTypes,
    draft: topoDraft,
    runGraph,
    resumeFrom,
    resumeDone,
    artifacts,
    loadArtifacts,
    trace,
    loadTrace,
    runtime,
    runContext,
    outputs,
    loadGate,
    syncToProject,
    continuations,
    continueInto,
    versions,
    diffLines,
    beginEdit,
    discardEdit,
    editDraft,
    saveTopology,
    loadVersions,
    loadDiff,
  } = useWf();

  useEffect(() => {
    void load();
    connect();
  }, [load, connect]);

  // The admission gate moves while nothing else on the page does — a run that looks stalled
  // is usually one waiting for the model slot. Polled, because it is not an event: it is a
  // level, and a level that only updates on transitions is wrong most of the time.
  useEffect(() => {
    void loadGate();
    const id = setInterval(() => void loadGate(), 4000);
    return () => clearInterval(id);
  }, [loadGate]);

  const saved = graphs.find((g) => g.id === selectedGraph);
  // While editing, everything on screen reads from the draft: one source of truth beats a
  // canvas that shows the old wiring and a panel that shows the new one.
  // 没在编辑、又打开着一次旧运行时，画的是**那次运行钉住的那一版**（见 wf.ts 的 runGraph）。
  const def = topoDraft ?? runGraph ?? saved;
  const pinnedOld = !topoDraft && !!runGraph;
  const editing = !!topoDraft;

  useEffect(() => {
    void loadVersions();
  }, [selectedGraph, loadVersions]);

  const node = def?.nodes.find((n) => n.id === selectedNode);
  /**
   * 上游还没产出时，这一步重跑不了。
   *
   * 服务端已经拦在起跑前（`/rerun` 返回 409），但两个按钮此前在任何节点上都是亮的：
   * 人得先点一下、吃一个错误，才知道点不得。产物就在 `outputs` 里，判据是同一份，
   * 那就别等到点下去才说。
   */
  /** 第几步 / 共几步、正在跑哪一步、这一步已经跑了多久。 */
  const progress = (() => {
    const total = def?.nodes.length ?? 0;
    const done = Object.values(nodeRuns).filter((r) => r.state === "done").length;
    const at = def?.nodes.find((n) => nodeRuns[n.id]?.state === "running")?.id ?? "";
    return { total, done, at, ms: at ? (nodeRuns[at]?.ms ?? 0) : 0 };
  })();

  const missingUp = (() => {
    if (!selectedNode || !def || !wfRunId) return "";
    const ups = def.edges.filter((e) => e.to === selectedNode).map((e) => e.from);
    return ups.find((u) => outputs[u] === undefined) ?? "";
  })();
  const [draft, setDraft] = useState("");
  /**
   * 参数草稿里当前选了哪几份材料。
   *
   * 从**草稿**读而不是从已保存的参数读：勾选和文本框写的是同一个字段，勾了之后没保存时
   * 两边要说同一件事，否则勾选框会在下一次渲染里把自己弹回去。
   */
  const paths: string[] = (() => {
    try {
      const p = JSON.parse(draft || "{}") as { paths?: unknown; path?: unknown };
      if (Array.isArray(p.paths)) return p.paths.filter((x): x is string => typeof x === "string");
      return typeof p.path === "string" ? [p.path] : [];
    } catch {
      return [];
    }
  })();
  const [dirty, setDirty] = useState(false);
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  /**
   * Which material card is open, and the two panels that used to be open by default.
   *
   * The rail and the trace are worth a permanent column only while something is running;
   * the rest of the time they are two more things on a screen that already had six. They
   * open themselves when a run starts and stay wherever the person last put them.
   */
  /**
   * `spec` 与 `stories` 不在 `SURFACES` 里——它们是画布自己的两个抽屉，
   * 所以 `surfaceById` 找不到它们，AppShell 会退回渲染画布，抽屉照常打开。
   * 其余的 `open=` 值现在由左导航接管，见 App.tsx 的 AppShell。
   */
  const [openId, , setOpenId] = useOpenSurface();
  const [traceOpen, setTraceOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  /** 保存拓扑时随手写的一句话，落到版本记录上。 */
  const [saveNote, setSaveNote] = useState("");
  /** 起跑单开着没有。它只影响这一次运行，不动图。 */
  const [startSheet, setStartSheet] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  /**
   * 拖画布，还是框选节点——一次只能是其中一件事。
   *
   * 在同一个手势上同时挂两种含义，人得先猜自己现在处在哪种模式；画图工具几十年前就把这件事
   * 解决了：给两个按钮，让模式看得见。默认是拖动，因为看图的次数远多于改图。
   */
  const [tool, setTool] = useState<"pan" | "select">("pan");
  /** 框选出来的那几步。单选走同一条路，只是集合大小是 1。 */
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    if (runStatus === "running") {
      setRailOpen(true);
      setTraceOpen(true);
    }
  }, [runStatus]);

  // The editor follows the selection until it is touched; then it stays put, because
  // silently discarding someone's half-typed change is worse than a stale-looking panel.
  useEffect(() => {
    setDraft(JSON.stringify(node?.params ?? {}, null, 2));
    setDirty(false);
  }, [node?.id, node?.params]);

  const save = async () => {
    try {
      await saveNodeParams(selectedNode, JSON.parse(draft));
      setDirty(false);
    } catch {
      /* the store surfaces the message */
    }
  };

  const removeNode = useCallback(
    (id: string) =>
      editDraft((d) => ({
        ...d,
        nodes: d.nodes.filter((n) => n.id !== id),
        // A wire to a node that is gone is not a wire; drop them with it rather than
        // letting the gateway reject the save with an error about something invisible.
        edges: d.edges.filter((e) => e.from !== id && e.to !== id),
      })),
    [editDraft],
  );

  const addNode = useCallback(
    (type: string) => {
      editDraft((d) => {
        const base = type.split(".").pop() ?? "node";
        let id = base;
        for (let i = 2; d.nodes.some((n) => n.id === id); i++) id = `${base}${i}`;
        // Placed to the right of where things actually are, which is not the same as the
        // rightmost stored position: nodes that have never been dragged have no stored
        // position at all, and reading zero from them drops the new node onto the second
        // column of the graph.
        const placed = Object.values(layout(d));
        const x = placed.length ? Math.max(...placed.map((p) => p.x)) + 260 : 0;
        return { ...d, nodes: [...d.nodes, { id, type, pos: { x, y: 0 } }] };
      });
    },
    [editDraft],
  );

  // A node dropped outside the viewport looks like nothing happened. Refit when the count
  // grows — after the render that added it, so the frame includes it rather than the graph
  // as it was a moment ago.
  const nodeCount = def?.nodes.length ?? 0;
  useEffect(() => {
    if (!editing || !flow) return;
    // One beat late on purpose: React Flow frames measured nodes, and the node that was
    // just added has not been measured yet at the moment the effect runs — refitting
    // immediately would frame the graph as it was and look like nothing happened.
    const timer = setTimeout(() => flow.fitView({ duration: 300, padding: 0.2 }), 150);
    return () => clearTimeout(timer);
  }, [nodeCount, editing, flow]);

  const onConnect = useCallback(
    (c: Connection) =>
      editDraft((d) =>
        !c.source || !c.target || d.edges.some((e) => e.from === c.source && e.to === c.target)
          ? d
          : { ...d, edges: [...d.edges, { from: c.source, to: c.target }] },
      ),
    [editDraft],
  );

  const onEdgesDelete = useCallback(
    (removed: Edge[]) =>
      editDraft((d) => ({
        ...d,
        edges: d.edges.filter((e) => !removed.some((r) => r.source === e.from && r.target === e.to)),
      })),
    [editDraft],
  );

  const onNodeDragStop = useCallback(
    (_: unknown, n: Node) =>
      editDraft((d) => ({
        ...d,
        nodes: d.nodes.map((x) =>
          x.id === n.id ? { ...x, pos: { x: Math.round(n.position.x), y: Math.round(n.position.y) } } : x,
        ),
      })),
    [editDraft],
  );

  const projects = useStore((st) => st.projects);
  const activeProjectId = useStore((st) => st.activeProjectId);

  /**
   * 项目挂了材料，但图上的 source.spec 自己写死了 paths/text——这次跑的是图上那份。
   * 服务端的注入规则就是「只在节点自己没说的时候注入」，这里照着同一条规则先算一遍，
   * 好让人在按下去之前就知道。
   */
  const pinnedOverProject = (() => {
    const proj = projects.find((p) => p.id === activeProjectId);
    if (!proj?.materials?.length || !def) return "";
    for (const n of def.nodes) {
      if (n.type !== "source.spec") continue;
      const p = (n.params ?? {}) as { paths?: unknown; path?: unknown; text?: unknown };
      const said =
        (Array.isArray(p.paths) && p.paths.length ? (p.paths as string[]).join(",") : "") ||
        (typeof p.path === "string" ? p.path : "") ||
        (p.text ? t("wf.textOnGraph") : "");
      if (said) return said;
    }
    return "";
  })();

  const selectProject = useStore((st) => st.selectProject);
  /**
   * 建项目此前只长在设置抽屉里——也就是说建第一个项目要先想到去翻设置。
   * 它是这个产品的第一个动作，不该藏在齿轮后面。
   */
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const loadData = useStore((st) => st.loadData);
  // The workspace is now the only page, so it is what loads the project list. It used to
  // arrive from the layout that wrapped every route.
  useEffect(() => {
    void loadData();
  }, [loadData]);

  // 面包屑说 项目 › 图 › 运行，那切项目就得真的换掉右边两级里跟项目有关的那一级。
  useEffect(() => {
    void syncToProject(activeProjectId);
  }, [activeProjectId, syncToProject]);

  /**
   * 跟住地址栏里的 `run=`。
   *
   * 光在启动时读一次不够：`#/review/<id>` 这个短写法要先被规整成 `run=`，
   * 而规整发生在 App 的 effect 里，比这里的 `load()` 晚——实测的表现是
   * 「打开别人发来的链接，停在完全不相干的一次运行上」。
   * 改成跟着 `runs` 到位和 hash 变化走，两种时序都对。
   *
   * 写回地址栏用的是 replaceState，不触发 hashchange，所以这里不会自己咬自己。
   */
  useEffect(() => {
    const sync = () => {
      const want = runFromHash();
      if (want && want !== wfRunId && runs.some((r) => r.id === want)) void selectRun(want);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [runs, wfRunId, selectRun]);

  /**
   * 「新运行」是一个动作，不是一个可选中的运行。
   *
   * 在起跑单（U-48）做出来之前，它做的是把画布放回一次干净的状态——不选任何历史运行，
   * 于是「运行」按钮起的就是一次全新的整跑。**关键是它不再去请求一个不存在的运行**。
   */
  const startNewRun = useCallback(() => {
    selectRunNone();
    if (window.location.hash.includes("run=")) window.location.hash = "";
  }, [selectRunNone]);

  /**
   * 换运行时把设置抽屉关掉。
   *
   * 设置是「对这个项目/这台机器的配置」，不是「对这一次运行的阅读」。换了运行之后它
   * 还盖在画布上，人会以为自己刚才那次点击没生效——实测就是这个反应：一直在点运行
   * 下拉，看不到画布变，因为它被一张全屏抽屉挡着。
   */
  useEffect(() => {
    if (wfRunId) setSettingsOpen(false);
  }, [wfRunId]);

  /**
   * 反过来也要对上：**从链接进来时，项目跟着那次运行走**。
   *
   * 别人发来 `?run=wf-…`，那一次运行属于哪个项目由它自己说了算。
   * 不跟着切的话，运行选中了、但项目选择器停在别处，于是运行下拉里
   * 根本没有那一项——选择器显示空白，人以为链接坏了。
   */
  useEffect(() => {
    if (!wfRunId) return;
    const own = runs.find((r) => r.id === wfRunId)?.projectId;
    if (own && own !== activeProjectId) void selectProject(own);
  }, [wfRunId, runs, activeProjectId, selectProject]);

  /**
   * 换语言之后把产物卡与轨迹重新拼一遍。
   *
   * 这两样的文字是在 store 里拼好的（那里没有 React，取不到会重渲染的 `t`），
   * 所以它们不会自己跟着语言变。不重拼的话，表现是**换了语言，画布上的卡片
   * 还是旧语言**——比整块不翻译更糟，因为它看起来像是漏翻了几处。
   */
  const lang = usePrefs((st) => st.lang);
  useEffect(() => {
    if (!wfRunId) return;
    void loadArtifacts(wfRunId);
    void loadTrace(wfRunId);
  }, [lang, wfRunId, loadArtifacts, loadTrace]);

  // 抽屉里的东西导航走了，抽屉就该让位——否则新建项目成功后，人看到的还是设置。
  useEffect(() => {
    const onNav = () => setSettingsOpen(false);
    window.addEventListener("tp:navigated", onNav);
    return () => window.removeEventListener("tp:navigated", onNav);
  }, []);

  const openSurface = useCallback((id: string) => setOpenId(id), [setOpenId]);

  const built = useMemo(() => {
    if (!def) return { nodes: [] as Node[], edges: [] as Edge[] };
    const pos = layout(def);
    // The artefact layer: one row of cards below the pipeline, wired to their producer.
    const artNodes = artifacts
      .filter((a) => pos[a.node])
      .map<Node>((a, i) => ({
        id: a.id,
        type: "artifact",
        position: { x: pos[a.node].x, y: pos[a.node].y + 150 + (i % 2 === 1 ? 130 : 0) },
        data: { ...a, onOpen: () => a.opens && openSurface(a.opens.surface) } as unknown as Record<
          string,
          unknown
        >,
        draggable: false,
        selectable: false,
      }));
    const artEdges = artifacts
      .filter((a) => pos[a.node])
      .map<Edge>((a) => ({ id: `art-${a.id}`, source: a.node, target: a.id, style: { opacity: 0.45 } }));
    return {
      nodes: def.nodes
        .map<Node>((n) => ({
          id: n.id,
          type: "card",
          position: pos[n.id],
          data: {
            label: n.id,
            title: nodeTypes.find((nt) => nt.type === n.type)?.title,
            type: n.type,
            run: nodeRuns[n.id] ?? { state: "idle" as NodeState },
            selected: n.id === selectedNode,
            editing,
            breakpoint: breakpoints.includes(n.id),
            onToggleBreakpoint: () => toggleBreakpoint(n.id),
            onDelete: () => removeNode(n.id),
          } satisfies CardData,
        }))
        .concat(artNodes),
      edges: def.edges
        .map<Edge>((e) => {
          // 被门禁拒下来的那条边，画布上要看得出来。
          // 一句「gate.textcase 期望 cases，design.cases 给的是 gated-cases」
          // 配上一张所有边长得一样的图，等于让人自己去数线。
          const broken = issues.some((i) => i.at.edge?.from === e.from && i.at.edge?.to === e.to);
          return {
            id: `${e.from}->${e.to}`,
            source: e.from,
            target: e.to,
            animated: nodeRuns[e.to]?.state === "running",
            ...(broken
              ? { style: { stroke: "#e11d48", strokeWidth: 2 }, label: "✕", labelStyle: { fill: "#e11d48" } }
              : {}),
          };
        })
        .concat(artEdges),
    };
  }, [
    def,
    nodeRuns,
    selectedNode,
    editing,
    removeNode,
    breakpoints,
    toggleBreakpoint,
    artifacts,
    openSurface,
    nodeTypes,
    issues,
  ]);

  /**
   * React Flow is told about the graph, and tells us back how big each node turned out.
   *
   * That second direction is not optional: in controlled mode a fresh node object wipes the
   * measurement React Flow took, and an unmeasured node is hidden, excluded from fitView,
   * and drawn without its edges. Since these objects are rebuilt on every event of a live
   * run, handing them over raw made the canvas blink and"fit view" do nothing at all.
   * Merging over the previous objects keeps the measurements attached.
   */
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    setNodes((prev) => {
      const measured = new Map(prev.map((n) => [n.id, n]));
      return built.nodes.map((n) => ({ ...measured.get(n.id), ...n }));
    });
    setEdges(built.edges);
  }, [built, setNodes, setEdges]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      // Artefact cards live on the same canvas but are not graph nodes: selecting one put
      //"a-gate" in the inspector and asked the gateway for a node that does not exist.
      // They have their own click target — the link that opens what they hold.
      if (node.type === "artifact") return;
      void selectNode(node.id);
    },
    [selectNode],
  );
  const running = runStatus === "running";

  return (
    <>
      {/* One row instead of two. The old top bar showed the project name, and the toolbar
          below it showed a project picker — the same fact twice, in two places, and neither
          of them said what a project contains.

          The row now reads left to right as **scope → action → state**:
          `项目 › 图 › 运行` is a breadcrumb of what contains what, which is also the answer
          to why a board belongs to a project while artefacts belong to a run. Then the
          actions, grouped by what they act on: this execution, this graph, this harness.
          Then, at the far end, the two facts that are neither: whether the event stream is
          up, and which gateway this tab is driving. */}
      <div className="flex h-screen flex-col">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
          <Globe className="h-4 w-4 flex-none text-muted-foreground" />
          {/*
            项目在这里是**面包屑的根，不是一个控件**。
            切换与新建都在左导航底部那一行，它在任何一屏上都常驻——而 `TopBar.tsx`
            的注释早就写过这条规矩：「同一件事印两遍，人会以为是两件事」。
            这一屏此前印了三遍：导航底部、这个下拉、右栏的 Project 行。
          */}
          <span
            className="max-w-[10.625rem] flex-none truncate text-[0.8125rem] text-muted-foreground"
            title={t("wf.projectWhy")}
          >
            {projects.find((p) => p.id === activeProjectId)?.name ?? t("common.noProjectSelected")}
          </span>

          <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground/50" />

          <select
            className="rounded-md border border-border bg-card px-2 py-1 text-[0.8125rem]"
            value={selectedGraph}
            onChange={(e) => selectGraph(e.target.value)}
            title={saved?.description || t("wf.graphWhy")}
          >
            {/* 说明来自图定义本身（GraphDef.title/description），不是前端硬编码的字符串表：
                换一个前端，四张图的差别不该跟着消失。 */}
            {graphs.map((g) => (
              <option key={g.id} value={g.id} title={g.description}>
                {g.title ? `${g.title} · ${g.id} v${g.version}` : `${g.id} · v${g.version}`}
              </option>
            ))}
          </select>

          <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground/50" />

          <select
            className="max-w-[13.125rem] rounded-md border border-border bg-card px-2 py-1 text-[0.8125rem]"
            value={wfRunId}
            /*
              空值不是一个运行 id。此前 onChange 直接 `selectRun("")`，拼出 `/api/wf/runs/`
              命中的是**列表路由**，返回 `{runs, active}` 而不是一个运行，于是读 `run.detail`
              抛 TypeError，被 catch 塞进顶栏那条红色错误——「新运行」这一项点下去必然报错。
              它本来就不是一个可选中的运行，而是一个动作。
            */
            onChange={(e) => {
              if (!e.target.value) return void startNewRun();
              void selectRun(e.target.value);
            }}
            title={t("wf.runWhy")}
          >
            <option value="">{t("wf.newRun")}</option>
            {/* 这个项目的运行，加上那些没绑定项目的旧运行——后者明确标出来。把它们藏掉会更
"干净"，但今天带着产物的恰恰全是它们：起运行时不绑定项目是后来才修的。 */}
            {runs
              .filter((r) => r.graphId === selectedGraph)
              .filter((r) => !r.projectId || r.projectId === activeProjectId)
              .map((r) => (
                /*
                  以**时间**为标识，不是以 id。
                  同一个图、同一个项目下常年堆着几十次运行，全部长成
                  `wf-mtczz1xw · done`——要复核的人从这个列表里认不出哪次是哪次，
                  连口头告诉别人选哪个都做不到。哈希只有在时间撞了的时候才有用，
                  所以它留在 title 里，让需要的人 hover 得到。
                */
                <option
                  key={r.id}
                  value={r.id}
                  title={[
                    r.id,
                    r.describe,
                    budgetLabel(r),
                    r.overridden?.length ? t("wf.overrode", { what: r.overridden.join(",") }) : "",
                  ]
                    .filter(Boolean)
                    .join("\n")}
                >
                  {runStamp(r.startedAt)} · {r.status}
                  {/* 打哪里、上限用掉多少——两个月后能不能读懂这次运行，全靠这两样。 */}
                  {r.envName ? ` · ${r.envName}` : ""}
                  {budgetLabel(r) ? ` · ${budgetLabel(r)}` : ""}
                  {/* 动过参数或关掉过组件的那些，不是这张图的基线成绩——列表上就得说。 */}
                  {r.overridden?.length ? ` · ${t("wf.runOverridden")}` : ""}
                  {r.ablated?.length ? ` · ${t("wf.runAblated", { list: r.ablated.join(",") })}` : ""}
                  {!r.projectId ? ` · ${t("wf.runUnbound")}` : ""}
                </option>
              ))}
          </select>

          <Divider />

          {/* 对这次执行 —— 跑与停是同一个位置上的一件事，不是并排的两个按钮。 */}
          {running ? (
            <Button onClick={() => void cancel()}>
              <Square className="h-3.5 w-3.5" />
              {t("wf.cancel")}
            </Button>
          ) : runStatus === "budget" ? (
            // 撞了上限不是一个「继续」就能解决的状态：继续之前要有人决定上限该怎么办。
            <Button variant="primary" onClick={() => setBudgetOpen(true)} title={t("wf.capWhy")}>
              <CircleDollarSign className="h-3.5 w-3.5" />
              {t("wf.capStopped")}
              {stoppedBy ? ` · ${t(`wf.cap.${stoppedBy}`)}` : ""}
            </Button>
          ) : pausedAt ? (
            <Button variant="primary" onClick={() => void resume()} title={pausedAt}>
              <SkipForward className="h-3.5 w-3.5" />
              {t("wf.resume")} · {pausedAt}
            </Button>
          ) : (
            <>
              <Button
                variant="primary"
                onClick={() => void start({ projectId: activeProjectId })}
                title={
                  pinnedOverProject ? t("wf.materialsPinnedWhy", { said: pinnedOverProject }) : undefined
                }
              >
                <Play className="h-3.5 w-3.5" />
                {t("wf.run")}
              </Button>
              {/* 起跑单：换环境、给上限、关组件、改这一次的参数。
                  这六样服务端一直收着，而界面上此前只有一个「运行」按钮——
                  于是想改任何一样，唯一的路是去改图，而改图会立一个新版本。 */}
              <Button onClick={() => setStartSheet((v) => !v)} title={t("start.why")}>
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {t("start.open")}
              </Button>
            </>
          )}
          {/* 项目挂了材料、图上却自己写死了路径——跑的是图上那份。
              这句话必须在**按下去之前**说：事后才发现，那一次二十分钟的运行
              读的是一份 mock，产出的规格看起来一切正常。 */}
          {pinnedOverProject && !running && (
            <span
              className="rounded border border-warn bg-warn-soft px-2 py-0.5 text-[0.6875rem] text-warn"
              title={t("wf.materialsPinnedWhy", { said: pinnedOverProject })}
            >
              {t("wf.materialsPinned")}
            </span>
          )}

          {/* 跑完了，而这张图的产物正好是另一张图的输入。阶段一到 gate 就结束——那不是停住，
              是跑完了，阶段二在另一张图里。这道坎在界面上原本看不见：人跑到 gate 只会问
              「然后呢」，然后没有然后。 */}
          {!running &&
            !editing &&
            continuations
              .filter((c) => c.ready)
              .map((c) => (
                /*
                 * 描边，不是实心。
                 *
                 * 它和左边的「运行」此前都是实心主色，一行里两颗同样重的按钮
                 * 等于没有主按钮——人得读完两行字才知道该点哪个。
                 * 而这两件事的关系是**先后**不是并列：先跑出文本用例，再续进 g2。
                 * 描边把这个先后画了出来，同时它一点也没变得更难点。
                 */
                <Button
                  key={c.graphId}
                  onClick={() => void continueInto(c.graphId)}
                  title={t("wf.continueWhy").replace("{from}", c.fromNode).replace("{into}", c.intoNode)}
                >
                  <StepForward className="h-3.5 w-3.5" />
                  {t("wf.continueInto").replace("{graph}", c.graphId)}
                </Button>
              ))}

          {/* Where this execution stops. It sat beside 版本 and read as a badge on it — but a
              breakpoint is not a property of the graph's history, it is a thing this run does. */}
          {breakpoints.length > 0 && !editing && (
            <span
              title={breakpoints.join(", ")}
              className="flex-none rounded bg-bad-soft px-1.5 py-0.5 text-[0.6875rem] text-bad"
            >
              {t("wf.breakpoints")} {breakpoints.length}
            </span>
          )}

          <Divider />

          {/* 对这张图 —— 改它的形状，和它改过几版。 */}
          {!editing ? (
            <>
              <Button onClick={beginEdit} disabled={running}>
                <Pencil className="h-3.5 w-3.5" />
                {t("wf.editTopology")}
              </Button>
              <Button onClick={() => setVersionsOpen(true)} title={t("wf.versionsWhy")}>
                <History className="h-3.5 w-3.5" />
                {t("wf.versions")}
              </Button>
              {/* 问一个关于这次运行的问题。需要同时读规格、故事、用例和 finding 才能
                  回答的那类——其余的应该由界面直接显示，而不是问模型。 */}
              {wfRunId && (
                <Button onClick={() => setDiagnosing({ kind: "run", wfRunId })} title={t("wf.diagnoseWhy")}>
                  <Stethoscope className="h-3.5 w-3.5" />
                  {t("wf.diagnose")}
                </Button>
              )}
            </>
          ) : (
            <>
              <select
                className="rounded-md border border-border bg-card px-2 py-1 text-[0.8125rem]"
                value=""
                onChange={(e) => e.target.value && addNode(e.target.value)}
              >
                <option value="">+ {t("wf.addNode")}</option>
                {nodeTypes.map((nt) => (
                  <option key={nt.type} value={nt.type} title={nt.description}>
                    {nt.title ? `${nt.title} · ${nt.type}` : nt.type}
                  </option>
                ))}
              </select>
              {/* 一句「为什么改」跟着版本一起存下来。没有它，版本抽屉里
                  每一项就只是个「v3」，回头没人说得清那次动了什么。 */}
              <input
                className="w-44 rounded border border-border bg-card px-2 py-[0.1875rem] text-[0.6875rem]"
                placeholder={t("wf.notePlaceholder")}
                value={saveNote}
                onChange={(e) => setSaveNote(e.target.value)}
              />
              <Button
                variant="primary"
                onClick={() => {
                  void saveTopology(saveNote.trim() || undefined);
                  setSaveNote("");
                }}
              >
                <Save className="h-3.5 w-3.5" />
                {t("wf.saveTopology")}
              </Button>
              <Button onClick={discardEdit}>
                <X className="h-3.5 w-3.5" />
                {t("wf.discard")}
              </Button>
              <span className="text-[0.6875rem] text-warn">{t("wf.editingHint")}</span>
            </>
          )}

          {/* 跑起来之后的一条真进度：第几步 / 共几步、这一步跑了多久、累计花了多少。
              此前这三样在界面上一处都没有，只能看「哪个方块是黄的」。
              耗时来自 budget.update，所以一个六分钟的节点内部数字也在动。 */}
          {running && progress.total > 0 && (
            <>
              <Divider />
              <span className="flex items-center gap-2 text-[0.75rem] text-muted-foreground">
                <span className="font-mono tabular-nums text-foreground">
                  {progress.done + 1}/{progress.total}
                </span>
                {progress.at && <span className="max-w-[16ch] truncate">{progress.at}</span>}
                {progress.ms > 0 && (
                  <span className="font-mono tabular-nums">{(progress.ms / 1000).toFixed(0)}s</span>
                )}
                <span className="font-mono tabular-nums">
                  {runtime.spend.calls} calls · {Math.round(runtime.spend.tokens / 1000)}k tok
                </span>
              </span>
            </>
          )}

          {/* 没跑完的运行：说清跑到哪儿了，并且给一个能直接按的「接着跑」。
              此前这里什么都没有，人只能自己猜从哪一步重来。 */}
          {resumeFrom && !running && (
            <>
              <Divider />
              <span className="text-[0.6875rem] text-muted-foreground">
                {t("wf.resumeHint", { done: String(resumeDone), from: resumeFrom })}
              </span>
              <Button variant="primary" onClick={() => void resume()}>
                <StepForward className="h-3.5 w-3.5" />
                {t("wf.resumeFromHere")}
              </Button>
            </>
          )}

          {/* 画的不是今天这张图时，得说出来——否则人会拿旧运行的画面去改今天的图。 */}
          {pinnedOld && (
            <span className="rounded border border-warn bg-warn-soft px-2 py-0.5 text-[0.6875rem] text-warn">
              {t("wf.pinnedOldVersion", {
                ver: String(runGraph?.version ?? 0),
                cur: String(saved?.version ?? 0),
              })}
            </span>
          )}

          {/* 对这一版 harness —— 量的不是产品，所以它不属于上面任何一段。 */}
          <Divider />
          <Button onClick={() => openSurface("evals")} title={t("wf.evalsWhy")}>
            <FlaskConical className="h-3.5 w-3.5" />
            {t("nav.evals")}
          </Button>

          {/* 既不属于作用域也不属于动作的两件事：事件流通不通，以及这个标签页在驱动哪个网关。
              后者只在不是默认网关时出现——自举时两个实例同时在跑，「我在看哪一个」会突然
              变得不显然。 */}
          <span className="ml-auto flex items-center gap-2 text-[0.75rem] text-muted-foreground">
            {IS_OVERRIDDEN && (
              <button
                onClick={resetApiBase}
                title={t("topbar.backToDefault")}
                className="flex cursor-pointer items-center gap-1 rounded-md bg-warn-soft px-2 py-0.5 font-mono text-[0.6875rem] text-warn hover:bg-warn-soft"
              >
                <ServerCog className="h-3.5 w-3.5" />
                {API_BASE.replace(/^https?:\/\//, "")}
              </button>
            )}
            {error && <span className="text-bad">{error}</span>}
            {/*
              取消的回执。「正在停」和「进程已经不在了」是两句不同的话，此前界面对两者
              都一声不吭——按下停止之后完全没有反馈，而取消只在节点边界生效，
              实测单步耗时 spec 158 秒、codegen 505 秒。
            */}
            {cancelNote && <span className="text-warn">{cancelNote}</span>}
            <span
              title={t(`proc.ws.${ws}`)}
              className={cn("h-2 w-2 rounded-full", ws === "open" ? "bg-ok" : "bg-warn")}
            />
            <button
              onClick={() => setSettingsOpen(true)}
              title={t("nav.settings")}
              className="cursor-pointer rounded-md p-1 hover:bg-muted hover:text-foreground"
            >
              <SettingsIcon className="h-4 w-4" />
            </button>
          </span>
        </div>

        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeCards}
                onNodeClick={onNodeClick}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onEdgesDelete={onEdgesDelete}
                onNodeDragStop={onNodeDragStop}
                onInit={setFlow}
                fitView
                nodesDraggable={editing}
                nodesConnectable={editing}
                edgesFocusable={editing}
                deleteKeyCode={editing ? "Delete" : null}
                proOptions={{ hideAttribution: true }}
                /* 一个手势只有一种含义：拖动模式下拖的是画布，选择模式下拖出来的是框。 */
                panOnDrag={tool === "pan"}
                selectionOnDrag={tool === "select"}
                selectionMode={SelectionMode.Partial}
                onSelectionChange={({ nodes: picked }) =>
                  // 产物卡不是图节点：框住它不该被当成"选中了一步"。
                  setPicked(picked.filter((n) => n.type !== "artifact").map((n) => n.id))
                }
              >
                <Background />
                <Controls showInteractive={false} />
                {/* 左上角、竖排：手势模式是进画布做的第一个选择，放在视线起点，
                  也和左下角的缩放控件分开——那是"看得多大"，这是"拖的是什么"。 */}
                <Panel position="top-left" className="!left-3 !top-3">
                  <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
                    {(
                      [
                        ["pan", Hand, "wf.toolPan"],
                        ["select", SquareDashedMousePointer, "wf.toolSelect"],
                      ] as const
                    ).map(([id, Icon, key]) => (
                      <button
                        key={id}
                        onClick={() => setTool(id)}
                        title={t(`${key}Why`)}
                        className={cn(
                          "flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[0.75rem] transition-colors",
                          tool === id
                            ? "bg-primary/10 font-medium text-primary"
                            : "text-muted-foreground hover:bg-muted",
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {t(key)}
                      </button>
                    ))}
                  </div>
                </Panel>
                {/*
                  图例。**它是这张图的一部分，不是装饰**——上面每一行都对应
                  一个人看到那个颜色时要做的判断，而 `US-14` 只写了「节点上显示状态」，
                  没写「人怎么知道那个颜色是什么意思」。
                  放右上：左上是手势模式，左下是缩放控件，右下是小地图，只剩这一角。
                  默认收起，展开状态记在本地——它是学一次就不用再看的东西。
                */}
                <Panel position="top-right" className="!right-3 !top-3">
                  <CanvasLegend />
                </Panel>
                {/* A four-node pipeline does not need a second view of itself; shrunk to a
                  locator so it stops competing with the artefacts for the corner. */}
                <MiniMap pannable zoomable className="!bg-muted/70" style={{ width: 108, height: 68 }} />
              </ReactFlow>
              {/*
              一个项目都没有的时候，画布上是一张空图——而这个人此刻唯一该做的事
              （建项目）此前只存在于设置抽屉的第二层里。空态不是「这里没东西」，
              是「这里该发生什么」，所以它带着那个动作本身。
            */}
              {/*
              没有项目时提示建一个，但**不许盖住已经在这儿的东西**。

              此前这张卡是 `absolute inset-0 z-10`，正好压在画布中央的节点上。而挂载时
              画布会自动落到"这张图最新的一次运行"——实测这台机器上 0 个项目、80 次运行、
              381 份节点产物、61MB 截图，于是第一屏同时说着「这里什么都没有」和
              「这是最近一次运行的一百条用例」，两句话都很确定，互相矛盾，
              而那些产物既读不了也点不到。

              改成一条横幅：它说的是"还缺一个项目"，不是"这里什么都没有"，
              并且把机器上已经有的东西一起说出来。
            */}
              {!projects.length && (
                <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-3">
                  <div className="pointer-events-auto flex max-w-2xl items-center gap-3 rounded-lg border border-border bg-card/95 px-4 py-2.5 text-left shadow-sm backdrop-blur-sm">
                    <Globe className="h-4 w-4 flex-none text-muted-foreground" />
                    <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
                      {t("projects.empty")}
                      {runs.length > 0 && (
                        <span className="ml-1 text-foreground">
                          {t("projects.emptyButRuns", { n: runs.length })}
                        </span>
                      )}
                    </p>
                    <Button variant="primary" className="flex-none" onClick={() => setNewProjectOpen(true)}>
                      <Plus className="h-3.5 w-3.5" />
                      {t("projects.newProject")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <RuntimeRail
              rt={runtime}
              nodeRuns={nodeRuns}
              open={railOpen}
              onToggle={() => setRailOpen((v) => !v)}
            />
            <TracePanel rows={trace} open={traceOpen} onToggle={() => setTraceOpen((v) => !v)} />
            {startSheet && (
              <StartSheet
                def={def}
                nodeTypes={nodeTypes}
                projectId={activeProjectId ?? ""}
                title={t("start.title")}
                onClose={() => setStartSheet(false)}
                onStart={(opts) => {
                  setStartSheet(false);
                  void start({ projectId: activeProjectId, ...opts });
                }}
              />
            )}
          </div>

          {/*
            右栏三节：**进度 / 产物 / 这次它看得到什么**。
            常驻而不是抽屉——这三样是读任何一件产物时都要对着看的背景，
            装进抽屉，人每判断一条就要开关一次，而抽屉一开就盖住了它要解释的那个东西。
          */}
          <RunRail
            runtime={runtime}
            nodeRuns={nodeRuns}
            order={(def?.nodes ?? []).map((n) => n.id)}
            produced={Object.keys(outputs)}
            artifacts={artifacts}
            context={runContext}
            onOpen={openSurface}
          />

          {/* The inspector is about a node, so it is a drawer over the canvas like every other
              overlay: same close, same drag-to-widen, and the pipeline it belongs to stays
              visible behind it. It used to be a permanent 380px column whose contents were
"点一个节点看它的产物". */}
          <Drawer
            open={!!selectedNode}
            onClose={() => void selectNode("")}
            resizeKey="node"
            defaultWidth={520}
            /* 节点抽屉装的是物料正文——规格、故事、用例表、执行报告。整屏打开；
               标题栏的收合按钮仍能切回常规宽度，拖动也仍然有效。 */
            fullscreen
            title={
              <span className="flex items-baseline gap-2">
                <span>{nodeTypes.find((nt) => nt.type === node?.type)?.title || selectedNode}</span>
                <span className="font-mono text-[0.6875rem] font-normal text-muted-foreground">
                  {selectedNode} · {node?.type}
                </span>
              </span>
            }
          >
            {/* 这一步能做什么，就摆在这一步自己的抽屉里。它们此前在顶栏——作用于某一步，
                却站在离那一步半个屏幕远的地方，而且只有先选中才会冒出来。 */}
            {selectedNode && !editing && (
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                <Button
                  onClick={() => void start({ node: selectedNode, mode: "only" })}
                  disabled={running || !wfRunId || !!missingUp}
                  title={missingUp ? t("wf.missingUpstream", { node: missingUp }) : t("wf.runNodeWhy")}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  {t("wf.runNode")}
                </Button>
                <Button
                  onClick={() => void start({ node: selectedNode, mode: "from" })}
                  disabled={running || !wfRunId || !!missingUp}
                  title={missingUp ? t("wf.missingUpstream", { node: missingUp }) : t("wf.runFromWhy")}
                >
                  <StepForward className="h-3.5 w-3.5" />
                  {t("wf.runFrom")}
                </Button>
                {/* 灰掉一个按钮而不说为什么，等于把人挡在门外还不告诉他门在哪。 */}
                {missingUp && (
                  <span className="text-[0.6875rem] text-warn">
                    {t("wf.missingUpstream", { node: missingUp })}
                  </span>
                )}
                <Button onClick={() => toggleBreakpoint(selectedNode)} title={t("wf.breakpointWhy")}>
                  {breakpoints.includes(selectedNode) ? (
                    <CircleDot className="h-3.5 w-3.5 text-bad" />
                  ) : (
                    <Circle className="h-3.5 w-3.5" />
                  )}
                  {breakpoints.includes(selectedNode) ? t("wf.breakpointOff") : t("wf.breakpointOn")}
                </Button>
                {/* 问一个关于这一步的问题，答案就开在这一步旁边。 */}
                <Button
                  onClick={() =>
                    setDiagnosing({ kind: "node", node: selectedNode, wfRunId: wfRunId || undefined })
                  }
                  title={t("wf.diagnoseWhy")}
                >
                  <Stethoscope className="h-3.5 w-3.5" />
                  {t("wf.diagnose")}
                </Button>
                {/* 两个「跑」都要求先有一次运行可以接着改：没有的话说清楚，而不是给一个灰按钮让人猜。 */}
                {!wfRunId && <span className="text-[0.6875rem] text-muted-foreground">{t("wf.needRun")}</span>}
              </div>
            )}

            {node && (
              <div className="border-b border-border p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[0.6875rem] font-medium text-muted-foreground">{t("wf.params")}</span>
                  <Button onClick={() => void save()} disabled={!dirty}>
                    <Save className="h-3.5 w-3.5" />
                    {t("wf.save")}
                  </Button>
                </div>
                {/* 读哪几份材料是勾出来的，不是手写一个 JSON 数组敲出来的。规格是下游
                    一切的输入，而选错一份文档不会报错——只会在二十分钟后变成一批看起来
                    正常、其实答非所问的用例。文本框留着：`path` / `text` 两种形式还在，
                    而且一个只能勾选的界面遇到不在列表里的路径会把人挡死。 */}
                {node.type === "source.spec" && (
                  <div className="mb-2">
                    <MaterialPicker
                      selected={paths}
                      onChange={(next) => {
                        let parsed: Record<string, unknown> = {};
                        try {
                          parsed = JSON.parse(draft || "{}") as Record<string, unknown>;
                        } catch {
                          // 文本框里是半截 JSON 时不丢掉勾选：从当前参数重建，而不是清空。
                          parsed = { ...(node.params ?? {}) };
                        }
                        setDraft(JSON.stringify({ ...parsed, paths: next }, null, 2));
                        setDirty(true);
                      }}
                    />
                  </div>
                )}
                {/* 有名字的字段先摆出来，JSON 留在下面。
                    此前这里只有 JSON——每个节点类型明明都有完整的 zod schema，
                    只是 `NodeRegistry.list()` 把它裁掉了没往前端发，
                    于是人只能对着一个 `{}` 猜能填什么。 */}
                {(() => {
                  const shape = nodeTypes.find((nt) => nt.type === node.type)?.params;
                  if (!shape) return null;
                  let parsed: Record<string, unknown> = {};
                  let broken = false;
                  try {
                    parsed = JSON.parse(draft || "{}") as Record<string, unknown>;
                  } catch {
                    // JSON 敲了一半时表单先退开，别把人正在打的字吃掉。
                    broken = true;
                  }
                  if (broken) return null;
                  return (
                    <ParamForm
                      shape={shape}
                      value={parsed}
                      onChange={(next) => {
                        setDraft(JSON.stringify(next, null, 2));
                        setDirty(true);
                      }}
                    />
                  );
                })()}
                <textarea
                  className="h-32 w-full resize-y rounded-md border border-border bg-card p-2 font-mono text-[0.6875rem]"
                  value={draft}
                  spellCheck={false}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setDirty(true);
                  }}
                />
                {/* 每条问题都可以点：点节点选中它，点边把两端选中并居中。
                    只列不定位，人还是得自己在图上找——而图上恰恰有二十个节点。 */}
                {issues.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-[0.6875rem] text-bad">
                    {issues.map((i, k) => (
                      <li key={k}>
                        <button
                          className="cursor-pointer text-left underline decoration-dotted hover:brightness-110"
                          onClick={() => {
                            const id = i.at.node ?? i.at.edge?.to ?? "";
                            if (!id) return;
                            selectNode(id);
                            flow?.fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.2 });
                          }}
                        >
                          {i.at.node
                            ? `${i.at.node}: `
                            : i.at.edge
                              ? `${i.at.edge.from} → ${i.at.edge.to}: `
                              : ""}
                          {i.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-1 text-[0.6875rem] text-muted-foreground">{t("wf.saveHint")}</p>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {nodeDetail === undefined ? (
                <div className="text-[0.75rem] text-muted-foreground">{t("wf.noOutput")}</div>
              ) : (
                // 可折叠、可搜、不截断。此前这里是 stringify 之后砍到两万字符——
                // 40 条用例的产物两千多行，想看第 17 条的判据只能滚；
                // 而被砍掉的部分没有任何提示，读的人以为自己看到了全部。
                <>
                  {/* 认得的产物用专用组件画，一张塌了只塌它自己（见 artifact/registry）。
                      认不出的仍然给 JSON——那是这一版还不认得它，不是它没有值得看的东西。 */}
                  {artifactsIn(nodeDetail).map((a, i) => (
                    <div key={i} className="mb-2">
                      <ArtifactView kind={a.kind} value={a.value} />
                    </div>
                  ))}
                  <JsonView value={nodeDetail} />
                </>
              )}
            </div>
            <div className="max-h-56 overflow-auto border-t border-border bg-muted p-2">
              {/* 这个抽屉是**某一步**的，所以日志也只给这一步的。
                  拿不到归属的行（node 为空的，属于整次运行）一并留下：
                  它们是「这次运行开始了 / 结束了」这类话，藏掉会让日志看起来断掉。 */}
              <pre className="whitespace-pre-wrap break-words font-mono text-[0.6875rem] leading-relaxed text-muted-foreground">
                {log
                  .filter((l) => !l.node || l.node === selectedNode)
                  .slice(-40)
                  .map((l) => l.text)
                  .join("\n") || t("wf.noEvents")}
              </pre>
            </div>
          </Drawer>

          {/* 框选出来的那几步。
              动作按「能不能对一批一起做」分开写：断点是每一步各自的开关，可以一起设；
              而「只跑这一步」不能——运行时的 only/from 都只接受一个节点。与其做一个
              看起来能批量、点下去只对其中一个生效的按钮，不如说清楚它为什么只对一个生效。 */}
          <Drawer
            open={picked.length > 1}
            onClose={() => {
              setPicked([]);
              flow?.setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
            }}
            resizeKey="picked"
            defaultWidth={440}
            title={t("wf.pickedTitle").replace("{n}", String(picked.length))}
          >
            <div className="p-3">
              <div className="flex flex-wrap gap-1.5">
                {picked.map((id) => (
                  <span key={id} className="rounded bg-muted px-2 py-0.5 font-mono text-[0.75rem]">
                    {id}
                  </span>
                ))}
              </div>

              <div className="mt-3 space-y-2">
                <div className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground/70">
                  {t("wf.pickedBatch")}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => picked.filter((id) => !breakpoints.includes(id)).forEach(toggleBreakpoint)}
                  >
                    <CircleDot className="h-3.5 w-3.5" />
                    {t("wf.pickedBreakAll")}
                  </Button>
                  <Button
                    onClick={() => picked.filter((id) => breakpoints.includes(id)).forEach(toggleBreakpoint)}
                  >
                    <Circle className="h-3.5 w-3.5" />
                    {t("wf.pickedBreakNone")}
                  </Button>
                </div>

                <div className="pt-2 text-[0.6875rem] uppercase tracking-wider text-muted-foreground/70">
                  {t("wf.pickedSingleOnly")}
                </div>
                <p className="text-[0.75rem] leading-relaxed text-muted-foreground">{t("wf.pickedWhySingle")}</p>
                <div className="flex flex-wrap gap-2">
                  {picked.map((id) => (
                    <Button key={id} onClick={() => void selectNode(id)} disabled={running}>
                      {t("wf.pickedOpen").replace("{node}", id)}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </Drawer>

          {/* Versions belong to the graph, not to whichever node happens to be selected —
              they used to be reachable only by opening a node, which is the wrong door. */}
          <Drawer
            open={versionsOpen}
            onClose={() => setVersionsOpen(false)}
            resizeKey="versions"
            defaultWidth={560}
            title={t("wf.versions")}
          >
            <VersionPanel
              versions={versions}
              diffLines={diffLines}
              onDiff={(a, b) => void loadDiff(a, b)}
              onRunVersion={(v) => void start({ projectId: activeProjectId, graphVersion: v })}
            />
          </Drawer>

          {/* Run-scoped readers: these artefacts belong to this run, so they are read from
              it rather than from whichever project happens to be selected.
              这两个仍然是抽屉——它们不在 `SURFACES` 里，是画布自己的东西。 */}
          {openId === "spec" && wfRunId && <SpecDrawer wfRunId={wfRunId} onClose={() => setOpenId("")} />}
          {openId === "stories" && wfRunId && (
            <StoriesDrawer wfRunId={wfRunId} onClose={() => setOpenId("")} />
          )}
          {/*
            产物卡打开的界面**不再盖在画布上**，而是变成左导航里的一屏（见 App.tsx 的 AppShell）。
            留一句说明而不是删掉整段历史：`openSurface` 仍然在用，它做的事从
            「打开一张浮层」变成了「换一个落点」——地址机制一个字没改，
            所以 `#/?open=cases` 这样的旧链接照样能打开。

            为什么不再用浮层：「每类产物一张卡」随类型数线性劣化——13 类就是 13 张卡，
            人仍然要先在脑子里建一张地图，只是那张地图从菜单换成了画布。
          */}
          {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
          {diagnosing && <DiagnoseDrawer scope={diagnosing} onClose={() => setDiagnosing(undefined)} />}
          {budgetOpen && <BudgetDrawer onClose={() => setBudgetOpen(false)} />}
          <NewProjectDialog
            open={newProjectOpen}
            onClose={() => setNewProjectOpen(false)}
            /* createProject 已经把新项目选上了，这里只要把画布带回干净状态：
               刚建的项目没有任何运行，还停在上一个项目的运行上会读出别人的数。 */
            onCreated={() => setOpenId("")}
          />
        </div>
      </div>
    </>
  );
}
