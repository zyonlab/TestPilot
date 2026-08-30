import { dataPath } from "./datadir.js";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NodeRegistry,
  SqliteOutputStore,
  SqliteGraphStore,
  diffGraphs,
  gated,
  modelFromEnv,
  registerPack,
  type GraphDef,
  type RunMode,
} from "@testpilot/harness-core";
import {
  promptSources,
  testingPack,
  type CaseExecutor,
  type ExecOutcome,
} from "@testpilot/harness-testing";
import { getSettings } from "./settings.js";
import { bus, setAgentExecutor, supervisor } from "./procs.js";
import { execOnRunner } from "./exec.js";
import {
  ARTIFACT_DIR,
  createRun,
  getProject,
  getSecretValues,
  resolveEnvironment,
  type Environment,
} from "./db.js";
import { digestTexts, resolveMap, resolveText, type ResolveContext, type TextDigest } from "@testpilot/harness-core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * The workflow side of the gateway: which node types exist, which graphs are on offer, and
 * how a run is started, watched and partially re-run.
 *
 * The registry is built once with the real dependencies wired in — the model (through the
 * admission gate, like every other model call in the process) and an executor that hands
 * work to a runner. Nodes themselves know about neither.
 */

/**
 * What a workflow run executes against.
 *
 * A generated case is full of `${env.*}` / `${secret.*}` placeholders, so it is only
 * runnable against a declared environment — the same one the case board already uses.
 * Binding it to the run (rather than to a global URL) is what makes a result mean
 * something: "these cases passed" is only true of a stated target.
 */
export interface RunTarget {
  projectId?: string;
  envRef?: string;
  /** Overrides the environment's baseUrl for a one-off run. */
  url?: string;
}

interface ResolvedTarget {
  url: string;
  ctx: ResolveContext;
  extraHeaders: Record<string, string>;
  query: Record<string, string>;
  storageState: Environment["login"]["session"] | null;
  login: string[];
  describe: string;
}

function resolveTarget(target: RunTarget): ResolvedTarget {
  const projectId = target.projectId ?? "";
  const env = projectId ? resolveEnvironment(projectId, target.envRef) : undefined;
  const ctx: ResolveContext = {
    env: env?.vars ?? {},
    // Secrets are resolved at execution and redacted in every log the run produces; they
    // never reach a stored artefact.
    secrets: projectId ? getSecretValues(projectId) : {},
  };
  const project = projectId ? getProject(projectId) : undefined;
  const raw = target.url || env?.baseUrl || project?.targetUrl || process.env.WF_TARGET_URL || "";
  if (!raw)
    throw new Error(
      "a workflow run needs a target: bind a project/environment, pass a url, or set WF_TARGET_URL",
    );
  const session = env?.login?.session ?? null;
  const useSession = !!env?.login?.authRequired && !!session;
  return {
    url: resolveText(raw, ctx),
    ctx,
    extraHeaders: { ...resolveMap(env?.headers ?? {}, ctx), ...(useSession ? session?.headers ?? {} : {}) },
    query: resolveMap(env?.query ?? {}, ctx),
    storageState: useSession ? session : null,
    // A captured session replaces the login steps; otherwise the flow runs them.
    login: env?.login?.authRequired && !useSession ? env.login.steps ?? [] : [],
    describe: `${project?.name ?? "no project"} / ${env?.name ?? "no environment"}`,
  };
}

/**
 * Translate a case's actions into what the runner already knows how to execute.
 *
 * When a `wfRunId` is given, every execution is also written to the run ledger. That is
 * what makes the Runs page true for a project whose cases have only ever been exercised
 * by the repair loop — before this, those executions lived inside the workflow's repair
 * report and the board could not see them, so the page showed nothing and "nothing" reads
 * as "never ran".
 *
 * Without a `wfRunId` nothing is recorded, which is deliberate: detection evaluation runs
 * cases with defects deliberately seeded into them, and their failures are the expected
 * result. Filing those under the project's executions would mix "supposed to fail" with
 * "the product broke".
 */
