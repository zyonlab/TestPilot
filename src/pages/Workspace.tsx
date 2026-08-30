import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Play, Square, RotateCw, StepForward, Save, Pencil, Trash2, X, History, Circle, CircleDot, SkipForward, Settings as SettingsIcon, FlaskConical, Globe, ChevronRight, ServerCog, Hand, SquareDashedMousePointer, Stethoscope, CircleDollarSign } from "lucide-react";
import { Button } from "@/components/ui";
import { useT, usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import { API_BASE, IS_OVERRIDDEN, resetApiBase } from "@/lib/base";
import { runFromHash, useWf, type Artifact, type GraphDef, type NodeRun, type NodeState, type Runtime, type TraceRow } from "@/lib/wf";
import { SurfacePanel } from "@/components/SurfacePanel";
import { Drawer } from "@/components/overlay";
import { SettingsDrawer } from "@/components/SettingsDrawer";
import { DiagnoseDrawer, type DiagnoseScope } from "@/components/DiagnoseDrawer";
import { BudgetDrawer } from "@/components/BudgetDrawer";
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
  running: "border-amber-400 bg-amber-50 dark:bg-amber-950/40",
  done: "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/40",
  failed: "border-rose-400 bg-rose-50 dark:bg-rose-950/40",
  skipped: "border-border bg-muted",
  // Stopped in front of, not run: it reads as "waiting for you", not as a result.
  paused: "border-sky-400 bg-sky-50 dark:bg-sky-950/40",
};

interface CardData extends Record<string, unknown> {
  label: string;
  type: string;
  run: NodeRun;
  selected: boolean;
  editing: boolean;
  breakpoint: boolean;
  onToggleBreakpoint?: () => void;
  onDelete?: () => void;
}

