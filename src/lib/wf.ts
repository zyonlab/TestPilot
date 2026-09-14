import { create } from "zustand";
import { tOutsideReact } from "@/lib/prefs";
import { tOutsideReact as tr } from "./prefs";
import type { EventEnvelope } from "./types";
import { connectEvents, type WsState } from "./ws";
import { API_BASE } from "./base";
import type { ParamShape } from "@/components/ParamForm";

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
  /** 图定义自带的人话标题与一句话说明——见 harness-core 的 GraphDef。 */
  title?: string;
  description?: string;
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
  /** 这个节点收哪些参数。由 `NodeRegistry.list()` 从 zod schema 上读出来。 */
  params?: ParamShape;
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

/**
 * 正在看的是哪一次运行，**记在地址栏里**。
 *
 * 之前它只活在内存里，后果有两个，都很实在：
 *   · 刷新一下就回到「最近那一次」，人正在读的那一批没了；
 *   · **没法把「请复核这一次」发给人**——而这正是复核这件事的核心动作。
 *     对方只能自己在几十个 `wf-mtczz1xw · done` 里猜。
 *
 * 只存运行 id 就够：图和项目都能从这一次运行本身推出来，
 * 多存两个字段只会多两个能对不上的地方。
 */
export const runFromHash = (): string =>
  new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("run") ?? "";