function makeExecutor(
  target: RunTarget,
  wfRunId?: string,
  /** 变异体：注进浏览器会话，被测应用不动。见 ExecSpec.opts.mutation。 */
  mutation?: { id: string; script: string },
): CaseExecutor {
  return {
  async run({ caseId, title, actions, oracle }) {
    const steps = actions
      .filter((a) => a.kind !== "assert")
      .map((a) => (a.kind === "input" ? `在${a.field ?? "对应输入框"}输入 ${a.text}` : a.text));
    const expected = actions
      .filter((a) => a.kind === "assert")
      .map((a) => a.text)
      .join(" 且 ");
    const started = Date.now();
    const startedAt = new Date().toISOString();
    /**
     * One row per execution, not one per case: the repair loop runs the same case again
     * after each fix, and a ledger that kept only the last one would erase the very thing
     * it exists to show.
     */
    const record = (o: ExecOutcome) => {
      if (!wfRunId || !target.projectId) return o;
      try {
        createRun({
          caseId,
          caseTitle: title,
          // A candidate has no board priority yet — claiming one would invent a fact.
          priority: "P2",
          status: o.status,
          durationMs: o.ms,
          startedAt,
          failureReason: o.message,
          // 空数组是常量的时候，界面画出来的四个占位框就是凭空造的。见 ExecOutcome。
          logs: o.logs ?? [],
          screenshots: o.screenshots ?? [],
          failCode: o.failCode,
          failKind: o.failKind,
          infraError: o.failKind === "infra",
          origin: "workflow",
          projectId: target.projectId,
          wfRunId,
        });
      } catch (e) {
        // The ledger is a record of the run, not part of it: failing to write it must not
        // fail the case that just executed.
        console.warn(`[testpilot] could not record execution of ${caseId}:`, (e as Error).message);
      }
      return o;
    };
    try {
      const t = resolveTarget(target);
      const exec = await execOnRunner({
        execId: `wf-${caseId}-${Date.now()}`,
        url: t.url,
        steps,
        expected,
        artifactDir: ARTIFACT_DIR,
        opts: {
          cacheId: `wf-${caseId}`,
          // A check a program can settle costs no model call and does not wobble between
          // runs — which is the only way a case's tier means anything once it executes.
          oracle,
          // The placeholders are resolved here, inside the run, exactly as a normal case
          // run resolves them — same environment, same secrets, same redaction.
          resolve: t.ctx,
          login: t.login,
          extraHeaders: t.extraHeaders,
          query: t.query,
          storageState: t.storageState,
          mutation,
        },
      });
      return record({
        caseId,
        status: exec.status,
        // 「改了几处」要跟着结果走：0 处的那一轮不算数，判决时归 notApplied 而不是 survived。
        mutationApplied: exec.mutationApplied,
        failKind: exec.failure?.attribution,
        failCode: exec.failure?.code,
        message: exec.failureReason,
        ms: Date.now() - started,
        /**
         * runner 已经把 PNG 写在 `${ARTIFACT_DIR}/exec/` 下了——此前只是没有人引用它们，
         * 于是那些文件躺在盘上占了十几兆，而界面上一张图都没有。
         * 这里记下相对路径；`/api/artifacts` 就是这个目录的静态服务。
         */
        screenshots: (exec.pngPaths ?? []).map((p) => relative(ARTIFACT_DIR, p)),
        logs: exec.logs ?? [],
      });
    } catch (e) {
      // Dispatch itself failing is environmental: it says nothing about the case.
      return record({
        caseId,
        status: "failed",
        failKind: "infra",
        failCode: "EXEC_ENV",
        message: `${title}: ${(e as Error).message}`,
        ms: Date.now() - started,
      });
    }
  },
  };
}

