import { create } from "zustand";
import type { EventEnvelope } from "./types";
import { connectEvents, type WsState } from "./ws";
import { API_BASE } from "./base";

const API = API_BASE;

/* ---- what the gateway serves ---- */

export interface GraphNodeDef {
  id: string;
  type: string;
  params?: Record<string, unknown>;
  /** Where it sits on the canvas. Layout only — the runtime reads edges, never positions. */
  pos?: { x: number; y: number };
}
export interface GraphEdgeDef {
  from: string;
  to: string;
}
export interface GraphDef {
  id: string;
  version: number;
  nodes: GraphNodeDef[];
  edges: GraphEdgeDef[];
}
export interface NodeTypeDef {
  type: string;
  title: string;
  description?: string;
  inKind: string | null;
  outKind: string;
}

export type NodeState = "idle" | "running" | "done" | "failed" | "skipped" | "paused";

export interface NodeRun {
  state: NodeState;
  ms?: number;
  tokens?: number;
  calls?: number;
  error?: string;
  /** Gate nodes report a score; it belongs on the node, where it is read. */
  gate?: { score: number; findings?: number };
  note?: string;
}

export interface WfRunSummary {
  id: string;
  graphId: string;
  graphVersion: number;
  status: string;
  /** 这次运行是为哪个项目跑的。旧运行没有——那时起运行不绑定项目。 */
  projectId?: string;
  startedAt: string;
  finishedAt?: string;
}

/**
 * What a run produced, as cards that hang under the node that produced them.
 *
 * Derived from the node outputs themselves rather than stored separately: the artefacts
 * ARE the outputs, and a second copy would be a second truth to keep in sync.
 */
export interface Artifact {
  id: string;
  node: string;
  title: string;
  value: string;
  sub: string;
  tone?: "warn";
  samples?: string[];
  /**
   * Which material card this artefact opens.
   *
   * A surface id rather than a URL: these are not places to navigate to, they are lenses on
   * this artefact, and they open over the canvas so what produced them stays in view.
   */
  opens?: { surface: string; label: string };
}

/** One line of the execution trace: a node entered, a model call, a gate verdict. */
export interface TraceRow {
  ts: string;
  kind: "run" | "node" | "model" | "gate" | "err";
  node: string;
  text: string;
  right: string;
}

/**
 * What the harness is doing to this run, as opposed to what the run produced.
 *
 * The prototype calls this the runtime rail, and it is the answer to "where is the harness
 * layer visible": admission, budget, ablation, prompt fingerprint and who decided each
 * verdict are all properties of the machinery, not of the product under test. They were
 * only ever visible as lines scrolling past in a log, which is the wrong place for state.
 */
export interface Runtime {
  /** The global model admission gate — calls are serial, so this is usually the queue. */
  gate: { limit: number; active: number; waiting: number };
  /** Spent so far on this run, and the caps it was started with (absent = uncapped). */
  spend: { calls: number; tokens: number; usd: number; ms: number };
  budget: { calls?: number; usd?: number; ms?: number };
  /** Components switched off for this run. Empty means everything was on. */
  ablate: string[];
  /** Fingerprint of the instructions that produced this run. */
  prompts: string;
  /** Failure attribution and who settled each verdict, counted from the run's own output. */
  fails: Record<string, number>;
  decided: { machine: number; judge: number };
}

export interface GraphVersion {
  version: number;
  savedAt: string;
  note?: string;
}

interface WfState {
  graphs: GraphDef[];
  nodeTypes: NodeTypeDef[];
  selectedGraph: string;
  runs: WfRunSummary[];
  wfRunId: string;
  runStatus: string;
  /**
   * 停在了哪个上限上。只有 `runStatus === "budget"` 时才有。
   *
   * 光有一个 "budget" 状态，人还得自己去比数字才知道是调用、金额还是时间到顶了——
   * 而那三样对应的下一步完全不同。
   */
  stoppedBy: "calls" | "usd" | "ms" | "";
  nodeRuns: Record<string, NodeRun>;
  outputs: Record<string, unknown>;
  artifacts: Artifact[];
  trace: TraceRow[];
  selectedNode: string;
  nodeDetail: unknown;
  log: string[];
  ws: WsState;
  error: string;
  issues: Array<{ at: { node?: string }; message: string }>;
  /**
   * Where the run should stop, and where it did.
   *
   * Kept next to the graph rather than inside it: a breakpoint is a thing you are doing
   * right now, not a property of the pipeline, and saving one would produce a new graph
   * version whose only difference is that somebody was debugging.
   */
  breakpoints: string[];
  pausedAt: string;
  runtime: Runtime;