function NodeCard({ data }: NodeProps) {
  const d = data as CardData;
  const run = d.run;
  return (
    <div
      className={cn(
        "min-w-[190px] rounded-xl border-2 px-3 py-2 shadow-sm transition-colors",
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
            d.breakpoint ? "text-rose-500" : "text-muted-foreground/40 hover:text-rose-400",
          )}
          title="breakpoint"
          onClick={(e) => {
            e.stopPropagation();
            d.onToggleBreakpoint?.();
          }}
        >
          {d.breakpoint ? <CircleDot className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
        </button>
        <div className="font-display text-[13px] font-medium text-foreground">{d.label}</div>
        {d.editing && (
          <button
            className="ml-auto text-muted-foreground hover:text-rose-500"
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
      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{d.type}</div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
        {run.ms !== undefined && <span>{(run.ms / 1000).toFixed(1)}s</span>}
        {run.calls ? <span>{run.calls} calls</span> : null}
        {run.tokens ? <span>{run.tokens} tok</span> : null}
        {run.gate && <span className="text-foreground">gate {Math.round(run.gate.score * 100)}%</span>}
      </div>
      {run.error && <div className="mt-1 line-clamp-2 text-[10px] text-rose-600">{run.error}</div>}
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
        "min-w-[168px] max-w-[190px] rounded-xl border bg-card px-3 py-2 shadow-sm",
        d.tone === "warn" ? "border-amber-400" : "border-border",
      )}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !opacity-0" />
      <div className="text-[11.5px] text-muted-foreground">{d.title}</div>
      <div
        className={cn(
          "font-mono text-[21px] leading-tight tabular-nums",
          d.tone === "warn" ? "text-amber-600" : "text-primary",
        )}
      >
        {d.value}
      </div>
      <div className="font-mono text-[10.5px] leading-snug text-muted-foreground">{d.sub}</div>
      {d.samples && (
        <div className="mt-1 flex flex-col gap-0.5">
          {d.samples.map((x: string, i: number) => (
            <div key={i} className="truncate rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
              {x}
            </div>
          ))}
        </div>
      )}
      {d.opens && (
        <button
          onClick={() => d.onOpen?.()}
          className="mt-1 block cursor-pointer text-[11px] text-primary hover:underline"
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
 * still means "look at that batch of cases". It is a query on the one address rather than an
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
    for (const e of def.edges)
      depth.set(e.to, Math.max(depth.get(e.to) ?? 0, (depth.get(e.from) ?? 0) + 1));

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
 * Kept next to the canvas rather than on a page of its own: the question "what did I change
 * since the run that scored 89%" is asked while looking at the graph, not away from it.
 */
function VersionPanel({
  versions,
  diffLines,
  onDiff,
}: {
  versions: Array<{ version: number; savedAt: string; note?: string }>;
  diffLines: string[];
  onDiff: (from: number, to: number) => void;
}) {
  const t = useT();
  const [from, setFrom] = useState<number | undefined>();
  const [to, setTo] = useState<number | undefined>();

  useEffect(() => {
    // Default to "the newest change": the comparison people want nine times out of ten.
    setTo(versions[0]?.version);
    setFrom(versions[1]?.version ?? versions[0]?.version);
  }, [versions]);

  if (versions.length === 0) return null;
  const pick = (value: number | undefined, set: (v: number) => void) => (
    <select
      className="min-w-0 flex-1 rounded border border-border bg-card px-1 py-0.5 font-mono text-[11px]"
      value={value ?? ""}
      onChange={(e) => set(Number(e.target.value))}
    >
      {versions.map((v) => (
        <option key={v.version} value={v.version}>
          v{v.version}
          {v.note ? ` · ${v.note}` : ""}
        </option>
      ))}
    </select>
  );

  return (
    <div className="border-b border-border p-3">
      <div className="mb-1 flex items-center gap-1.5">
        <History className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium text-muted-foreground">{t("wf.versions")}</span>
      </div>
      <div className="flex items-center gap-1">
        {pick(from, setFrom)}
        <span className="text-[11px] text-muted-foreground">→</span>
        {pick(to, setTo)}
        <Button
          className="whitespace-nowrap"
          onClick={() => from !== undefined && to !== undefined && onDiff(from, to)}
          disabled={from === undefined || to === undefined}
        >
          {t("wf.diff")}
        </Button>
      </div>
      {diffLines.length > 0 && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[10px] leading-relaxed text-foreground">
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
  const shown = rows.filter((r) => filter === "all" || r.kind === filter || (filter === "node" && r.kind === "run"));
  const KIND: Record<TraceRow["kind"], string> = {
    run: "RUN", node: "NODE", model: "MODEL", gate: "GATE", err: "FLAG",
  };
  return (
    <div className={cn("flex flex-col border-t border-border bg-card", open && "h-[220px]")}>
      <div className="flex flex-none items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-[12px] font-semibold">{t("wf.trace")}</span>
        {open &&
          (["all", "model", "node", "gate"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={cn(
                "cursor-pointer rounded px-2 py-0.5 text-[11.5px]",
                filter === k ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {t(`wf.trace.${k}`)}
            </button>
          ))}
        <button onClick={onToggle} className="ml-auto cursor-pointer text-[11.5px] text-muted-foreground">
          {open ? t("wf.collapse") : t("wf.expandTrace")}
        </button>
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-auto">
          {shown.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-muted-foreground">{t("wf.traceEmpty")}</div>
          )}
          {shown.map((r, i) => (
            <div
              key={i}
              className="grid grid-cols-[58px_54px_120px_minmax(0,1fr)_auto] items-baseline gap-2.5 border-b border-border/40 px-3 py-1 text-[12px]"
            >
              <span className="font-mono text-[10.5px] text-muted-foreground/80">{r.ts}</span>
              <span
                className={cn(
                  "font-mono text-[10px]",
                  r.kind === "model" && "text-amber-600",
                  r.kind === "gate" && "text-emerald-600",
                  r.kind === "err" && "text-rose-600",
                  r.kind === "node" && "text-primary",
                )}
              >
                {KIND[r.kind]}
              </span>
              <span className="truncate font-mono text-[11px] text-primary">{r.node}</span>
              <span className="truncate text-muted-foreground">{r.text}</span>
              <span className="whitespace-nowrap font-mono text-[10.5px] text-muted-foreground/80">{r.right}</span>
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
 * attribution gauges — a "0 infra · 0 assert" would claim the run checked and found none.
 */
function Gauge({
  label, value, tone, frac, title,
}: { label: string; value: string; tone?: "good" | "warn" | "bad"; frac?: number; title?: string }) {
  return (
    <div className="min-w-[104px] flex-none" title={title}>
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div
        className={cn(
          "mt-0.5 font-mono text-[12.5px] tabular-nums",
          tone === "good" && "text-emerald-600 dark:text-emerald-400",
          tone === "warn" && "text-amber-600 dark:text-amber-400",
          tone === "bad" && "text-rose-600 dark:text-rose-400",
          !tone && "text-foreground",
        )}
      >
        {value}
      </div>
      {frac !== undefined && (
        <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-muted">
          <i
            className={cn("block h-full rounded-full", frac > 0.85 ? "bg-rose-500" : "bg-primary")}
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
        <span className="text-[12px] font-semibold">{t("wf.runtime")}</span>
        <span className="text-[11px] text-muted-foreground">{t("wf.runtimeWhy")}</span>
        <button onClick={onToggle} className="ml-auto cursor-pointer text-[11.5px] text-muted-foreground">
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
            value={rt.budget.ms ? `${min(rt.spend.ms)} / ${min(rt.budget.ms)} min` : `${min(rt.spend.ms)} min`}
            frac={rt.budget.ms ? rt.spend.ms / rt.budget.ms : undefined}
          />
          <Gauge
            label={t("wf.rtAblate")}
            value={rt.ablate.length ? rt.ablate.join(",") : t("wf.rtAblateNone")}
            tone={rt.ablate.length ? "warn" : "good"}
            title={t("wf.rtAblateWhy")}
          />
          <Gauge
            label={t("wf.rtPrompts")}
            value={rt.prompts || "—"}
            title={t("wf.rtPromptsWhy")}
          />
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

export function WorkspacePage() {
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
    artifacts,
    loadArtifacts,
    trace,
    loadTrace,
    runtime,
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
  const def = topoDraft ?? saved;
  const editing = !!topoDraft;

  useEffect(() => {
    void loadVersions();
  }, [selectedGraph, loadVersions]);

  const node = def?.nodes.find((n) => n.id === selectedNode);
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
  const [openId, openFocus, setOpenId] = useOpenSurface();
  const [traceOpen, setTraceOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
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
  const selectProject = useStore((st) => st.selectProject);
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
        data: { ...a, onOpen: () => a.opens && openSurface(a.opens.surface) } as unknown as Record<string, unknown>,
        draggable: false,
        selectable: false,
      }));
    const artEdges = artifacts
      .filter((a) => pos[a.node])
      .map<Edge>((a) => ({ id: `art-${a.id}`, source: a.node, target: a.id, style: { opacity: 0.45 } }));
    return {
      nodes: def.nodes.map<Node>((n) => ({
        id: n.id,
        type: "card",
        position: pos[n.id],
        data: {
          label: n.id,
          type: n.type,
          run: nodeRuns[n.id] ?? { state: "idle" as NodeState },
          selected: n.id === selectedNode,
          editing,
          breakpoint: breakpoints.includes(n.id),
          onToggleBreakpoint: () => toggleBreakpoint(n.id),
          onDelete: () => removeNode(n.id),
        } satisfies CardData,
      })).concat(artNodes),
      edges: def.edges
        .map<Edge>((e) => ({
          id: `${e.from}->${e.to}`,
          source: e.from,
          target: e.to,
          animated: nodeRuns[e.to]?.state === "running",
        }))
        .concat(artEdges),
    };
  }, [def, nodeRuns, selectedNode, editing, removeNode, breakpoints, toggleBreakpoint, artifacts, openSurface]);

  /**
   * React Flow is told about the graph, and tells us back how big each node turned out.
   *
   * That second direction is not optional: in controlled mode a fresh node object wipes the
   * measurement React Flow took, and an unmeasured node is hidden, excluded from fitView,
   * and drawn without its edges. Since these objects are rebuilt on every event of a live
   * run, handing them over raw made the canvas blink and "fit view" do nothing at all.
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
      // "a-gate" in the inspector and asked the gateway for a node that does not exist.
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
          <select
            className="max-w-[170px] rounded-md border border-border bg-card px-2 py-1 text-[13px]"
            value={activeProjectId}
            onChange={(e) => void selectProject(e.target.value)}
            title={t("wf.projectWhy")}
          >
            <option value="">{t("common.noProjectSelected")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground/50" />

          <select
            className="rounded-md border border-border bg-card px-2 py-1 text-[13px]"
            value={selectedGraph}
            onChange={(e) => selectGraph(e.target.value)}
            title={t("wf.graphWhy")}
          >
            {graphs.map((g) => (
              <option key={g.id} value={g.id}>
                {g.id} · v{g.version}
              </option>
            ))}
          </select>

          <ChevronRight className="h-3.5 w-3.5 flex-none text-muted-foreground/50" />

          <select
            className="max-w-[210px] rounded-md border border-border bg-card px-2 py-1 text-[13px]"
            value={wfRunId}
            onChange={(e) => void selectRun(e.target.value)}
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
                <option key={r.id} value={r.id} title={r.id}>
                  {runStamp(r.startedAt)} · {r.status}
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
            <Button variant="primary" onClick={() => void start({ projectId: activeProjectId })}>
              <Play className="h-3.5 w-3.5" />
              {t("wf.run")}
            </Button>
          )}

          {/* 跑完了，而这张图的产物正好是另一张图的输入。阶段一到 gate 就结束——那不是停住，
              是跑完了，阶段二在另一张图里。这道坎在界面上原本看不见：人跑到 gate 只会问
              「然后呢」，然后没有然后。 */}
          {!running && !editing &&
            continuations
              .filter((c) => c.ready)
              .map((c) => (
                <Button
                  key={c.graphId}
                  variant="primary"
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
              className="flex-none rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] text-rose-600 dark:text-rose-400"
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
                <Button
                  onClick={() => setDiagnosing({ kind: "run", wfRunId })}
                  title={t("wf.diagnoseWhy")}
                >
                  <Stethoscope className="h-3.5 w-3.5" />
                  {t("wf.diagnose")}
                </Button>
              )}
            </>
          ) : (
            <>
              <select
                className="rounded-md border border-border bg-card px-2 py-1 text-[13px]"
                value=""
                onChange={(e) => e.target.value && addNode(e.target.value)}
              >
                <option value="">+ {t("wf.addNode")}</option>
                {nodeTypes.map((nt) => (
                  <option key={nt.type} value={nt.type}>
                    {nt.type}
                  </option>
                ))}
              </select>
              <Button variant="primary" onClick={() => void saveTopology()}>
                <Save className="h-3.5 w-3.5" />
                {t("wf.saveTopology")}
              </Button>
              <Button onClick={discardEdit}>
                <X className="h-3.5 w-3.5" />
                {t("wf.discard")}
              </Button>
              <span className="text-[11px] text-amber-600">{t("wf.editingHint")}</span>
            </>
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
          <span className="ml-auto flex items-center gap-2 text-[12px] text-muted-foreground">
            {IS_OVERRIDDEN && (
              <button
                onClick={resetApiBase}
                title={t("topbar.backToDefault")}
                className="flex cursor-pointer items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 font-mono text-[11px] text-amber-700 hover:bg-amber-500/25 dark:text-amber-400"
              >
                <ServerCog className="h-3.5 w-3.5" />
                {API_BASE.replace(/^https?:\/\//, "")}
              </button>
            )}
            {error && <span className="text-rose-500">{error}</span>}
            <span
              title={t(`proc.ws.${ws}`)}
              className={cn("h-2 w-2 rounded-full", ws === "open" ? "bg-emerald-500" : "bg-amber-500")}
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
                  {([
                    ["pan", Hand, "wf.toolPan"],
                    ["select", SquareDashedMousePointer, "wf.toolSelect"],
                  ] as const).map(([id, Icon, key]) => (
                    <button
                      key={id}
                      onClick={() => setTool(id)}
                      title={t(`${key}Why`)}
                      className={cn(
                        "flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] transition-colors",
                        tool === id ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {t(key)}
                    </button>
                  ))}
                </div>
              </Panel>
              {/* A four-node pipeline does not need a second view of itself; shrunk to a
                  locator so it stops competing with the artefacts for the corner. */}
              <MiniMap
                pannable
                zoomable
                className="!bg-muted/70"
                style={{ width: 108, height: 68 }}
              />
            </ReactFlow>
            </div>
            <RuntimeRail
              rt={runtime}
              nodeRuns={nodeRuns}
              open={railOpen}
              onToggle={() => setRailOpen((v) => !v)}
            />
            <TracePanel rows={trace} open={traceOpen} onToggle={() => setTraceOpen((v) => !v)} />
          </div>

          {/* The inspector is about a node, so it is a drawer over the canvas like every other
              overlay: same close, same drag-to-widen, and the pipeline it belongs to stays
              visible behind it. It used to be a permanent 380px column whose contents were
              "点一个节点看它的产物". */}
          <Drawer
            open={!!selectedNode}
            onClose={() => void selectNode("")}
            resizeKey="node"
            defaultWidth={520}
            title={
              <span className="flex items-baseline gap-2">
                <span className="font-mono">{selectedNode}</span>
                <span className="text-[11px] font-normal text-muted-foreground">
                  {def?.nodes.find((n) => n.id === selectedNode)?.type}
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
                  disabled={running || !wfRunId}
                  title={t("wf.runNodeWhy")}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  {t("wf.runNode")}
                </Button>
                <Button
                  onClick={() => void start({ node: selectedNode, mode: "from" })}
                  disabled={running || !wfRunId}
                  title={t("wf.runFromWhy")}
                >
                  <StepForward className="h-3.5 w-3.5" />
                  {t("wf.runFrom")}
                </Button>
                <Button onClick={() => toggleBreakpoint(selectedNode)} title={t("wf.breakpointWhy")}>
                  {breakpoints.includes(selectedNode) ? (
                    <CircleDot className="h-3.5 w-3.5 text-rose-500" />
                  ) : (
                    <Circle className="h-3.5 w-3.5" />
                  )}
                  {breakpoints.includes(selectedNode) ? t("wf.breakpointOff") : t("wf.breakpointOn")}
                </Button>
                {/* 问一个关于这一步的问题，答案就开在这一步旁边。 */}
                <Button
                  onClick={() => setDiagnosing({ kind: "node", node: selectedNode, wfRunId: wfRunId || undefined })}
                  title={t("wf.diagnoseWhy")}
                >
                  <Stethoscope className="h-3.5 w-3.5" />
                  {t("wf.diagnose")}
                </Button>
                {/* 两个「跑」都要求先有一次运行可以接着改：没有的话说清楚，而不是给一个灰按钮让人猜。 */}
                {!wfRunId && <span className="text-[11px] text-muted-foreground">{t("wf.needRun")}</span>}
              </div>
            )}

            {node && (
              <div className="border-b border-border p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] font-medium text-muted-foreground">{t("wf.params")}</span>
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
                <textarea
                  className="h-32 w-full resize-y rounded-md border border-border bg-card p-2 font-mono text-[11px]"
                  value={draft}
                  spellCheck={false}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setDirty(true);
                  }}
                />
                {issues.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-[11px] text-rose-600">
                    {issues.map((i, k) => (
                      <li key={k}>
                        {i.at.node ? `${i.at.node}: ` : ""}
                        {i.message}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-1 text-[10px] text-muted-foreground">{t("wf.saveHint")}</p>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {nodeDetail === undefined ? (
                <div className="text-[12px] text-muted-foreground">{t("wf.noOutput")}</div>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {JSON.stringify(nodeDetail, null, 2).slice(0, 20000)}
                </pre>
              )}
            </div>
            <div className="max-h-56 overflow-auto border-t border-border bg-muted p-2">
              <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
                {log.slice(-40).join("\n") || t("wf.noEvents")}
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
                  <span key={id} className="rounded bg-muted px-2 py-0.5 font-mono text-[11.5px]">
                    {id}
                  </span>
                ))}
              </div>

              <div className="mt-3 space-y-2">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
                  {t("wf.pickedBatch")}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => picked.filter((id) => !breakpoints.includes(id)).forEach(toggleBreakpoint)}
                  >
                    <CircleDot className="h-3.5 w-3.5" />
                    {t("wf.pickedBreakAll")}
                  </Button>
                  <Button onClick={() => picked.filter((id) => breakpoints.includes(id)).forEach(toggleBreakpoint)}>
                    <Circle className="h-3.5 w-3.5" />
                    {t("wf.pickedBreakNone")}
                  </Button>
                </div>

                <div className="pt-2 text-[11px] uppercase tracking-wider text-muted-foreground/70">
                  {t("wf.pickedSingleOnly")}
                </div>
                <p className="text-[12px] leading-relaxed text-muted-foreground">{t("wf.pickedWhySingle")}</p>
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
            />
          </Drawer>

          {/* Material cards and settings float over the canvas rather than replacing it:
              what you are looking at and where it came from stay in view together. */}
          {/* Run-scoped readers: these artefacts belong to this run, so they are read from
              it rather than from whichever project happens to be selected. */}
          {openId === "spec" && wfRunId && <SpecDrawer wfRunId={wfRunId} onClose={() => setOpenId("")} />}
          {openId === "stories" && wfRunId && <StoriesDrawer wfRunId={wfRunId} onClose={() => setOpenId("")} />}
          {openId && openId !== "spec" && openId !== "stories" && (
            <SurfacePanel surfaceId={openId} wfRunId={wfRunId} focus={openFocus} onClose={() => setOpenId("")} onSwitch={setOpenId} />
          )}
          {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
          {diagnosing && (
            <DiagnoseDrawer scope={diagnosing} onClose={() => setDiagnosing(undefined)} />
          )}
          {budgetOpen && <BudgetDrawer onClose={() => setBudgetOpen(false)} />}
        </div>
      </div>
    </>
  );
}