// The agent asks for this whenever a case has to run: it holds the graph, the gateway
// holds the environment bindings and the runners.
/** Detection evaluation runs cases directly (not through a graph); same executor, same bindings. */
export async function executeCaseDirect(
  target: RunTarget,
  kase: { caseId: string; title: string; actions: unknown[]; uses: string[] },
  fragments: Array<{ name: string; actions: unknown[] }>,
  /** 注一个变异体进这一次的浏览器会话。不传就是干净跑。 */
  mutation?: { id: string; script: string },
): Promise<{ status: string; failKind?: string; mutationApplied?: number }> {
  const prologue = kase.uses.flatMap((n) => fragments.find((f) => f.name === n)?.actions ?? []);
  return makeExecutor(target, undefined, mutation).run({
    caseId: kase.caseId,
    title: kase.title,
    actions: [...prologue, ...kase.actions] as Parameters<CaseExecutor["run"]>[0]["actions"],
  });
}

setAgentExecutor(async (input) => {
  // `wfRunId` rides along so the execution can be filed under the run that caused it.
  const { target, wfRunId, ...rest } = input as {
    target?: RunTarget;
    wfRunId?: string;
  } & Parameters<CaseExecutor["run"]>[0];
  return makeExecutor(target ?? {}, wfRunId).run(rest);
});

const model = gated(modelFromEnv());

/**
 * A registry built here serves the palette and graph validation only — runs are executed
 * by the agent, which builds its own with the executor bound to that run's target.
 */
export function registryFor(target: RunTarget): NodeRegistry {
  const r = new NodeRegistry();
  registerPack(r, testingPack({ model, executor: makeExecutor(target), baseDir: REPO_ROOT }));
  return r;
}

/** For the palette and for graph validation, where no target is involved. */
export const registry: NodeRegistry = registryFor({});

export const outputStore = new SqliteOutputStore(dataPath("workflows.db"));

/**
 * The self-test graph: TestPilot's own specification as the material.
 *
 * It belongs here rather than in the pack because it is not part of the testing vertical —
 * it is this particular application pointed at itself. The pack stays reusable; the
 * bootstrap is an instance of it.
 *
 * Two documents rather than one: what the product does and how it behaves on screen are
 * written apart, and a case designer needs both. The gold checklist it is scored against
 * (`fixtures/self-test/gold-checklist.json`) was extracted by hand from the second one.
 */
function selfTestGraph(g1: GraphDef): GraphDef {
  return {
    ...g1,
    id: "selftest-g1",
    version: 1,
    nodes: g1.nodes.map((n) =>
      n.type === "source.spec"
        ? {
            ...n,
            params: {
              paths: ["docs/spec/02-业务规格与用户故事.md", "docs/spec/03-UI交互规格.md"],
            },
          }
        : n,
    ),
  };
}

/** The graphs the pack ships, plus this application's own bootstrap. */
export function builtinGraphs(): GraphDef[] {
  const packed = (testingPack({ model }).graphs ?? []) as GraphDef[];
  const g1 = packed.find((g) => g.id === "g1-text-cases");
  return g1 ? [...packed, selfTestGraph(g1)] : packed;
}

export const graphStore = new SqliteGraphStore(dataPath("graphs.db"));

/**
 * The built-ins, then whatever has been saved on top of them.
 *
 * Edits used to live in memory and disappear on restart, which made the canvas a place to
 * try things rather than a place to keep them. A saved version outranks the built-in of the
 * same id: the built-in is a starting point, not a ceiling.
 */
const graphs = new Map<string, GraphDef>(builtinGraphs().map((g) => [g.id, g]));
for (const saved of graphStore.all()) graphs.set(saved.id, saved);

export const listGraphs = (): GraphDef[] => [...graphs.values()];
export const getGraph = (id: string): GraphDef | undefined => graphs.get(id);

/** A specific version, for reading what a finished run actually ran. */
export const getGraphVersion = (id: string, version: number): GraphDef | undefined =>
  graphStore.get(id, version) ?? (graphs.get(id)?.version === version ? graphs.get(id) : undefined);

export const graphVersions = (id: string): Array<{ version: number; savedAt: string; note?: string }> => {
  const saved = graphStore.versions(id);
  // A built-in that has never been edited still has a version worth naming.
  const current = graphs.get(id);
  return saved.length || !current ? saved : [{ version: current.version, savedAt: "", note: "built-in" }];
};