  load: () => Promise<void>;
  selectGraph: (id: string) => void;
  selectRun: (wfRunId: string) => Promise<void>;
  selectNode: (nodeId: string) => Promise<void>;
  hydrateFromLineage: (wfRunId: string) => Promise<void>;
  loadArtifacts: (wfRunId: string) => Promise<void>;
  loadTrace: (wfRunId: string) => Promise<void>;
  /** Refresh the admission gate on its own — it moves while nothing else does. */
  loadGate: () => Promise<void>;
  /**
   * 能接着这次运行跑的图。
   *
   * 阶段一到 `gate` 就结束了——那不是停住，是跑完了，阶段二在另一张图里。这道坎在界面上
   * 看不见，人跑完只会问「然后呢」。
   */
  continuations: Array<{ graphId: string; fromNode: string; intoNode: string; ready: boolean }>;
  loadContinuations: () => Promise<void>;
  /** 用这次运行的产物作种子，起一次下一张图的运行。 */
  continueInto: (graphId: string) => Promise<void>;
  /**
   * 重新读一次当前运行：状态、逐节点耗费、产物、轨迹。
   *
   * 和 `selectRun` 的区别是它**不重放事件**，也不会和自己叠在一起跑。一次运行里节点接连完成，
   * 每完成一个都全量重取，就会有好几份请求同时在飞、各自把画布覆盖成不同的中间态——
   * 看上去就是节点在抖。
   */
  refreshRun: () => Promise<void>;
  /**
   * 项目换了，画布跟上。
   *
   * 面包屑写作 `项目 › 图 › 运行`，就得真的是这个关系。此前切项目只换了个标签，画布纹丝不动——
   * 因为运行只按图筛。现在：当前这次运行如果不属于新项目，就切到该项目最近的一次；
   * 一次都没有就回到「新运行」，画布清空。图不动——图是共享的流水线定义，不属于任何项目。
   */
  syncToProject: (projectId: string) => Promise<void>;
  start: (opts?: { mode?: "only" | "from"; node?: string; projectId?: string }) => Promise<void>;
  toggleBreakpoint: (nodeId: string) => void;
  /** Carry on from the breakpoint the run stopped at. */
  resume: () => Promise<void>;
  setBudget: (budget: { calls?: number; usd?: number; ms?: number } | null) => Promise<void>;
  /** Edit one node's params and save the graph as a new version. */
  saveNodeParams: (nodeId: string, params: unknown) => Promise<void>;

  /* ---- topology editing ----
   * A draft is held apart from the saved graph on purpose: half a rewiring is not a graph,
   * and the gateway should never be asked to store one. Nothing leaves the browser until
   * save, and save produces a new version like every other edit does.
   */
  draft?: GraphDef;
  versions: GraphVersion[];
  diffLines: string[];
  beginEdit: () => void;
  discardEdit: () => void;
  editDraft: (fn: (d: GraphDef) => GraphDef) => void;
  saveTopology: (note?: string) => Promise<void>;
  loadVersions: (id?: string) => Promise<void>;
  loadDiff: (from: number, to: number) => Promise<void>;
  cancel: () => Promise<void>;
  connect: () => void;
}

let close: (() => void) | null = null;
const LOG_CAP = 200;

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T & { error?: string; issues?: unknown };
  if (!res.ok) {
    // Validation issues travel with the error: the canvas highlights the node that broke.
    const err = new Error(body.error ?? `HTTP ${res.status}`) as Error & { issues?: unknown };
    err.issues = body.issues;
    throw err;
  }
  return body;
}

/** Set while a refresh is in flight, so overlapping node-finished events collapse into one. */
let refreshing = false;

interface RunDetailShape {
  nodes?: Array<{ nodeId: string; status: string; ms: number; spend?: { calls: number; tokens: number } }>;
  breakpoints?: string[];
  pausedAt?: string;
  spend?: { calls: number; tokens: number; usd: number; ms: number };
  budget?: { calls?: number; usd?: number; ms?: number };
  /** 停在了哪个上限上。只有 `status === "budget"` 时才有。 */
  stoppedBy?: "calls" | "usd" | "ms";
  ablate?: string[];
  prompts?: { combined?: string; entries?: Record<string, string> };
}

/**
 * The per-node record a run's detail carries, merged over what the canvas already shows.
 *
 * Merged rather than replaced: a node that is running right now has no entry in `detail`
 * yet — it only appears once it finishes — so a plain replacement would blank the very node
 * the person is watching.
 */
function nodeRunsFrom(detail: RunDetailShape | undefined, current: Record<string, NodeRun>): Record<string, NodeRun> {
  const next: Record<string, NodeRun> = { ...current };
  for (const n of detail?.nodes ?? [])
    next[n.nodeId] = {
      state: n.status === "done" ? "done" : n.status === "failed" ? "failed" : "skipped",
      ms: n.ms,
      calls: n.spend?.calls,
      tokens: n.spend?.tokens,
    };
  const paused = detail?.pausedAt;
  if (paused) next[paused] = { ...next[paused], state: "paused" };
  return next;
}

const EMPTY_RUNTIME: Runtime = {
  gate: { limit: 1, active: 0, waiting: 0 },
  spend: { calls: 0, tokens: 0, usd: 0, ms: 0 },
  budget: {},
  ablate: [],
  prompts: "",
  fails: {},
  decided: { machine: 0, judge: 0 },
};