export function writeRunToHash(wfRunId: string): void {
  const [path, query] = window.location.hash.split("?");
  const params = new URLSearchParams(query ?? "");
  if (params.get("run") === wfRunId) return;
  if (wfRunId) params.set("run", wfRunId);
  else params.delete("run");
  // 换了运行，上一处落点就作废了——它指的是上一次运行里的某条边。
  params.delete("at");
  const q = params.toString();
  const next = `${path || "#/"}${q ? `?${q}` : ""}`;
  // replaceState 而不是改 hash：换运行不该往后退历史里堆一层，
  // 否则「返回」变成一次一次倒着走过所有看过的运行。
  window.history.replaceState(null, "", next);
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
  /** 这次运行改过哪几个节点的参数、关掉过哪些组件——它不是这张图的基线成绩。 */
  overridden?: string[];
  ablated?: string[];
  /** 打的是哪里（`resolveTarget` 那句人话），以及只取环境名的那一半。 */
  describe?: string;
  envName?: string;
  /** 这次运行给的上限与实际花掉的——「21 次调用」是多还是少，取决于上限。 */
  budget?: { calls?: number; usd?: number; ms?: number };
  spend?: { calls?: number; tokens?: number; usd?: number; ms?: number };
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
 * The prototype calls this the runtime rail, and it is the answer to"where is the harness
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

/**
 * 「这次它看得到什么」——一次运行的可复现性上下文。
 *
 * 这是右栏第三节的内容，也是两个月后回头看这次运行时唯一能回答
 * 「它当时打的是哪里、读的什么、用哪一版图」的东西。
 * 每一项在服务端都已经按值记进了运行记录（见 `RunDetail.targetSnapshot` / `materials`），
 * 前端此前一项都没读——数据在库里躺着，而界面上答不出这些问题。
 */
export interface RunContext {
  /** `项目 / 环境` 那句人话。 */
  describe: string;
  /** 起跑那一刻解析出来的地址，**按值记**，事后改环境不影响它。 */
  baseUrl: string;
  envName: string;
  /** 带没带登录态。带了而导出不带走，是交付时最常见的一处静默失败。 */
  usedSession: boolean;
  /** 环境是点名要的，还是没人选拿的默认——默认事后被改，旧运行靠这一栏说清它当时拿的是什么。 */
  envPick: "named" | "default" | "none" | "";
  /** 地址的出处：一次性 URL / 环境 / 项目 / 环境变量。 */
  urlFrom: "url" | "env" | "project" | "WF_TARGET_URL" | "";
  graphId: string;
  graphVersion: number;
  /** 这次真的读了哪几份材料。 */
  materials: string[];
  /** 因为图上写死了路径而**没吃到**项目材料的节点。 */
  graphPinned: Array<{ node: string; said: string }>;
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
   * 停在了哪个上限上。只有 `runStatus ==="budget"` 时才有。
   *
   * 光有一个"budget" 状态，人还得自己去比数字才知道是调用、金额还是时间到顶了——
   * 而那三样对应的下一步完全不同。
   */
  stoppedBy: "calls" | "usd" | "ms" | "";
  nodeRuns: Record<string, NodeRun>;
  outputs: Record<string, unknown>;
  artifacts: Artifact[];
  /** 这次运行的可复现性上下文。见 `RunContext`。 */
  runContext: RunContext;
  trace: TraceRow[];
  selectedNode: string;
  nodeDetail: unknown;
  /**
   * 事件日志，每行记着**是哪一步发出来的**。
   *
   * 从前是一个纯字符串数组，于是节点抽屉标题写着 spec、底下滚的却是整次运行的全局流水：
   * 打开 spec 会看见 design 的行。事件本来就带 `nodeRunId` 这个 scope，
   * 丢掉它纯粹是没接住。
   */
  log: LogLine[];
  ws: WsState;
  error: string;
  /**
   * 保存被拒时，问题落在哪个元素上。
   *
   * `at.edge` 一直都在服务端发出来（`validateGraph` 对每条类型不匹配的边都带着它），
   * 前端此前只读 `at.node`——于是「这条边接错了」只剩一句话，那条边在画布上
   * 和别的边长得一模一样。
   */
  issues: Array<{ at: { node?: string; edge?: { from: string; to: string } }; message: string }>;
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
  /** 放下当前这次运行，回到干净画布。 */
  selectRunNone: () => void;
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
  /**
   * 接着往下跑一张图，可以顺手改这一次的参数。
   *
   * `params` 这个形参服务端一直收着（`continue.ts`），而前端**从来没传过**——
   * 于是「拿昨天那批用例、把 repair.limit 从 3 改成整套、再跑一遍」这件事做不到，
   * 除非去改图本身，而那会给图立一个新版本，把一次试跑写成一次定义变更。
   */
  continueInto: (graphId: string, params?: Record<string, Record<string, unknown>>) => Promise<void>;
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
  /**
   * 起跑。`node` 给了就是部分重跑，其余字段只对整跑有意义。
   *
   * 这几个字段服务端一直收着（`startRun`），只是前端从来没发过——见 U-03 那段注释。
   */
  start: (opts?: {
    mode?: "only" | "from";
    node?: string;
    projectId?: string;
    envRef?: string;
    url?: string;
    graphVersion?: number;
    budget?: { calls?: number; usd?: number; ms?: number };
    params?: Record<string, Record<string, unknown>>;
    ablate?: string[];
  }) => Promise<void>;
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
  /**
   * 打开一次旧运行时，画布画的是**它当时那一版图**。
   *
   * 从前 canvas 永远取当前版本：一次 v1 的运行被画在 v5 的拓扑上——v1 之后删掉的
   * 节点不出现，它的产物卡跟着消失；v5 新加的节点画成 idle，看起来像「这次跳过了
   * 这一步」，而那一步在那次运行时根本还不存在。服务端的续跑判定早就是按运行当时
   * 的版本做的，理由写在 `graphs.ts` 上：否则改过的图会替它自己的旧运行做决定。
   */
  runGraph?: GraphDef;
  /**
   * 这次运行还没跑完，接着跑该从哪一步起（服务端算的，判据是产物）。
   * 空字符串 = 没有可接的东西：一步都没产出的运行「接着跑」等于整跑，
   * 把两者混成一个按钮，会让人在最该被提醒的时候悄悄重跑二十分钟。
   */
  resumeFrom: string;
  resumeDone: number;
  versions: GraphVersion[];
  diffLines: string[];
  beginEdit: () => void;
  discardEdit: () => void;
  editDraft: (fn: (d: GraphDef) => GraphDef) => void;
  saveTopology: (note?: string) => Promise<void>;
  loadVersions: (id?: string) => Promise<void>;
  loadDiff: (from: number, to: number) => Promise<void>;
  cancel: () => Promise<void>;
  /** 正在发取消请求。按钮据此禁用，免得连按三下。 */
  cancelling: boolean;
  /** 取消之后要说的那句话——「正在停」和「进程已经不在了」是两句不同的话。 */
  cancelNote: string;
  connect: () => void;
}

let close: (() => void) | null = null;
const LOG_CAP = 200;

/** 一行事件日志，以及它属于哪一步。空的 node 表示这一行属于整次运行。 */
export interface LogLine {
  node: string;
  text: string;
}

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
  /** 停在了哪个上限上。只有 `status ==="budget"` 时才有。 */
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
function nodeRunsFrom(
  detail: RunDetailShape | undefined,
  current: Record<string, NodeRun>,
): Record<string, NodeRun> {
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

const EMPTY_CONTEXT: RunContext = {
  describe: "",
  baseUrl: "",
  envName: "",
  usedSession: false,
  envPick: "",
  urlFrom: "",
  graphId: "",
  graphVersion: 0,
  materials: [],
  graphPinned: [],
};

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
  cancelling: false,
  cancelNote: "",
  stoppedBy: "",
  nodeRuns: {},
  outputs: {},
  artifacts: [],
  runContext: EMPTY_CONTEXT,
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
  resumeFrom: "",
  resumeDone: 0,
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
      // 地址栏里指名了哪一次，就停在那一次——这是别人发过来的链接该有的行为。
      // 指名的那次不存在了（清过数据、换过机器）就退回默认，而不是留一张空画布。
      const asked = runFromHash();
      const pinned = asked && runs.some((r) => r.id === asked) ? asked : "";
      if (pinned) {
        await get().selectRun(pinned);
      } else {
        // Land on the newest run for the selected graph, so opening the page shows the last
        // thing that happened rather than an empty canvas.
        const latest = runs.find((r) => r.graphId === (get().selectedGraph || graphs[0]?.id));
        if (latest && !get().wfRunId) await get().selectRun(latest.id);
      }
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  // Switching graphs abandons a draft rather than carrying it across: a draft belongs to
  // the graph it was started from, and silently moving it would be a way to lose work.
  /**
   * 切图会把**这次运行**也一起放下。
   *
   * 此前只清了 nodeRuns / outputs / breakpoints / draft，却留着 wfRunId、runStatus、
   * artifacts 和 trace。而事件只按 wfRunId 过滤、按 nodeId 打状态，产物卡只按"这个 node id
   * 在当前图上有位置"来挂——三张图共用 docs/archive/spec/stories/design/gate 五个节点 id。
   * 于是从 g1-text-cases 切到 selftest-g1，上一次运行的产物卡原地挂到同名节点下，
   * 正在跑的那次运行还继续把它们点亮：**一张从没跑过的图看起来正在跑，而且已经产出了
   * 几十条用例**，而运行下拉此时因为 graphId 不匹配是空的，人更没有线索。
   */
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
      runGraph: undefined,
      versions: [],
      diffLines: [],
      // 这四样才是"这次运行"，它属于原来那张图。
      wfRunId: "",
      runStatus: "",
      artifacts: [],
      trace: [],
      log: [],
      runContext: EMPTY_CONTEXT,
    }),

  /** 放下当前这次运行，回到一张干净的画布。「新运行」用它，而不是去查一个空 id。 */
  selectRunNone: () =>
    set({
      wfRunId: "",
      runStatus: "",
      runGraph: undefined,
      cancelNote: "",
      nodeRuns: {},
      outputs: {},
      artifacts: [],
      trace: [],
      log: [],
      pausedAt: "",
      nodeDetail: undefined,
      runtime: EMPTY_RUNTIME,
      continuations: [],
    }),

  selectRun: async (wfRunId) => {
    try {
      const { run, outputs } = await json<{
        run: WfRunSummary & {
          detail?: {
            nodes?: Array<{
              nodeId: string;
              status: string;
              ms: number;
              spend?: { calls: number; tokens: number };
            }>;
            breakpoints?: string[];
            pausedAt?: string;
            spend?: { calls: number; tokens: number; usd: number; ms: number };
            budget?: { calls?: number; usd?: number; ms?: number };
            stoppedBy?: "calls" | "usd" | "ms";
            ablate?: string[];
            /** `combined` is the fingerprint over every prompt; `entries` says which one moved. */
            prompts?: { combined?: string; entries?: Record<string, string> };
            /** 见 RunContext：服务端按值记下的可复现性上下文。 */
            targetSnapshot?: {
              describe?: string;
              baseUrl?: string;
              envName?: string;
              usedSession?: boolean;
              envPick?: "named" | "default" | "none";
              urlFrom?: "url" | "env" | "project" | "WF_TARGET_URL";
            };
            materials?: {
              injected?: Record<string, string[]>;
              graphPinned?: Array<{ node: string; said: string }>;
            };
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
      /*
       * 被重启打断的运行**不写 nodes 记录**——产物还在 wf_node_outputs 里躺着，
       * 但界面此前把整张图画成 idle：一次跑了两步的运行看起来像从没跑过。
       * 有产物就是跑过了，这一条判据服务端的 `completedNodes` 也是这么用的。
       */
      for (const id of Object.keys(outputs)) if (!nodeRuns[id]) nodeRuns[id] = { state: "done" };

      const pausedAt = run.detail?.pausedAt ?? "";
      // A paused node never finished, so it has no record among `nodes`; without this the
      // canvas shows the run stopped but not where.
      if (pausedAt) nodeRuns[pausedAt] = { ...nodeRuns[pausedAt], state: "paused" };
      writeRunToHash(wfRunId);
      set({
        wfRunId,
        runStatus: run.status,
        stoppedBy: run.status === "budget" ? (run.detail?.stoppedBy ?? "") : "",
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
        /**
         * 「这次它看得到什么」。
         *
         * 服务端早就按值记下来了，前端此前一项都没读——于是数据在库里躺着，
         * 而界面上答不出「这次打的是哪里」「读的是我的 PRD 还是图上写死的那份 mock」。
         */
        runContext: {
          describe: run.detail?.targetSnapshot?.describe ?? "",
          baseUrl: run.detail?.targetSnapshot?.baseUrl ?? "",
          envName: run.detail?.targetSnapshot?.envName ?? "",
          usedSession: !!run.detail?.targetSnapshot?.usedSession,
          envPick: run.detail?.targetSnapshot?.envPick ?? "",
          urlFrom: run.detail?.targetSnapshot?.urlFrom ?? "",
          graphId: run.graphId,
          graphVersion: Number(run.graphVersion ?? 0),
          materials: Object.values(run.detail?.materials?.injected ?? {}).flat(),
          graphPinned: run.detail?.materials?.graphPinned ?? [],
        },
      });
      /*
       * 取这次运行钉住的那一版图。取不到（版本从没被写下来过，比如内置图的第一版）
       * 就退回当前版本——画错的图也比画不出图强，但**只在真的没有**的时候才退。
       */
      const ver = Number(run.graphVersion ?? 0);
      const current = get().graphs.find((g) => g.id === run.graphId);
      if (ver > 0 && current && ver !== current.version) {
        try {
          const { graph } = await json<{ graph: GraphDef }>(`/api/graphs/${run.graphId}/versions/${ver}`);
          set({ runGraph: graph });
        } catch {
          set({ runGraph: undefined });
        }
      } else set({ runGraph: undefined });

      // 没跑完的运行才问「从哪儿接」。跑完的没有下一步，问了只会得到 null。
      if (["interrupted", "failed", "cancelled", "budget", "paused"].includes(run.status)) {
        try {
          const { point } = await json<{ point: { from: string; done: string[] } | null }>(
            `/api/wf/runs/${wfRunId}/resume-point`,
          );
          set({ resumeFrom: point?.from ?? "", resumeDone: point?.done.length ?? 0 });
        } catch {
          set({ resumeFrom: "", resumeDone: 0 });
        }
      } else set({ resumeFrom: "", resumeDone: 0 });

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

  continueInto: async (graphId, params) => {
    const id = get().wfRunId;
    if (!id) return;
    try {
      const { wfRunId } = await json<{ wfRunId: string }>(`/api/wf/runs/${id}/continue`, {
        method: "POST",
        // 覆盖只作用于这一次运行：服务端把它并进节点参数、记进 paramOverrides，
        // 图本身一个字都不动，版本号也不动。
        body: JSON.stringify({ graphId, ...(params ? { params } : {}) }),
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
        stoppedBy: run.status === "budget" ? (run.detail?.stoppedBy ?? "") : "",
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
      // 按运行取。此前是 `?limit=800` 再在这里筛——而服务端那条路取的是**最旧一万条**，
      // 于是刷新页面接着看在跑的那次运行，拿到的是一批与它无关的旧事件。
      const { events } = await json<{ events: EventEnvelope[] }>(
        `/api/events?wfRunId=${encodeURIComponent(wfRunId)}&limit=2000`,
      );
      // Replayed, not live: these events already happened, and letting them trigger the
      // same refreshes a live event does turns replay into a loop — the refresh re-replays,
      // which refreshes again. That loop is what made the canvas shake.
      for (const e of events) handle(set, get, e, false);
    } catch {
      /* the graph will fill in from live events instead */
    }
  },

  /**
   * Read the products of this run and turn them into cards.
   *
   * Only the nodes that actually ran are asked for, and a node whose output is missing is
   * simply absent — an empty card claiming"0 cases" would be a statement about the run
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

    /**
     * 探索走出来的那张图，作为它自己的一张卡。
     *
     * 此前 explore 这一步在画布上只有「19.5s」，它真正的产出——产品长什么样、
     * 哪些屏走到了、哪些入口没进去——一件都没露出来。而下游每一条缺口都在引用它。
     * 卡上报的是「几屏几条路」而不是「几个状态几条转移」：读它的人关心的是产品，
     * 不是这个 harness 的内部词汇。
     */
    if (full.explore?.graph) {
      const g = full.explore.graph as {
        states?: unknown[];
        transitions?: Array<{ walked?: boolean }>;
        unvisited?: unknown[];
        stoppedBecause?: string;
      };
      const walked = (g.transitions ?? []).filter((t) => t.walked !== false).length;
      const unseen = (g.unvisited ?? []).length;
      cards.push({
        id: "a-map",
        node: "explore",
        title: tr("art.map"),
        value: String((g.states ?? []).length),
        sub: unseen
          ? // 「没进去的入口」摆在卡面上，因为它是这张图唯一会让人改主意的数：
            // 它说的是「这张地图是不全的，而且缺了这么多」。
            tr("art.mapSub", { walked, unseen })
          : tr("art.mapSubClean", { walked }),
        tone: unseen ? "warn" : undefined,
        opens: { surface: "map", label: tr("art.mapOpen") },
      });
    }

    const specNode = has("spec") ? "spec" : has("explore") ? "explore" : "";
    if (specNode && full[specNode]) {
      const origin = String(full[specNode].origin ?? "");
      const parts = origin
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      // 规格是**怎么来的**，必须在卡片上说出来。看出来的规格描述的是现状，不是意图——
      // 由它推出的用例只能发现「产品变了」，不可能发现「产品错了」。这句话不摆在人眼前，
      // 一套完全建立在观察之上的绿色套件就会被读成「产品是对的」。
      const from = String(full[specNode].derivedFrom ?? "document");
      cards.push({
        id: "a-spec",
        node: specNode,
        title:
          from === "exploration"
            ? tr("art.specFromExplore")
            : from === "codebase"
              ? tr("art.specFromCode")
              : tr("art.spec"),
        value: String(parts.length || 1),
        sub:
          from === "exploration"
            ? tr("art.specObservedWarn")
            : parts
                .map((x) => x.split("/").pop())
                .join(" · ")
                .slice(0, 42) || origin,
        tone: from === "exploration" ? "warn" : undefined,
        // Not a surface card: the material belongs to this run, so it opens its own drawer
        // reading what this run actually captured rather than today's file on disk.
        opens: { surface: "spec", label: tr("art.specOpen") },
      });
    }
    if (full.stories?.stories) {
      const st = full.stories.stories as Array<{ id: string; source?: string }>;
      const docs = new Set(st.map((x) => x.source).filter(Boolean));
      cards.push({
        id: "a-stories",
        node: "stories",
        title: tr("art.stories"),
        value: String(st.length),
        sub: docs.size ? tr("art.storiesFrom", { n: docs.size }) : tr("art.storiesTree"),
        opens: { surface: "stories", label: tr("art.storiesOpen") },
      });
    }
    if (full.design?.cases) {
      const cs = full.design.cases as Array<{ title: string }>;
      cards.push({
        id: "a-cases",
        node: "design",
        title: tr("art.cases"),
        value: String(cs.length),
        sub: tr("art.casesSample", { n: Math.min(3, cs.length) }),
        samples: cs.slice(0, 3).map((c) => c.title),
        // 这次运行的一百条在复核队列里，不在看板上——看板是「已经批准的那些」。
        opens: { surface: "review", label: tr("art.casesOpen") },
      });
    }
    const gated = full.gate ?? full.codegen;
    if (gated?.gate) {
      const g = gated.gate as { score?: number; findings?: unknown[]; stats?: any };
      cards.push({
        id: "a-gate",
        node: full.gate ? "gate" : "codegen",
        title: tr("art.gate1"),
        value: `${Math.round((g.score ?? 0) * 100)}%`,
        /* 比例后面跟阈值与达标判定：一个没有分母的百分比说不出「够不够」。 */
        sub: tr(
          g.stats?.minNegativeRatio === undefined ? "art.gate1Sub" : "art.gate1SubThresh",
          {
            n: g.findings?.length ?? 0,
            neg: Math.round((g.stats?.negativeRatio ?? 0) * 100),
            min: Math.round((g.stats?.minNegativeRatio ?? 0) * 100),
            ok: (g.stats?.negativeRatio ?? 0) >= (g.stats?.minNegativeRatio ?? 0) ? "✓" : "✗",
          },
        ),
        opens: { surface: "review", label: tr("art.gateOpen") },
      });
      // The claim and what can be delivered, side by side: this gap is the number worth
      // watching, and no other page reports it.
      const backed = (g.stats?.tiersBacked ?? {}) as Record<string, number>;
      const total = Object.values(backed).reduce((a, b) => a + b, 0);
      const machine = (backed["1"] ?? 0) + (backed["2"] ?? 0);
      if (total)
        cards.push({
          id: "a-tier",
          node: full.gate ? "gate" : "codegen",
          title: tr("art.tierBacked"),
          value: `${Math.round((machine / total) * 100)}%`,
          sub: tr("art.tierClaims", {
            claims: Object.entries((g.stats?.tiers ?? {}) as Record<string, number>)
              .map(([k, v]) => `${v}×t${k}`)
              .join(" "),
          }),
          tone: machine === 0 ? "warn" : undefined,
        });
    }
    const coded = full.repair ?? full.codegate ?? full.codegen;
    if (coded?.code) {
      cards.push({
        id: "a-code",
        node: full.repair ? "repair" : full.codegate ? "codegate" : "codegen",
        title: tr("art.code"),
        value: String((coded.code as unknown[]).length),
        opens: { surface: "code", label: tr("art.codeOpen") },
        sub:
          coded.gate?.score !== undefined
            ? tr("art.codeGate2", { score: Number(coded.gate.score).toFixed(2) })
            : tr("art.codeGenerated"),
      });
    }
    if (full.repair?.repair) {
      const r = full.repair.repair as {
        loosePassRate?: number;
        strictPassRate?: number;
        outcomes?: unknown[];
        degraded?: unknown[];
      };
      const n = r.outcomes?.length ?? 0;
      const passed = Math.round((r.loosePassRate ?? 0) * n);
      cards.push({
        id: "a-runs",
        node: "repair",
        title: tr("art.runs"),
        value: `${passed}/${n}`,
        opens: { surface: "runs", label: tr("art.runsOpen") },
        sub: tr("art.runsSub", {
          loose: (r.loosePassRate ?? 0).toFixed(2),
          strict: (r.strictPassRate ?? 0).toFixed(2),
          degraded: r.degraded?.length ?? 0,
        }),
        tone: (r.degraded?.length ?? 0) > 0 ? "warn" : undefined,
      });
    }
    // Attribution: which failures were the product's and which were the environment's, and
    // who settled each verdict. Counted from the run's own outcomes rather than from a
    // separate tally, so the rail cannot disagree with the artifact card beside it.
    const fails: Record<string, number> = {};
    const decided = { machine: 0, judge: 0 };
    const outcomes = (full.repair?.repair?.outcomes ?? []) as Array<{
      status?: string;
      kind?: string;
      failKind?: string;
      oracle?: Array<{ decidedBy?: string }>;
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
      // 同上：按运行取，筛选发生在 SQL 里。这条路此前是历史运行轨迹永远为空的直接原因。
      const { events: mine } = await json<{ events: EventEnvelope[] }>(
        `/api/events?wfRunId=${encodeURIComponent(wfRunId)}&limit=2000`,
      );
      /*
       * 历史和实时走**同一段代码**。
       *
       * 此前是两份：这里一份、`traceRowFor` 一份。两份已经漂开了——
       * 门禁那一行在历史里写「n 条意见」、在实时里不写；节点完成那一行在历史里带 token 数、
       * 在实时里不带；「运行开始」那一行实时压根没有。于是同一次运行，
       * **看的时候和事后看到的是两个样子**，而没有任何地方说得清哪个是对的。
       *
       * 一条 stream：先把已经发生的回放完，再无缝接上 live——渲染代码只有一段。
       */
      const rows = mine.map(traceRowFor).filter((r): r is TraceRow => !!r);
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
      /**
       * 起跑要把服务端支持的字段都发出去。
       *
       * `startRun` 早就收 envRef / url / budget / params / ablate / graphVersion，
       * 而这里只发 graphId、breakpoints 和 projectId——实测 50 次运行 `detail.target`
       * 全为 `{}`、`detail.budget` 全为 null。于是 BudgetDrawer、stoppedBy、按版本复现
       * 全都是死路：不是它们坏了，是**没有人给过它们输入**。
       */
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
              ...(opts?.projectId || opts?.envRef || opts?.url
                ? {
                    target: {
                      ...(opts?.projectId ? { projectId: opts.projectId } : {}),
                      ...(opts?.envRef ? { envRef: opts.envRef } : {}),
                      ...(opts?.url ? { url: opts.url } : {}),
                    },
                  }
                : {}),
              ...(opts?.graphVersion !== undefined ? { graphVersion: opts.graphVersion } : {}),
              ...(opts?.budget ? { budget: opts.budget } : {}),
              ...(opts?.params ? { params: opts.params } : {}),
              ...(opts?.ablate?.length ? { ablate: opts.ablate } : {}),
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
        // never started, and the box falls back to reading"新运行" while one is in flight.
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
                //"未绑定项目" until the list is refetched — which is the opposite of true.
                ...(opts?.projectId ? { projectId: opts.projectId } : {}),
              },
              ...get().runs,
            ],
      });
      get().connect();
      // Catch up, because the run can outrun its own HTTP response: a graph that stops at a
      // breakpoint in the first node finishes in milliseconds, and every event it will ever
      // publish is gone before this browser learns the run's id. The live stream only carries
      // what happens next, so without this the canvas sits at"running" for a run that has
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

  /**
   * 断点**属于这次运行，不属于浏览器**。
   *
   * 此前它只改本地 state，而且只有整跑那一次随请求发出——
   * 「只跑这一步」「从这里开始」「继续」三条路都不带它，服务端沿用运行里存着的那份。
   * 于是画布上刚点亮的红点和「这次会不会停」是两回事，
   * 而顶栏那个「断点 N」数的是本地那一份。
   *
   * 选中了一次运行就落盘；没选中（还没起跑）就先留在本地，起跑时随请求带过去。
   */
  toggleBreakpoint: (nodeId) => {
    const next = get().breakpoints.includes(nodeId)
      ? get().breakpoints.filter((b) => b !== nodeId)
      : [...get().breakpoints, nodeId];
    set({ breakpoints: next });
    const id = get().wfRunId;
    if (!id) return;
    void json(`/api/wf/runs/${id}/breakpoints`, {
      method: "PATCH",
      body: JSON.stringify({ breakpoints: next }),
    }).catch((e) => set({ error: (e as Error).message }));
  },

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
    /*
     * 正在编辑拓扑时，参数改到**草稿**上，不发请求。
     *
     * 从前这里一律拿「已保存的那张图」当基底，把草稿整个无视掉。于是
     * 「改一条边 + 改一个参数」这一件事会立两版：参数那一版不含新连线，
     * 拓扑那一版把参数打回旧值——两版历史，零个真正的改动。
     * 编辑期间参数属于草稿，跟连线一起在「保存」那一下落地。
     */
    if (get().draft) {
      get().editDraft((dr) => ({
        ...dr,
        nodes: dr.nodes.map((n) =>
          n.id === nodeId ? { ...n, params: params as Record<string, unknown> } : n,
        ),
      }));
      return;
    }
    const def = get().graphs.find((g) => g.id === get().selectedGraph);
    if (!def) return;
    const next = {
      ...def,
      nodes: def.nodes.map((n) =>
        n.id === nodeId ? { ...n, params: params as Record<string, unknown> } : n,
      ),
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
      // 顶栏已经是 v4、版本抽屉最新还停在 v3，是因为这里从来不重拉。
      await get().loadVersions(graph.id);
    } catch (e) {
      const err = e as Error & {
        issues?: Array<{ at: { node?: string; edge?: { from: string; to: string } }; message: string }>;
      };
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
      const err = e as Error & {
        issues?: Array<{ at: { node?: string; edge?: { from: string; to: string } }; message: string }>;
      };
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

  /**
   * 取消要有回执。
   *
   * 此前这里不设任何本地状态、还把错误吞掉（`.catch(() => undefined)`），按下去界面一动不动；
   * 而取消只在节点边界生效，实测单步耗时 spec 158 秒、codegen 505 秒——**这几分钟里
   * 人不知道自己按下去有没有用**。服务端现在分三态回答，这里把它们说成三句不同的话。
   */
  cancel: async () => {
    const id = get().wfRunId;
    if (!id) return;
    set({ cancelling: true, error: "" });
    try {
      const r = await json<{ result: string; stopsAfter?: string }>(`/api/wf/runs/${id}/cancel`, {
        method: "POST",
      });
      if (r.result === "requested")
        set({
          error: "",
          cancelNote: tOutsideReact("wf.stopping", { step: r.stopsAfter ? `（${r.stopsAfter}）` : "" }),
        });
      else if (r.result === "agent-gone")
        set({ runStatus: "cancelled", cancelNote: tOutsideReact("wf.agentGone") });
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ cancelling: false });
    }
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
  // `nodeId` is the legacy field name (`wf.node.started`/`wf.node.finished`); the new
  // `wf.node` kind (契约 §1 `NodeEvent`) calls the same thing `node`. Both are read so
  // either shape resolves to the same key into `nodeRuns`.
  const nodeId = String(p.nodeId ?? p.node ?? "");
  const patch = (state: Partial<NodeRun>) =>
    set({
      nodeRuns: {
        ...get().nodeRuns,
        [nodeId]: { ...(get().nodeRuns[nodeId] ?? { state: "idle" }), ...state },
      },
    });

  switch (e.kind) {
    case "wf.run.started":
      set({ runStatus: "running", nodeRuns: {} });
      break;
    case "wf.run.finished":
      set({ runStatus: String(p.status ?? "") });
      // Reload the run itself and the list: the selector otherwise keeps showing the
      // status the run had when the page opened.
      if (live) void get().refreshRun();
      void json<{ runs: WfRunSummary[] }>("/api/wf/runs")
        .then(({ runs }) => set({ runs }))
        .catch(() => undefined);
      break;
    /*
     * `wf.node` — 契约 §1 的 `NodeEvent`，start/end/error 三态，**这是权威来源**。
     * 服务端目前对同一件事双发（见 `server/src/penguin.ts` `publishNodeEvent` 与
     * `server/src/penguinRun.ts` `publishBoth` 的注释），所以下面 `wf.node.started` /
     * `wf.node.finished` 两个旧 case 仍然保留、仍然会收到同一次转变——但只在这里
     * 触发 `refreshRun()` 和产生轨迹行（`traceRowFor` 对旧 kind 返回 undefined），
     * 两处不会各自再触发一次，状态本身怎么改由哪个 kind 先到都一样。
     */
    case "wf.node": {
      const phase = String(p.phase ?? "");
      if (phase === "start") {
        patch({ state: "running" });
      } else if (phase === "end" || phase === "error") {
        patch({
          state: phase === "end" ? "done" : "failed",
          ms: Number(p.ms ?? 0),
          calls: Number(p.calls ?? 0),
          tokens: Number(p.tokens ?? 0),
          error: p.error ? String(p.error) : undefined,
        });
        // A stage just produced something, so the artefact layer has one more card to show.
        // It used to appear only when the run was re-selected, which meant watching a run
        // told you which box was busy and nothing about what came out of it.
        if (live && phase === "end") void get().refreshRun();
      }
      break;
    }
    /** 兼容读取：状态补丁仍然应用（幂等，`wf.node` 已经写过同一份），不再重复触发副作用。 */
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
      break;
    /*
     * 跑着的时候的花费。节点 finished 才刷新的老做法，让一个六分钟的节点
     * 在界面上纹丝不动——分不清「在想」和「卡死」。
     */
    case "budget.update": {
      const total = (p.total ?? {}) as { calls?: number; tokens?: number; usd?: number; ms?: number };
      const node = (p.node ?? {}) as { calls?: number; tokens?: number; ms?: number };
      const prev = get().runtime;
      set({
        runtime: {
          ...prev,
          spend: {
            calls: Number(total.calls ?? prev.spend.calls),
            tokens: Number(total.tokens ?? prev.spend.tokens),
            usd: Number(total.usd ?? prev.spend.usd),
            ms: Number(total.ms ?? prev.spend.ms),
          },
        },
      });
      if (nodeId)
        patch({ calls: Number(node.calls ?? 0), tokens: Number(node.tokens ?? 0), ms: Number(node.ms ?? 0) });
      break;
    }
    case "gate.result":
      patch({ gate: { score: Number(p.score ?? 0), findings: Number(p.findings ?? 0) } });
      break;
    case "wf.paused":
      set({ runStatus: `paused: ${String(p.reason ?? "")}` });
      // Which node it stopped in front of is the whole point of stopping; a status line
      // saying"paused" without it leaves you hunting for the node.
      // Stopping is when you most want to see what has been produced so far — that is what
      // a breakpoint is for. Refreshing only on"finished" left the canvas blank at exactly
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
      if (text) set({ log: [...get().log, { node: nodeId, text }].slice(-LOG_CAP) });
      break;
    }
  }

  // The trace is rebuilt from lineage whenever the run is refreshed, and a refresh only
  // happens when a node finishes. During a long step — a model call takes minutes — that
  // left it reading"还没有留下轨迹" while work was visibly happening, which is the one
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
/**
 * 一条事件 → 轨迹上的一行。**历史与实时共用它**。
 *
 * 这曾经是两份实现：回放一份、live 一份。两份不可能长期一致——实测里它们已经在
 * 三处漂开了（门禁那行的措辞、节点完成那行带不带 token、「运行开始」那行 live 根本没有），
 * 于是同一次运行「看着跑」和「事后看」是两个样子。
 * 一段代码，两条来路：这就是那句「历史与实时是同一条 stream」在代码上的意思。
 */
function traceRowFor(e: EventEnvelope): TraceRow | undefined {
  const p = e.payload as Record<string, any>;
  const ts = String(e.ts).slice(11, 19);
  // `node` 是新 kind（`wf.node`）的字段名，`nodeId` 是旧两个 kind 的字段名——都读一遍。
  const node =
    String(p.nodeId ?? p.node ?? e.scope.nodeRunId ?? "—")
      .split(":")
      .pop() ?? "—";
  switch (e.kind) {
    case "wf.run.started":
      return {
        ts,
        kind: "run",
        node: "—",
        text:
          tr("tr.runStart", {
            graph: String(p.graphId),
            ver: String(p.graphVersion),
            n: (p.nodes ?? []).length,
          }) +
          ((p.ablated ?? []).length ? tr("tr.ablated", { list: (p.ablated as string[]).join(",") }) : ""),
        right: "",
      };
    /** `wf.node`（契约 §1，phase: start/end/error）——权威来源，见 `handle()` 顶上的注释。 */
    case "wf.node": {
      const phase = String(p.phase ?? "");
      if (phase === "start") return { ts, kind: "node", node, text: tr("tr.enter", { type: node }), right: "" };
      if (phase === "end")
        return {
          ts,
          kind: "node",
          node,
          text: tr("tr.done"),
          // 耗时、调用数、token 三样一起给：最慢的一步和最贵的一步常常不是同一步。
          right: [
            p.ms ? `${(Number(p.ms) / 1000).toFixed(1)}s` : "",
            p.calls ? `${p.calls} calls` : "",
            p.tokens ? `${p.tokens} tok` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        };
      if (phase === "error")
        return { ts, kind: "err", node, text: tr("tr.failed", { msg: String(p.error ?? "").slice(0, 90) }), right: "" };
      return undefined;
    }
    /*
     * 服务端同一件事仍然双发（见 `handle()` 顶上的注释）：`wf.node` 已经为这次转变
     * 产生了一行，这两个旧 kind 不再重复产生——否则回放历史时每个节点会出现两行
     * 一模一样的轨迹。case 留着是"读到了、认得、决定不再画"，不是没接住。
     */
    case "wf.node.started":
    case "wf.node.finished":
      return undefined;
    case "gate.result":
      return {
        ts,
        kind: "gate",
        node,
        // 分数后面跟着「几条意见」：一个光秃秃的百分比说不出该去看什么。
        text:
          p.findings === undefined
            ? tr("tr.gate", { gate: String(p.gate), pct: Math.round(Number(p.score ?? 0) * 100) })
            : tr("tr.gateFindings", {
                gate: String(p.gate),
                pct: Math.round(Number(p.score ?? 0) * 100),
                n: String(p.findings),
              }),
        right: "",
      };
    case "wf.node.output":
      return p.storyId
        ? {
            ts,
            kind: "model",
            node,
            text: tr("tr.produced", { story: String(p.storyId), n: String(p.produced) }),
            right: "",
          }
        : undefined;
    case "repair.round":
      return {
        ts,
        kind: "model",
        node: String(p.caseId ?? "").slice(0, 18),
        // 改了什么比「第几轮」有用得多——有就说。
        text: (p.changes ?? []).length
          ? tr("tr.repairRoundChanges", { n: String(p.round), changes: (p.changes as string[]).join(" · ") })
          : tr("tr.repairRound", { n: String(p.round) }),
        right: "",
      };
    case "run.finished":
      return {
        ts,
        kind: p.status === "passed" ? "node" : "err",
        node: String(p.caseId ?? "").slice(0, 18),
        text: tr("tr.exec", { status: String(p.status) }) + (p.failKind ? ` · ${p.failKind}` : ""),
        right: "",
      };
    case "wf.paused":
      return { ts, kind: "err", node, text: tr("tr.breakpoint", { reason: String(p.reason) }), right: "" };
    default:
      return undefined;
  }
}