export function saveGraph(def: GraphDef, note?: string): GraphDef {
  // Every save is a new version: a run pins the version it used, so changing the canvas
  // can never rewrite what an earlier result meant.
  const prev = graphs.get(def.id);
  const next = { ...def, version: (prev?.version ?? 0) + 1 };
  graphs.set(next.id, next);
  graphStore.save(next, note);
  // The version a saved graph replaces may itself have been a built-in that was never
  // written down; record it too, or the first diff has nothing on its left-hand side.
  if (prev && !graphStore.get(prev.id, prev.version)) graphStore.save(prev, "built-in");
  return next;
}

/** What changed between two versions of a graph. */
export function diffGraphVersions(id: string, from: number, to: number): ReturnType<typeof diffGraphs> {
  const a = getGraphVersion(id, from);
  const b = getGraphVersion(id, to);
  if (!a) throw new Error(`${id} v${from} was never saved, so there is nothing to compare against`);
  if (!b) throw new Error(`${id} v${to} was never saved, so there is nothing to compare against`);
  return diffGraphs(a, b);
}

export interface ActiveRun {
  wfRunId: string;
  graphId: string;
  started: string;
  target: RunTarget;
}

const active = new Map<string, ActiveRun>();

export const activeRuns = (): ActiveRun[] => [...active.values()];

/**
 * A run that was in flight when this process died is not running any more, whatever the
 * record says. Marking it on startup keeps "running" meaning something — a status that
 * can be stuck forever is a status nobody trusts.
 */
export function reconcileOrphanedRuns(log: (msg: string) => void): void {
  for (const row of outputStore.listRuns(200)) {
    if (row.status !== "running") continue;
    const id = String(row.id);
    outputStore.saveRun({
      id,
      graphId: String(row.graphId),
      graphVersion: Number(row.graphVersion ?? 1),
      status: "interrupted",
      startedAt: String(row.startedAt),
      finishedAt: new Date().toISOString(),
      detail: {
        ...((outputStore.getRun(id)?.detail as Record<string, unknown>) ?? {}),
        error: { message: "the gateway restarted while this run was in flight" },
      },
    });
    log(`run ${id} was interrupted by a restart`);
  }
}

/**
 * Start a run and return immediately.
 *
 * A stage-one run takes minutes and a stage-two run takes tens of them, so the HTTP call
 * cannot wait for it: the caller gets the run id, and everything after that arrives as
 * events on the bus.
 */
interface AgentApi {
  startRun(input: unknown): Promise<{ wfRunId: string }>;
  cancelRun(wfRunId: string): Promise<boolean>;
  activeRuns(): Promise<string[]>;
  nodeOutput(wfRunId: string, nodeId: string): Promise<unknown>;
  allOutputs(wfRunId: string): Promise<Record<string, unknown>>;
}

async function agent(): Promise<AgentApi> {
  if (supervisor.statusOf("agent")?.state !== "alive") await supervisor.start("agent");
  const rpc = supervisor.rpc<AgentApi>("agent");
  if (!rpc) throw new Error("the agent process is not available");
  return rpc;
}

/**
 * Start a run and return immediately.
 *
 * The graph itself runs in the agent process — a stage-two run takes tens of minutes, and
 * an HTTP server should not be holding it. What stays here is what needs the database:
 * the graph definitions, the run records, and the environment a case executes against.
 */