export const useWf = create<WfState>((set, get) => ({
  graphs: [],
  nodeTypes: [],
  selectedGraph: "",
  runs: [],
  wfRunId: "",
  runStatus: "",
  stoppedBy: "",
  nodeRuns: {},
  outputs: {},
  artifacts: [],
  trace: [],
  selectedNode: "",
  nodeDetail: undefined,
  log: [],
  ws: "closed",
  error: "",
  issues: [],
  breakpoints: [],
  pausedAt: "",
  runtime: EMPTY_RUNTIME,
  continuations: [],
  draft: undefined,
  versions: [],
  diffLines: [],

  load: async () => {
    try {
      const [{ graphs }, { nodeTypes }, { runs }] = await Promise.all([
        json<{ graphs: GraphDef[] }>("/api/graphs"),
        json<{ nodeTypes: NodeTypeDef[] }>("/api/node-types"),
        json<{ runs: WfRunSummary[] }>("/api/wf/runs"),
      ]);
      set({
        graphs,
        nodeTypes,
        runs,
        error: "",
        selectedGraph: get().selectedGraph || graphs[0]?.id || "",
      });
      // Land on the newest run for the selected graph, so opening the page shows the last
      // thing that happened rather than an empty canvas.
      const latest = runs.find((r) => r.graphId === (get().selectedGraph || graphs[0]?.id));
      if (latest && !get().wfRunId) await get().selectRun(latest.id);
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  // Switching graphs abandons a draft rather than carrying it across: a draft belongs to
  // the graph it was started from, and silently moving it would be a way to lose work.
  selectGraph: (id) =>
    set({
      selectedGraph: id,
      nodeRuns: {},
      outputs: {},
      selectedNode: "",
      nodeDetail: undefined,
      breakpoints: [],
      pausedAt: "",
      runtime: EMPTY_RUNTIME,
      continuations: [],
      draft: undefined,
      versions: [],
      diffLines: [],
    }),

  selectRun: async (wfRunId) => {
    try {
      const { run, outputs } = await json<{
        run: WfRunSummary & {
          detail?: {
            nodes?: Array<{ nodeId: string; status: string; ms: number; spend?: { calls: number; tokens: number } }>;
            breakpoints?: string[];
            pausedAt?: string;
            spend?: { calls: number; tokens: number; usd: number; ms: number };
            budget?: { calls?: number; usd?: number; ms?: number };
            stoppedBy?: "calls" | "usd" | "ms";
            ablate?: string[];
            /** `combined` is the fingerprint over every prompt; `entries` says which one moved. */
            prompts?: { combined?: string; entries?: Record<string, string> };
          };
        };
        outputs: Record<string, unknown>;
      }>(`/api/wf/runs/${wfRunId}`);
      const nodeRuns: Record<string, NodeRun> = {};
      for (const n of run.detail?.nodes ?? [])
        nodeRuns[n.nodeId] = {
          state: n.status === "done" ? "done" : n.status === "failed" ? "failed" : "skipped",
          ms: n.ms,
          calls: n.spend?.calls,
          tokens: n.spend?.tokens,
        };
      const pausedAt = run.detail?.pausedAt ?? "";
      // A paused node never finished, so it has no record among `nodes`; without this the
      // canvas shows the run stopped but not where.
      if (pausedAt) nodeRuns[pausedAt] = { ...nodeRuns[pausedAt], state: "paused" };
      set({
        wfRunId,
        runStatus: run.status,
        stoppedBy: run.status === "budget" ? run.detail?.stoppedBy ?? "" : "",
        nodeRuns,
        outputs,
        selectedGraph: run.graphId,
        // The run is what remembers its breakpoints: reopening the page must not lose them.
        breakpoints: run.detail?.breakpoints ?? get().breakpoints,
        pausedAt,
        // Attribution counts are filled in by loadArtifacts, which is the only place that
        // reads the execution node's per-case verdicts. Everything else is on the run.
        runtime: {
          ...get().runtime,
          spend: run.detail?.spend ?? EMPTY_RUNTIME.spend,
          budget: run.detail?.budget ?? {},
          ablate: run.detail?.ablate ?? [],
          prompts: run.detail?.prompts?.combined ?? "",
          fails: {},
          decided: { machine: 0, judge: 0 },
        },
      });
      // A run in progress has no finished-node record yet, so opening the page mid-run
      // would show an empty graph. Lineage has every transition — replay this run's.
      if (run.status === "running") await get().hydrateFromLineage(wfRunId);
      void get().loadArtifacts(wfRunId);
      void get().loadTrace(wfRunId);
      void get().loadGate();
      void get().loadContinuations();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  loadGate: async () => {
    try {
      const q = await json<{ model: Runtime["gate"] }>("/api/queue");
      set((st) => ({ runtime: { ...st.runtime, gate: q.model } }));
    } catch {
      /* the gateway is down; the rail keeps the last reading rather than inventing one */
    }
  },

  loadContinuations: async () => {
    const id = get().wfRunId;
    if (!id) return set({ continuations: [] });
    try {
      const { continuations } = await json<{ continuations: WfState["continuations"] }>(
        `/api/wf/runs/${id}/continuations`,
      );
      set({ continuations });
    } catch {
      set({ continuations: [] });
    }
  },

  continueInto: async (graphId) => {
    const id = get().wfRunId;
    if (!id) return;
    try {
      const { wfRunId } = await json<{ wfRunId: string }>(`/api/wf/runs/${id}/continue`, {
        method: "POST",
        body: JSON.stringify({ graphId }),
      });
      // 跟着跳到新运行上：接着跑的重点就是看后半段，留在已经跑完的那次上没有意义。
      set({ selectedGraph: graphId, error: "" });
      await get().selectRun(wfRunId);
      const { runs } = await json<{ runs: WfRunSummary[] }>("/api/wf/runs");
      set({ runs });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  refreshRun: async () => {
    const id = get().wfRunId;
    if (!id || refreshing) return;
    refreshing = true;
    try {
      const { run, outputs } = await json<{
        run: WfRunSummary & { detail?: RunDetailShape };
        outputs: Record<string, unknown>;
      }>(`/api/wf/runs/${id}`);
      if (get().wfRunId !== id) return; // 期间人换了运行，这份结果已经不是他要看的了
      const nodeRuns = nodeRunsFrom(run.detail, get().nodeRuns);
      set({
        runStatus: run.status,
        stoppedBy: run.status === "budget" ? run.detail?.stoppedBy ?? "" : "",
        nodeRuns,
        outputs,
        pausedAt: run.detail?.pausedAt ?? "",
        runtime: {
          ...get().runtime,
          spend: run.detail?.spend ?? get().runtime.spend,
          budget: run.detail?.budget ?? get().runtime.budget,
          ablate: run.detail?.ablate ?? get().runtime.ablate,
          prompts: run.detail?.prompts?.combined ?? get().runtime.prompts,
        },
      });
      await get().loadArtifacts(id);
      await get().loadTrace(id);
      await get().loadContinuations();
      const { runs } = await json<{ runs: WfRunSummary[] }>("/api/wf/runs");
      set({ runs });
    } catch {
      /* a refresh that fails leaves the canvas as it was, which is better than blanking it */
    } finally {
      refreshing = false;
    }
  },

  syncToProject: async (projectId) => {
    const { runs, wfRunId, selectedGraph } = get();
    const current = runs.find((r) => r.id === wfRunId);
    if (current && (current.projectId ?? "") === projectId) return;
    const mine = runs.filter((r) => (r.projectId ?? "") === projectId && r.graphId === selectedGraph);
    if (mine[0]) return void (await get().selectRun(mine[0].id));
    // 该项目在这张图上还没有运行：清空到「新运行」，而不是留着别人的产物冒充这里的。
    set({
      wfRunId: "",
      runStatus: "",
      nodeRuns: {},
      outputs: {},
      artifacts: [],
      trace: [],
      pausedAt: "",
      selectedNode: "",
      nodeDetail: undefined,
    });
  },

  hydrateFromLineage: async (wfRunId) => {
    try {
      const { events } = await json<{ events: EventEnvelope[] }>("/api/events?limit=800");
      // Replayed, not live: these events already happened, and letting them trigger the
      // same refreshes a live event does turns replay into a loop — the refresh re-replays,
      // which refreshes again. That loop is what made the canvas shake.
      for (const e of events) if (e.scope.wfRunId === wfRunId) handle(set, get, e, false);
    } catch {
      /* the graph will fill in from live events instead */
    }
  },

  /**
   * Read the products of this run and turn them into cards.
   *
   * Only the nodes that actually ran are asked for, and a node whose output is missing is
   * simply absent — an empty card claiming "0 cases" would be a statement about the run
   * that the run never made.
   */
  loadArtifacts: async (wfRunId) => {
    const outputs = get().outputs;
    const has = (id: string) => Object.prototype.hasOwnProperty.call(outputs, id);
    const nodes = Object.keys(outputs);
    const full: Record<string, any> = {};
    await Promise.all(
      nodes.map(async (id) => {
        try {
          const { output } = await json<{ output: unknown }>(`/api/wf/runs/${wfRunId}/nodes/${id}`);
          full[id] = output;
        } catch {
          /* a node with no stored output simply has no card */
        }
      }),
    );

    const cards: Artifact[] = [];
    const specNode = has("spec") ? "spec" : has("explore") ? "explore" : "";
    if (specNode && full[specNode]) {
      const origin = String(full[specNode].origin ?? "");
      const parts = origin.split(",").map((x) => x.trim()).filter(Boolean);
      // 规格是**怎么来的**，必须在卡片上说出来。看出来的规格描述的是现状，不是意图——
      // 由它推出的用例只能发现「产品变了」，不可能发现「产品错了」。这句话不摆在人眼前，
      // 一套完全建立在观察之上的绿色套件就会被读成「产品是对的」。
      const from = String(full[specNode].derivedFrom ?? "document");
      cards.push({
        id: "a-spec", node: specNode,
        title: from === "exploration" ? "规格材料 · 探索得来" : from === "codebase" ? "规格材料 · 由代码推得" : "规格材料",
        value: String(parts.length || 1),
        sub: from === "exploration"
          ? "描述现状而非意图：由它产出的用例只能发现「变了」"
          : parts.map((x) => x.split("/").pop()).join(" · ").slice(0, 42) || origin,
        tone: from === "exploration" ? "warn" : undefined,
        // Not a surface card: the material belongs to this run, so it opens its own drawer
        // reading what this run actually captured rather than today's file on disk.
        opens: { surface: "spec", label: "读全文" },
      });
    }
    if (full.stories?.stories) {
      const st = full.stories.stories as Array<{ id: string; source?: string }>;
      const docs = new Set(st.map((x) => x.source).filter(Boolean));
      cards.push({
        id: "a-stories", node: "stories", title: "用户故事", value: String(st.length),
        sub: docs.size ? `来自 ${docs.size} 份文档` : "故事树",
        opens: { surface: "stories", label: "读故事" },
      });
    }
    if (full.design?.cases) {
      const cs = full.design.cases as Array<{ title: string }>;
      cards.push({
        id: "a-cases", node: "design", title: "文本用例", value: String(cs.length),
        sub: `抽样 ${Math.min(3, cs.length)} 条`, samples: cs.slice(0, 3).map((c) => c.title),
        // 这次运行的一百条在复核队列里，不在看板上——看板是「已经批准的那些」。
        opens: { surface: "review", label: "看这批用例" },
      });
    }
    const gated = full.gate ?? full.codegen;
    if (gated?.gate) {
      const g = gated.gate as { score?: number; findings?: unknown[]; stats?: any };
      cards.push({
        id: "a-gate", node: full.gate ? "gate" : "codegen", title: "门禁①",
        value: `${Math.round((g.score ?? 0) * 100)}%`,
        sub: `${g.findings?.length ?? 0} 条 finding · 负例 ${Math.round((g.stats?.negativeRatio ?? 0) * 100)}%`,
        opens: { surface: "review", label: "去复核" },
      });
      // The claim and what can be delivered, side by side: this gap is the number worth
      // watching, and no other page reports it.
      const backed = (g.stats?.tiersBacked ?? {}) as Record<string, number>;
      const total = Object.values(backed).reduce((a, b) => a + b, 0);
      const machine = (backed["1"] ?? 0) + (backed["2"] ?? 0);
      if (total)
        cards.push({
          id: "a-tier", node: full.gate ? "gate" : "codegen", title: "判据有据率",
          value: `${Math.round((machine / total) * 100)}%`,
          sub: `声称 ${Object.entries((g.stats?.tiers ?? {}) as Record<string, number>).map(([k, v]) => `${v}×t${k}`).join(" ")}`,
          tone: machine === 0 ? "warn" : undefined,
        });
    }
    const coded = full.repair ?? full.codegate ?? full.codegen;
    if (coded?.code) {
      cards.push({
        id: "a-code", node: full.repair ? "repair" : full.codegate ? "codegate" : "codegen",
        title: "用例代码", value: String((coded.code as unknown[]).length),
        opens: { surface: "code", label: "打开代码线" },
        sub: coded.gate?.score !== undefined ? `门禁② ${Number(coded.gate.score).toFixed(2)}` : "已生成",
      });
    }
    if (full.repair?.repair) {
      const r = full.repair.repair as { loosePassRate?: number; strictPassRate?: number; outcomes?: unknown[]; degraded?: unknown[] };
      const n = r.outcomes?.length ?? 0;
      const passed = Math.round((r.loosePassRate ?? 0) * n);
      cards.push({
        id: "a-runs", node: "repair", title: "执行", value: `${passed}/${n}`,
        opens: { surface: "runs", label: "看执行记录" },
        sub: `loose ${(r.loosePassRate ?? 0).toFixed(2)} · strict ${(r.strictPassRate ?? 0).toFixed(2)} · 退化 ${r.degraded?.length ?? 0}`,
        tone: (r.degraded?.length ?? 0) > 0 ? "warn" : undefined,
      });
    }
    // Attribution: which failures were the product's and which were the environment's, and
    // who settled each verdict. Counted from the run's own outcomes rather than from a
    // separate tally, so the rail cannot disagree with the artifact card beside it.
    const fails: Record<string, number> = {};
    const decided = { machine: 0, judge: 0 };
    const outcomes = (full.repair?.repair?.outcomes ?? []) as Array<{
      status?: string; kind?: string; failKind?: string; oracle?: Array<{ decidedBy?: string }>;
    }>;
    for (const o of outcomes) {
      if (o.status && o.status !== "passed") {
        const k = o.failKind ?? o.kind ?? "unknown";
        fails[k] = (fails[k] ?? 0) + 1;
      }
      for (const a of o.oracle ?? []) {
        if (a.decidedBy === "machine") decided.machine += 1;
        else if (a.decidedBy === "judge") decided.judge += 1;
      }
    }
    set((st) => ({ artifacts: cards, runtime: { ...st.runtime, fails, decided } }));
    void has;
  },

  /**
   * The execution trace, read from lineage.
   *
   * The chat is a narrative and scrolls away; this is what the run actually did, in order,
   * and it is already recorded — every `wf.*` event carries its node scope.
   */
  loadTrace: async (wfRunId) => {
    try {
      const { events } = await json<{ events: EventEnvelope[] }>("/api/events?limit=1000");
      const mine = events.filter((e) => e.scope.wfRunId === wfRunId);
      const rows: TraceRow[] = [];
      for (const e of mine) {
        const p = e.payload as Record<string, any>;
        const ts = String(e.ts).slice(11, 19);
        const node = String(p.nodeId ?? e.scope.nodeRunId ?? "—").split(":").pop() ?? "—";
        if (e.kind === "wf.run.started")
          rows.push({ ts, kind: "run", node: "—", text: `${p.graphId} v${p.graphVersion} · ${(p.nodes ?? []).length} 个节点${(p.ablated ?? []).length ? ` · 消融 ${(p.ablated as string[]).join(",")}` : ""}`, right: "" });
        else if (e.kind === "wf.node.started") rows.push({ ts, kind: "node", node, text: `进入 ${p.type}`, right: "" });
        else if (e.kind === "wf.node.finished")
          rows.push({
            ts, kind: p.status === "done" ? "node" : "err", node,
            text: p.status === "done" ? "完成" : `失败：${String(p.error ?? "").slice(0, 90)}`,
            right: [p.ms ? `${(Number(p.ms) / 1000).toFixed(1)}s` : "", p.spend?.calls ? `${p.spend.calls} calls` : "", p.spend?.tokens ? `${p.spend.tokens} tok` : ""].filter(Boolean).join(" · "),
          });
        else if (e.kind === "gate.result")
          rows.push({ ts, kind: "gate", node, text: `门禁 ${p.gate} · ${Math.round(Number(p.score ?? 0) * 100)}% · ${p.findings} 条 finding`, right: "" });
        else if (e.kind === "wf.node.output" && p.storyId)
          rows.push({ ts, kind: "model", node, text: `${p.storyId} → ${p.produced} 条`, right: "" });
        else if (e.kind === "run.finished")
          rows.push({ ts, kind: p.status === "passed" ? "node" : "err", node: String(p.caseId ?? "").slice(0, 18), text: `执行 ${p.status}${p.failKind ? ` · ${p.failKind}` : ""}`, right: "" });
        else if (e.kind === "repair.round")
          rows.push({ ts, kind: "model", node: String(p.caseId ?? "").slice(0, 18), text: `修复第 ${p.round} 轮 · ${(p.changes ?? []).join(" · ")}`, right: "" });
        else if (e.kind === "wf.paused")
          rows.push({ ts, kind: "err", node, text: `停在断点前（${p.reason}）`, right: "" });
      }
      set({ trace: rows });
    } catch {
      set({ trace: [] });
    }
  },

  selectNode: async (nodeId) => {
    set({ selectedNode: nodeId, nodeDetail: undefined });
    if (!get().wfRunId) return;
    try {
      const { output } = await json<{ output: unknown }>(`/api/wf/runs/${get().wfRunId}/nodes/${nodeId}`);
      set({ nodeDetail: output });
    } catch {
      set({ nodeDetail: undefined }); // the node has not produced anything yet
    }
  },

  start: async (opts) => {
    try {
      const { wfRunId } = get();
      const path =
        opts?.node && wfRunId
          ? `/api/wf/runs/${wfRunId}/nodes/${opts.node}/run?mode=${opts.mode ?? "only"}`
          : "/api/wf/runs";
      const body =
        opts?.node && wfRunId
          ? {}
          : {
              graphId: get().selectedGraph,
              breakpoints: get().breakpoints,
              // Bind the run to the project it is being started for. Without this every run
              // from the workspace was unbound, its products could not be approved onto any
              // board without picking a project again at the far end, and the cards on its
              // own artefacts pointed at whatever project happened to be selected.
              ...(opts?.projectId ? { target: { projectId: opts.projectId } } : {}),
            };
      const res = await json<{ wfRunId: string }>(path, { method: "POST", body: JSON.stringify(body) });
      const whole = !opts?.node;
      set({
        wfRunId: res.wfRunId,
        runStatus: "running",
        error: "",
        nodeRuns: whole ? {} : get().nodeRuns,
        pausedAt: "",
        log: [],
        // A fresh run has produced nothing yet. Leaving the previous run's cards on the
        // canvas made them read as this run's — and clicking one opened the *new* run's
        // (empty) output under the *old* run's numbers, which is worse than showing nothing.
        ...(whole ? { artifacts: [], trace: [], outputs: {} } : {}),
        // The picker is how a run is returned to; a run missing from it looks like it was
        // never started, and the box falls back to reading "新运行" while one is in flight.
        runs: get().runs.some((r) => r.id === res.wfRunId)
          ? get().runs
          : [
              {
                id: res.wfRunId,
                graphId: get().selectedGraph,
                graphVersion: get().graphs.find((g) => g.id === get().selectedGraph)?.version ?? 0,
                status: "running",
                startedAt: new Date().toISOString(),
                // Carry the binding on the optimistic row too, or the run reads as
                // "未绑定项目" until the list is refetched — which is the opposite of true.
                ...(opts?.projectId ? { projectId: opts.projectId } : {}),
              },
              ...get().runs,
            ],
      });
      get().connect();
      // Catch up, because the run can outrun its own HTTP response: a graph that stops at a
      // breakpoint in the first node finishes in milliseconds, and every event it will ever
      // publish is gone before this browser learns the run's id. The live stream only carries
      // what happens next, so without this the canvas sits at "running" for a run that has
      // already stopped.
      //
      // Three reads rather than one: the first can arrive before the gateway has even
      // recorded the ending. They stop as soon as the run is no longer running, so a normal
      // run — minutes long, with events flowing — pays for exactly one.
      void (async () => {
        for (const delay of [200, 1000, 3000]) {
          await new Promise((r) => setTimeout(r, delay));
          if (get().wfRunId !== res.wfRunId) return;
          await get().refreshRun();
          if (get().runStatus !== "running") return;
        }
      })();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  toggleBreakpoint: (nodeId) =>
    set({
      breakpoints: get().breakpoints.includes(nodeId)
        ? get().breakpoints.filter((b) => b !== nodeId)
        : [...get().breakpoints, nodeId],
    }),

  /**
   * 改这次运行的上限，或者撤掉它（传 `null`）。
   *
   * 撞了上限的运行只接受这一件事，然后才能继续。把「继续」做成顺手提高上限，
   * 等于让上限在最容易被忽略的那一刻失效——而那正是它该起作用的一刻。
   */
  setBudget: async (budget) => {
    const { wfRunId } = get();
    if (!wfRunId) return;
    try {
      const r = await json<{ budget: Runtime["budget"] | null }>(`/api/wf/runs/${wfRunId}/budget`, {
        method: "PATCH",
        body: JSON.stringify({ budget }),
      });
      set({ runtime: { ...get().runtime, budget: r.budget ?? {} }, error: "" });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  resume: async () => {
    const { wfRunId } = get();
    if (!wfRunId) return;
    try {
      await json(`/api/wf/runs/${wfRunId}/resume`, { method: "POST" });
      set({ runStatus: "running", pausedAt: "", error: "" });
      get().connect();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  saveNodeParams: async (nodeId, params) => {
    const def = get().graphs.find((g) => g.id === get().selectedGraph);
    if (!def) return;
    const next = {
      ...def,
      nodes: def.nodes.map((n) => (n.id === nodeId ? { ...n, params: params as Record<string, unknown> } : n)),
    };
    try {
      // The gateway validates before storing and answers with a NEW version: an edit can
      // never rewrite the meaning of a run that already happened.
      const { graph } = await json<{ graph: GraphDef }>("/api/graphs", {
        method: "POST",
        body: JSON.stringify(next),
      });
      set({
        graphs: get().graphs.map((g) => (g.id === graph.id ? graph : g)),
        issues: [],
        error: "",
      });
    } catch (e) {
      const err = e as Error & { issues?: Array<{ at: { node?: string }; message: string }> };
      set({ error: err.message, issues: err.issues ?? [] });
    }
  },

  beginEdit: () => {
    const def = get().graphs.find((g) => g.id === get().selectedGraph);
    if (def) set({ draft: structuredClone(def), issues: [], error: "", diffLines: [] });
  },

  discardEdit: () => set({ draft: undefined, issues: [], error: "" }),

  editDraft: (fn) => {
    const draft = get().draft;
    if (draft) set({ draft: fn(structuredClone(draft)), issues: [] });
  },

  saveTopology: async (note) => {
    const draft = get().draft;
    if (!draft) return;
    try {
      const { graph } = await json<{ graph: GraphDef }>("/api/graphs", {
        method: "POST",
        body: JSON.stringify({ ...draft, note }),
      });
      set({
        graphs: get().graphs.map((g) => (g.id === graph.id ? graph : g)),
        draft: undefined,
        issues: [],
        error: "",
      });
      await get().loadVersions(graph.id);
    } catch (e) {
      // A rejected topology keeps the draft: the person is mid-edit, and throwing their
      // work away to show them an error message is the wrong trade.
      const err = e as Error & { issues?: Array<{ at: { node?: string }; message: string }> };
      set({ error: err.message, issues: err.issues ?? [] });
    }
  },

  loadVersions: async (id) => {
    const graphId = id ?? get().selectedGraph;
    if (!graphId) return;
    try {
      const { versions } = await json<{ versions: GraphVersion[] }>(`/api/graphs/${graphId}/versions`);
      set({ versions });
    } catch {
      set({ versions: [] });
    }
  },

  loadDiff: async (from, to) => {
    try {
      const { lines } = await json<{ lines: string[] }>(
        `/api/graphs/${get().selectedGraph}/diff?from=${from}&to=${to}`,
      );
      set({ diffLines: lines, error: "" });
    } catch (e) {
      set({ diffLines: [], error: (e as Error).message });
    }
  },

  cancel: async () => {
    if (!get().wfRunId) return;
    await json(`/api/wf/runs/${get().wfRunId}/cancel`, { method: "POST" }).catch(() => undefined);
  },

  connect: () => {
    if (close) return;
    close = connectEvents({
      onState: (ws) => set({ ws }),
      onEvent: (e) => handle(set, get, e, true),
      onProtocolMismatch: (message) => set({ error: message }),
    });
  },
}));

type Set = (partial: Partial<WfState>) => void;
type Get = () => WfState;

/**
 * Apply one lineage event to the canvas.
 *
 * `live` says whether this event is arriving now or being replayed from history. Only a live
 * event may ask for a refresh: a replayed one describes a state the refresh itself just
 * fetched, so acting on it feeds the loop that produced it.
 */
function handle(set: Set, get: Get, e: EventEnvelope, live: boolean): void {
  const wfRunId = get().wfRunId;
  if (wfRunId && e.scope.wfRunId && e.scope.wfRunId !== wfRunId) return;
  const p = e.payload as Record<string, unknown>;
  const nodeId = String(p.nodeId ?? "");
  const patch = (state: Partial<NodeRun>) =>
    set({ nodeRuns: { ...get().nodeRuns, [nodeId]: { ...(get().nodeRuns[nodeId] ?? { state: "idle" }), ...state } } });

  switch (e.kind) {
    case "wf.run.started":
      set({ runStatus: "running", nodeRuns: {} });
      break;
    case "wf.run.finished":
      set({ runStatus: String(p.status ?? "") });
      // Reload the run itself and the list: the selector otherwise keeps showing the
      // status the run had when the page opened.
      if (live) void get().refreshRun();
      void json<{ runs: WfRunSummary[] }>("/api/wf/runs").then(({ runs }) => set({ runs })).catch(() => undefined);
      break;
    case "wf.node.started":
      patch({ state: "running" });
      break;
    case "wf.node.finished":
      patch({
        state: p.status === "done" ? "done" : "failed",
        ms: Number(p.ms ?? 0),
        calls: Number((p.spend as { calls?: number } | undefined)?.calls ?? 0),
        tokens: Number((p.spend as { tokens?: number } | undefined)?.tokens ?? 0),
        error: p.error ? String(p.error) : undefined,
      });
      // A stage just produced something, so the artefact layer has one more card to show.
      // It used to appear only when the run was re-selected, which meant watching a run
      // told you which box was busy and nothing about what came out of it.
      if (live && p.status === "done") void get().refreshRun();
      break;
    case "gate.result":
      patch({ gate: { score: Number(p.score ?? 0), findings: Number(p.findings ?? 0) } });
      break;
    case "wf.paused":
      set({ runStatus: `paused: ${String(p.reason ?? "")}` });
      // Which node it stopped in front of is the whole point of stopping; a status line
      // saying "paused" without it leaves you hunting for the node.
      // Stopping is when you most want to see what has been produced so far — that is what
      // a breakpoint is for. Refreshing only on "finished" left the canvas blank at exactly
      // the moment it was asked to be useful.
      if (live) void get().refreshRun();
      if (nodeId) {
        set({ pausedAt: nodeId });
        patch({ state: "paused", note: String(p.reason ?? "") });
      }
      break;
    case "wf.node.output":
    case "log":
    case "repair.round":
    case "run.finished": {
      const text =
        e.kind === "log"
          ? String((p as { text?: string }).text ?? "")
          : `${e.kind} ${JSON.stringify(p).slice(0, 160)}`;
      if (text) set({ log: [...get().log, text].slice(-LOG_CAP) });
      break;
    }
  }

  // The trace is rebuilt from lineage whenever the run is refreshed, and a refresh only
  // happens when a node finishes. During a long step — a model call takes minutes — that
  // left it reading "还没有留下轨迹" while work was visibly happening, which is the one
  // moment it exists for. Live events append to it directly.
  if (live) {
    const row = traceRowFor(e);
    if (row) set({ trace: [...get().trace, row].slice(-TRACE_CAP) });
  }
}

const TRACE_CAP = 400;

/**
 * One live event as a trace row, or nothing when the event says nothing worth a line.
 *
 * Deliberately the same shapes the lineage rebuild produces, so a row that appeared live and
 * the same row after a refresh read identically — a trace whose wording changes underneath
 * you is worse than one that arrives late.
 */
function traceRowFor(e: EventEnvelope): TraceRow | undefined {
  const p = e.payload as Record<string, any>;
  const ts = String(e.ts).slice(11, 19);
  const node = String(p.nodeId ?? e.scope.nodeRunId ?? "—").split(":").pop() ?? "—";
  switch (e.kind) {
    case "wf.node.started":
      return { ts, kind: "node", node, text: `进入 ${p.type}`, right: "" };
    case "wf.node.finished":
      return {
        ts,
        kind: p.status === "done" ? "node" : "err",
        node,
        text: p.status === "done" ? "完成" : `失败：${String(p.error ?? "").slice(0, 90)}`,
        right: [p.ms ? `${(Number(p.ms) / 1000).toFixed(1)}s` : "", p.spend?.calls ? `${p.spend.calls} calls` : ""]
          .filter(Boolean)
          .join(" · "),
      };
    case "gate.result":
      return { ts, kind: "gate", node, text: `门禁 ${p.gate} · ${Math.round(Number(p.score ?? 0) * 100)}%`, right: "" };
    case "wf.node.output":
      return p.storyId ? { ts, kind: "model", node, text: `${p.storyId} → ${p.produced} 条`, right: "" } : undefined;
    case "repair.round":
      return { ts, kind: "model", node: String(p.caseId ?? "").slice(0, 18), text: `修复第 ${p.round} 轮`, right: "" };
    case "run.finished":
      return {
        ts,
        kind: p.status === "passed" ? "node" : "err",
        node: String(p.caseId ?? "").slice(0, 18),
        text: `执行 ${p.status}${p.failKind ? ` · ${p.failKind}` : ""}`,
        right: "",
      };
    case "wf.paused":
      return { ts, kind: "err", node, text: `停在断点前（${p.reason}）`, right: "" };
    default:
      return undefined;
  }
}