export async function startRun(input: {
  graphId: string;
  wfRunId?: string;
  mode?: RunMode;
  seed?: unknown;
  breakpoints?: string[];
  ablate?: string[];
  budget?: { calls?: number; usd?: number; ms?: number };
  /**
   * 已经花掉的，接着算。
   *
   * 只有续跑会传：一次撞了上限之后被续上的运行仍然是**一次**运行，它的上限在续跑之后
   * 必须还是同一个上限。此前计数从零重来，于是上限悄悄变成了"每一段一次"，而这次运行
   * 最后记下来的花费比它真的花的少——一个少报花费的报告比没有报告更糟，因为它看起来
   * 像一次测量。
   */
  spent?: { calls?: number; tokens?: number; usd?: number; ms?: number };
  /** Run an older version rather than the current one. Used to compare two versions. */
  graphVersion?: number;
  /**
   * Per-node parameter overrides for this run only, e.g. `{ design: { maxCasesPerStory: 10 } }`.
   *
   * For the arm of a paired evaluation, where the two arms differ by one parameter and
   * saving a graph version per experiment would fill the history with settings nobody
   * meant to keep. What was overridden is recorded on the run: a result whose settings are
   * not written down anywhere is not a result.
   */
  params?: Record<string, Record<string, unknown>>;
  /** What this run executes against. Recorded on the run so a re-run uses the same one. */
  target?: RunTarget;
}): Promise<{ wfRunId: string; graph: GraphDef; target: RunTarget }> {
  const base =
    input.graphVersion === undefined
      ? graphs.get(input.graphId)
      : getGraphVersion(input.graphId, input.graphVersion);
  if (!base)
    throw new Error(
      input.graphVersion === undefined
        ? `unknown graph: ${input.graphId}`
        : `${input.graphId} has no version ${input.graphVersion}`,
    );
  /**
   * 项目挂的材料，就是这次运行的 `source.spec` 的默认输入。
   *
   * 不这么做的话，「建项目时挂了三份 PRD」是一句纯装饰：材料躺在项目上，跑起来的图仍然
   * 读的是节点参数里那个空的 `paths`，于是规格照旧只能从探索来——而探索得到的规格
   * **永远不可能发现「产品错了」**，观察不可能反驳被观察者。
   *
   * 只在节点自己没说的时候注入：图上写死了 paths 或 text 的，那是这张图的决定，
   * 不该被项目设置悄悄改掉。注入了什么会跟着 `paramOverrides` 记进运行——
   * 一次运行读了哪几份材料，是解释它产出的第一件事。
   */
  const projectMaterials = input.target?.projectId
    ? (getProject(input.target.projectId)?.materials ?? [])
    : [];
  const injected: Record<string, Record<string, unknown>> = { ...(input.params ?? {}) };
  if (projectMaterials.length)
    for (const n of base.nodes) {
      if (n.type !== "source.spec") continue;
      const p = (n.params ?? {}) as { paths?: unknown; path?: unknown; text?: unknown };
      const alreadySaid =
        (Array.isArray(p.paths) && p.paths.length) || !!p.path || !!p.text || !!injected[n.id];
      if (!alreadySaid) injected[n.id] = { paths: projectMaterials };
    }
  const params = Object.keys(injected).length ? injected : input.params;
  const def = applyParamOverrides(base, params);

  const wfRunId = input.wfRunId ?? `wf-${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();
  // Re-running one node of an existing run must use that run's target, not today's default.
  const previous = (outputStore.getRun(wfRunId)?.detail ?? {}) as RunDetail;
  const target = input.target ?? previous.target ?? {};
  // Breakpoints belong to the run, not to the request that happens to start it: re-running
  // one node of a paused run must not silently clear where the run stops.
  const breakpoints = input.breakpoints ?? previous.breakpoints;

  outputStore.saveRun({
    id: wfRunId,
    graphId: def.id,
    graphVersion: def.version,
    status: "running",
    startedAt,
    detail: {
      ...previous,
      mode: input.mode ?? { kind: "full" },
      target,
      breakpoints,
      // Which components were switched off is part of what a result means: scoring the
      // batch again later with the gate at full strength would compare two different gates.
      ablate: input.ablate ?? previous.ablate,
      // The caps this run was given. Spend without them is a number with no scale: "21
      // calls" is either nothing or the end of the run depending on a limit that used to be
      // passed to the agent and then forgotten.
      budget: input.budget ?? previous.budget,
      // The graph version pins the shape and the parameters. It says nothing about the
      // prompts, which live in source and in settings — so two runs could pin the same
      // version, have been produced by different instructions, and be compared as if only
      // the arm differed. Recording the fingerprint is what closes that.
      prompts: runPromptDigest(),
      paramOverrides: params ?? previous.paramOverrides,
      // It is running again, so where it stopped last time is history, not state.
      pausedAt: undefined,
    },
  });

  const rpc = await agent();
  await rpc.startRun({
    def,
    wfRunId,
    mode: input.mode,
    seed: input.seed,
    breakpoints,
    ablate: input.ablate,
    budget: input.budget,
    spent: input.spent,
    target,
    scope: { projectId: target.projectId ?? "" },
  });

  // The run record is completed from the agent's own wf.run.finished event (below).
  active.set(wfRunId, { wfRunId, graphId: def.id, started: startedAt, target });
  return { wfRunId, graph: def, target };
}

/**
 * A graph with one run's parameter overrides folded in.
 *
 * Merged per node and per key rather than replacing the params object: an override says
 * "this one setting is different", and replacing the object would silently drop every
 * setting the override did not mention — which is how an experiment ends up measuring four
 * changes and reporting one.
 */
function applyParamOverrides(
  def: GraphDef,
  params?: Record<string, Record<string, unknown>>,
): GraphDef {
  if (!params || !Object.keys(params).length) return def;
  const unknownNodes = Object.keys(params).filter((id) => !def.nodes.some((n) => n.id === id));
  if (unknownNodes.length)
    throw new Error(`${def.id} has no node called ${unknownNodes.join(", ")} to override`);
  return {
    ...def,
    nodes: def.nodes.map((n) =>
      params[n.id] ? { ...n, params: { ...(n.params ?? {}), ...params[n.id] } } : n,
    ),
  };
}

/**
 * The instructions in effect right now: the vertical's own prompts, plus the editable
 * templates that live in settings (a person can rewrite those from the Model config page
 * between two arms of the same comparison).
 */
export function runPromptDigest(): TextDigest {
  const settings = getSettings().prompts as unknown as Record<string, string>;
  return digestTexts({
    ...promptSources(),
    ...Object.fromEntries(Object.entries(settings).map(([k, v]) => [`settings:${k}`, String(v ?? "")])),
  });
}

/** What a run record carries besides its status. Written by `startRun`, read on resume. */
export interface RunDetail {
  mode?: RunMode;
  target?: RunTarget;
  breakpoints?: string[];
  ablate?: string[];
  paramOverrides?: Record<string, Record<string, unknown>>;
  /** Fingerprints of the instructions this run was produced by. */
  prompts?: TextDigest;
  /** The caps this run was started with, so spend can be read against them. */
  budget?: { calls?: number; usd?: number; ms?: number };
  /** The node a breakpoint stopped in front of; absent once the run moves again. */
  pausedAt?: string;
  /** 累计花费，由 wf.run.finished 写入。续跑要接着它算。 */
  spend?: { calls?: number; tokens?: number; usd?: number; ms?: number };
  /** 停下来是因为撞了哪个上限。`budget` 状态才有。 */
  stoppedBy?: "calls" | "usd" | "ms";
  [k: string]: unknown;
}

export const runDetail = (wfRunId: string): RunDetail =>
  (outputStore.getRun(wfRunId)?.detail ?? {}) as RunDetail;

/**
 * Carry on from where a breakpoint stopped the run.
 *
 * The breakpoint set is passed through untouched: the runtime does not stop in front of a
 * node that was asked for by name, so the node it paused at runs this time and stays a
 * breakpoint for the next full run — which is what setting one is for.
 */
/**
 * 接着跑。
 *
 * 上限和已花费都要带上，否则续跑等于把上限撤掉：此前这里两样都没传，于是**设了上限的
 * 运行一被续上就变成不限额的**——看起来在管着，实际上没有。带上之后，一次已经撞了上限
 * 的运行会立刻再次停在同一处，这是对的：想继续就得先改上限或撤掉它，而那是一个人做的
 * 决定，不该由「点了继续」顺手完成。
 */
export async function resumeRun(wfRunId: string): Promise<{ wfRunId: string; from: string }> {
  const row = outputStore.getRun(wfRunId);
  if (!row) throw new Error(`unknown run: ${wfRunId}`);
  const detail = (row.detail ?? {}) as RunDetail;
  const at = detail.pausedAt;
  if (!at) throw new Error("this run is not paused at a breakpoint, so there is nothing to resume");
  if (String(row.status) === "budget" && overCap(detail))
    throw new Error(
      `这次运行停在它的${CAP_NAME[overCap(detail)!]}上限上。先改上限或撤掉它（PATCH /api/wf/runs/${wfRunId}/budget），再继续——` +
        "直接续跑等于把上限悄悄撤掉。",
    );
  await startRun({
    graphId: String(row.graphId),
    wfRunId,
    mode: { kind: "from", node: at },
    breakpoints: detail.breakpoints,
    budget: detail.budget,
    spent: detail.spend,
  });
  return { wfRunId, from: at };
}

const CAP_NAME = { calls: "调用次数", usd: "金额", ms: "时间" } as const;

/** 按当前记录的花费，这次运行是不是还卡在某个上限上。 */
export function overCap(detail: RunDetail): "calls" | "usd" | "ms" | undefined {
  const { budget, spend } = detail;
  if (!budget || !spend) return undefined;
  if (budget.calls !== undefined && (spend.calls ?? 0) >= budget.calls) return "calls";
  if (budget.usd !== undefined && budget.usd > 0 && (spend.usd ?? 0) >= budget.usd) return "usd";
  if (budget.ms !== undefined && (spend.ms ?? 0) >= budget.ms) return "ms";
  return undefined;
}

/**
 * 改这次运行的上限，或者撤掉它。
 *
 * 撞了上限的运行只接受这一件事——这是有意的：让「继续」这个按钮同时具备提高上限的
 * 作用，就等于让上限在最容易被忽略的时刻失效。
 */
export function setRunBudget(
  wfRunId: string,
  budget: { calls?: number; usd?: number; ms?: number } | null,
): RunDetail {
  const row = outputStore.getRun(wfRunId);
  if (!row) throw new Error(`unknown run: ${wfRunId}`);
  const detail = { ...((row.detail ?? {}) as RunDetail), budget: budget ?? undefined };
  outputStore.saveRun({
    id: wfRunId,
    graphId: String(row.graphId),
    graphVersion: Number(row.graphVersion ?? 1),
    status: String(row.status),
    startedAt: String(row.startedAt),
    finishedAt: row.finishedAt ? String(row.finishedAt) : undefined,
    detail,
  });
  return detail;
}

/**
 * The agent reports the end of a run as an event; the gateway is what stores it, because
 * the run record is database state and the agent holds none.
 */
bus.subscribe((e) => {
  if (e.kind !== "wf.run.finished" || !e.scope.wfRunId) return;
  const wfRunId = e.scope.wfRunId;
  const known = active.get(wfRunId);
  const row = outputStore.getRun(wfRunId);
  const payload = e.payload as { status?: string; spend?: unknown; error?: unknown; pausedAt?: string; nodes?: unknown };
  outputStore.saveRun({
    id: wfRunId,
    graphId: known?.graphId ?? String(row?.graphId ?? ""),
    graphVersion: Number(row?.graphVersion ?? 1),
    status: String(payload.status ?? "done"),
    startedAt: known?.started ?? String(row?.startedAt ?? new Date().toISOString()),
    finishedAt: new Date().toISOString(),
    detail: {
      ...(row?.detail as Record<string, unknown>),
      nodes: payload.nodes,
      spend: payload.spend,
      error: payload.error,
      pausedAt: payload.pausedAt,
      // 停在上限上时把是哪个上限记下来：光有 "budget" 这个状态，人还得自己去比数字。
      stoppedBy: payload.status === "budget" ? overCap({ ...(row?.detail as RunDetail), spend: payload.spend as RunDetail["spend"] }) : undefined,
    },
  });
  active.delete(wfRunId);
});

export async function cancelRun(wfRunId: string): Promise<boolean> {
  const rpc = await agent().catch(() => undefined);
  return (await rpc?.cancelRun(wfRunId)) ?? false;
}

/** Node outputs live with the runtime, in the agent. */
export async function nodeOutput(wfRunId: string, nodeId: string): Promise<unknown> {
  const rpc = await agent();
  return rpc.nodeOutput(wfRunId, nodeId);
}

export async function allOutputs(wfRunId: string): Promise<Record<string, unknown>> {
  const rpc = await agent();
  return rpc.allOutputs(wfRunId);
}

