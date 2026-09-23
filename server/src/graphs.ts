import { currentDomainReference } from "./domainReferences.js";
import { dataPath } from "./datadir.js";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NodeRegistry,
  SqliteOutputStore,
  SqliteGraphStore,
  diffGraphs,
  gated,
  plannerModel,
  plannerConnectionFromEnv,
  type ModelClient,
  registerPack,
  type GraphDef,
  type RunMode,
  traced,
  topoOrder,
  upstreamOf,
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
import { captureWebModels } from "./modelSnapshots.js";
import { registerWebRun, freezeGraphSources, runLedger } from "./runService.js";
import {
  ARTIFACT_DIR,
  createRun,
  getProject,
  getSecretValues,
  resolveEnvironment,
  listEnvironments,
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
  /** 这个被测对象要多大的视口。不配就是 undefined，执行层沿用默认。 */
  viewport?: { width?: number; height?: number };
  login: string[];
  authentication?: Pick<Environment["login"], "sessionChecks" | "injectedSessionCheck">;
  describe: string;
  /** 这个环境是**点名要的**，还是没人选、拿了默认的那一个。 */
  envPick: "named" | "default" | "none";
  /** 这个地址是哪儿来的。一次性 URL 和保存下来的环境在记录里必须分得开。 */
  urlFrom: "url" | "env" | "project" | "WF_TARGET_URL";
}

function resolveTarget(target: RunTarget): ResolvedTarget {
  const projectId = target.projectId ?? "";
  /*
   * 点名了一个环境却没有这个环境时，**拦下来**。
   *
   * `resolveEnvironment` 在名字对不上时会退回默认环境——于是一次指名打 staging
   * 的运行会安安静静地打在 prod 上，运行记录里还写着「成功」。名字没对上不是
   * 「随便给一个」的理由，它是一个错。
   */
  if (projectId && target.envRef) {
    const named = listEnvironments(projectId).find(
      (e) => e.name === target.envRef || e.id === target.envRef,
    );
    if (!named)
      throw new Error(
        `这个项目下没有叫「${target.envRef}」的环境——别的环境不能替它跑，先建一个或换一个名字`,
      );
  }
  const env = projectId ? resolveEnvironment(projectId, target.envRef) : undefined;
  const ctx: ResolveContext = {
    env: env?.vars ?? {},
    // Secrets are resolved at execution and redacted in every log the run produces; they
    // never reach a stored artefact.
    secrets: projectId ? getSecretValues(projectId) : {},
  };
  const project = projectId ? getProject(projectId) : undefined;
  const raw = target.url || env?.baseUrl || project?.targetUrl || process.env.WF_TARGET_URL || "";
  const urlFrom: ResolvedTarget["urlFrom"] = target.url
    ? "url"
    : env?.baseUrl
      ? "env"
      : project?.targetUrl
        ? "project"
        : "WF_TARGET_URL";
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
    authentication: env?.login?.authRequired ? { sessionChecks: env.login.sessionChecks, injectedSessionCheck: env.login.injectedSessionCheck } : undefined,
    ...(env?.viewport?.width || env?.viewport?.height ? { viewport: env.viewport } : {}),
    // Keep login steps as a fallback when restored-session checks fail.
    login: env?.login?.authRequired ? env.login.steps ?? [] : [],
    describe: `${project?.name ?? "no project"} / ${env?.name ?? "no environment"}`,
    envPick: !env ? "none" : target.envRef ? "named" : "default",
    urlFrom,
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
        scopeProjectId: target.projectId,
        modelSnapshotRunId: wfRunId,
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
          authentication: t.authentication,
          extraHeaders: t.extraHeaders,
          query: t.query,
          storageState: t.storageState,
          // 视口跟着被测对象走（U-69）。不配就不传，执行层沿用默认的 1024×720。
          ...(t.viewport ? { viewport: t.viewport } : {}),
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

/**
 * 网关侧的模型出口。**导出它**，因为探索的「先问业务场景」那一步要用它。
 *
 * 为什么不能在 runner 进程里直接问：那个进程没有 `ModelClient`（它只向网关领票），
 * 而且它的 `OPENAI_BASE_URL` 被改写成了 Midscene 的 no-think 代理。
 * 网关这一份走的是真端点，而且经过 `traced()`，这次调用会出现在 Langfuse 上——
 * Midscene 自己的 `ai*` 不在 trace 上，用它问就等于这次改造的成本和效果都量不出来。
 */
const rawModel: ModelClient = { chat: (request) => plannerModel(plannerConnectionFromEnv()).chat(request) };
export const model = traced(gated(rawModel), { name: "gateway.model" });

/**
 * 换配置之后让这一份客户端跟上。
 *
 * 它是模块顶层的 const，捕获的是 import 那一刻的 env——往 `process.env` 写新值对它无效。
 * 不做这件事，「界面上改了端点」在网关这条路上要等到重启才生效，而人不会知道。
 */

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
 * (`benchmark/casegen/gold.json`) was extracted by hand from the second one.
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
              paths: ["docs/archive/spec/02-业务规格与用户故事.md", "docs/archive/spec/03-UI交互规格.md"],
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

/** 两张图除了节点摆位之外完全一样。 */
function onlyMoved(a: GraphDef, b: GraphDef): boolean {
  const strip = (g: GraphDef) => ({
    ...g,
    version: 0,
    // `pos` 是画布加上去的字段，核心的 GraphNode 里没有它——摆位不属于图的含义。
    nodes: [...g.nodes]
      .map((n) => {
        const { pos: _pos, ...rest } = n as GraphDef["nodes"][number] & { pos?: unknown };
        return rest;
      })
      .sort((x, y) => x.id.localeCompare(y.id)),
    edges: [...g.edges].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
  });
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

export function saveGraph(def: GraphDef, note?: string): GraphDef {
  // Every save is a new version: a run pins the version it used, so changing the canvas
  // can never rewrite what an earlier result meant.
  const prev = graphs.get(def.id);

  /*
   * 把节点拖了个位置就立一版——那一版的 diff 说「无变化」，因为 diff 根本不看摆位。
   * 版本列表于是被一串什么都没改的版本号填满，真正的改动混在里面找不着。
   *
   * 摆位不是含义：一次运行钉住的是节点与连线，不是它们画在哪儿。所以布局改动
   * **原地写回当前版本**，版本号不动，也不惊动任何钉着这一版的旧运行。
   */
  if (prev && onlyMoved(prev, def)) {
    const same = { ...def, version: prev.version };
    graphs.set(same.id, same);
    const keptNote = graphStore.versions(same.id).find((v) => v.version === same.version)?.note;
    graphStore.save(same, note ?? keptNote);
    return same;
  }

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
    // 产物还在（它们落在 wf_node_outputs 里，进程死掉不影响），所以"跑到哪儿了"是查得出来的。
    // 此前这里只写 status 和 error，界面上于是整张图全是 idle——一次跑了两步的运行
    // 看起来像从没跑过，唯一的接法是人自己猜从哪一步起。
  }
}

/**
 * 这次运行已经产出过哪几个节点。
 *
 * 用产物反推，而不是读 `detail.nodes`：被进程重启打断的运行根本没机会写 `detail.nodes`，
 * 而产物是每跑完一个节点就落盘的。两者不一致时产物为准——它是事实，另一个是汇报。
 */
export async function completedNodes(wfRunId: string): Promise<string[]> {
  return Object.keys(await outputStore.all(wfRunId));
}

/**
 * 要重跑这个节点，上游缺的是哪一个（没有缺的返回 `undefined`）。
 *
 * 只看直接上游——runtime 也只取直接上游的产物。根节点没有上游，永远返回 `undefined`：
 * 它要的是种子，那是另一条路上的事（见 `RunDetail.seedFrom`）。
 */
export async function missingUpstream(wfRunId: string, nodeId: string): Promise<string | undefined> {
  const row = outputStore.getRun(wfRunId);
  if (!row) return undefined;
  const def = getGraphVersion(String(row.graphId), Number(row.graphVersion ?? 1)) ?? graphs.get(String(row.graphId));
  if (!def) return undefined;
  const up = upstreamOf(def, nodeId);
  if (up === undefined) return undefined;
  const have = await outputStore.all(wfRunId);
  return have[up] === undefined ? up : undefined;
}

/**
 * 这次运行如果要接着跑，该从哪个节点起。
 *
 * `undefined` 表示接不上（图不在了，或者一个节点都没跑成）。
 */
export async function resumePoint(wfRunId: string): Promise<{ from: string; done: string[] } | undefined> {
  const row = outputStore.getRun(wfRunId);
  if (!row) return undefined;
  const detail = (row.detail ?? {}) as RunDetail;
  // 停在断点上的，断点那一步自己就是起点。
  const done = await completedNodes(wfRunId);
  if (detail.pausedAt) return { from: detail.pausedAt, done };
  // 一个节点都没产出 = 没有可"接"的东西。从第一步开始那叫整跑，不叫续跑，
  // 而把两者混成一个按钮，会让"接着跑"在最该提醒人的时候悄悄重跑二十分钟。
  if (!done.length) return undefined;
  const def = getGraphVersion(String(row.graphId), Number(row.graphVersion ?? 1)) ?? graphs.get(String(row.graphId));
  if (!def) return undefined;
  const order = topoOrder(def);
  const next = order.find((id) => !done.includes(id));
  return next ? { from: next, done } : undefined;
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
  /** 种子的出处，续跑时传。见 `RunDetail.seedFrom`。 */
  seedFrom?: { runId: string; node: string };
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
  /**
   * 追踪归属。**配对评测的两条臂要传同一个 `sessionId`。**
   *
   * 网关是唯一知道「这次运行属于哪个更大的问题」的地方：一次普通运行属于它的项目，
   * 一次评测的两条臂属于那次评测。不传就按项目归——那也是对的，只是粗一点。
   */
  trace?: { sessionId?: string; tags?: string[] };
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
  /**
   * 注入了什么、以及**没能注入什么**，两样都要记。
   *
   * 只记注入的那一半，就还原不出"项目挂了三份 PRD，可这次跑的是图上写死的那份 mock"
   * 这个事实——而它正是新建项目第一次跑时最容易踩的坑，界面上还有四处在说反话。
   */
  const graphPinned: Array<{ node: string; said: string }> = [];
  for (const n of base.nodes) {
    if (n.type !== "source.spec") continue;
    const p = (n.params ?? {}) as { paths?: unknown; path?: unknown; text?: unknown };
    const said =
      (Array.isArray(p.paths) && p.paths.length ? (p.paths as string[]).join(", ") : "") ||
      (typeof p.path === "string" ? p.path : "") ||
      (p.text ? "（图上直接写了正文）" : "");
    const alreadySaid = !!said || !!injected[n.id];
    if (alreadySaid) {
      // 被请求参数覆盖的不算"图钉死"——那是这一次运行自己的决定。
      if (said && !injected[n.id]) graphPinned.push({ node: n.id, said });
      continue;
    }
    if (projectMaterials.length) injected[n.id] = { paths: projectMaterials };
  }
  /**
   * 项目当前的领域参考，就是这次运行 design.cases 的领域段。
   * 和材料同一条规矩：图上或请求里已经说了的不改；注入了什么跟着 paramOverrides 记进运行。没有就不注入。
   */
  const domainRef = input.target?.projectId ? currentDomainReference(input.target.projectId) : undefined;
  for (const n of base.nodes) {
    if (!domainRef || n.type !== "design.cases") continue;
    const own = (n.params ?? {}) as { domainReference?: unknown; domainReferencePath?: unknown };
    const req = (injected[n.id] ?? {}) as { domainReference?: unknown; domainReferencePath?: unknown };
    if (own.domainReference || own.domainReferencePath || req.domainReference || req.domainReferencePath) continue;
    injected[n.id] = { ...(injected[n.id] ?? {}), domainReference: domainRef.text };
  }
  const params = Object.keys(injected).length ? injected : input.params;
  const def = applyParamOverrides(base, params);

  /*
   * 运行 id 带一个随机尾巴。
   *
   * 此前是纯毫秒时间戳——**同一毫秒起的两次运行会拿到同一个 id**，于是它们共用
   * 同一份产物、同一条步骤史，后起的那次把先起的那次改写掉。从界面上手点碰不到，
   * 但一次配对评测的两条臂、一个脚本连起的两次运行，正好都是同一毫秒。
   * 时间戳留着是因为 id 排序即时间序，那个性质别处在用。
   */
  const wfRunId = input.wfRunId ?? `wf-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = new Date().toISOString();
  // Re-running one node of an existing run must use that run's target, not today's default.
  const previous = (outputStore.getRun(wfRunId)?.detail ?? {}) as RunDetail;
  const target = input.target ?? previous.target ?? {};
  /**
   * 按值记下这次打的是哪里。解析失败不拦运行——没绑环境也能跑（`WF_TARGET_URL` 那条路），
   * 拦下来会把一个记账问题变成一个可用性问题。
   */
  let targetSnapshot: RunDetail["targetSnapshot"] = previous.targetSnapshot;
  try {
    const r = resolveTarget(target);
    targetSnapshot = {
      describe: r.describe,
      baseUrl: r.url,
      envName: r.describe.split(" / ")[1],
      usedSession: !!r.storageState,
      envPick: r.envPick,
      urlFrom: r.urlFrom,
    };
  } catch (e) {
    // 点名了一个不存在的环境是个错，不是「没绑环境」——把它原样记下来，
    // 否则事后看只剩一句「还没有可解析的目标」，人会以为是自己忘了绑。
    targetSnapshot = { describe: `（目标解析不了：${(e as Error).message}）` };
  }
  // Breakpoints belong to the run, not to the request that happens to start it: re-running
  // one node of a paused run must not silently clear where the run stops.
  const breakpoints = input.breakpoints ?? previous.breakpoints;
  // Validate and capture before writing "running" or starting a child process.
  if (outputStore.getRun(wfRunId) && !previous.modelRoles)
    throw new Error("legacy_run_model_snapshot_missing：旧运行未记录模型快照，请发起新运行");
  const models = captureWebModels(wfRunId, target.projectId, "pipeline");
  const planner = models.planner;
  if (target.projectId) {
    registerWebRun(wfRunId, target.projectId, models.binding, params as Record<string, unknown> | undefined);
    freezeGraphSources(wfRunId, target.projectId, def.nodes, REPO_ROOT);
  }

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
      modelRoles: models.binding,
      ...(target.projectId ? { binding: runLedger().registration(wfRunId, target.projectId)?.binding } : {}),
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
      /**
       * 这次运行里，**人自己要求**的那些覆盖。
       *
       * `paramOverrides` 记的是最终生效的全部参数——里面包含项目材料的自动注入，
       * 而那是每一次运行都会发生的事。拿它去标「带覆盖」，结果是每一条运行都带着这枚标签，
       * 于是这枚标签什么都区分不出来了。
       * 「这次运行不是这张图的基线成绩」说的是**有人动过手**，所以看的是请求里带来的那一份。
       */
      requestedOverrides: input.params ?? previous.requestedOverrides,
      targetSnapshot,
      materials: {
        injected: Object.fromEntries(
          Object.entries(injected)
            .filter(([, v]) => Array.isArray((v as { paths?: unknown }).paths))
            .map(([k, v]) => [k, (v as { paths: string[] }).paths]),
        ),
        graphPinned,
      },
      seedFrom: input.seedFrom ?? previous.seedFrom,
      // It is running again, so where it stopped last time is history, not state.
      pausedAt: undefined,
    },
  });

  const rpc = await agent();
  await rpc.startRun({
    planner,
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
    trace: {
      // 没有更具体的归属时按项目归：一个项目的历次运行是一组自然的对照。
      sessionId: input.trace?.sessionId ?? (target.projectId ? `project:${target.projectId}` : undefined),
      tags: [
        ...(input.trace?.tags ?? []),
        ...(target.envRef ? [`env:${target.envRef}`] : []),
        // 提示词指纹进标签：两次运行钉了同一个图版本、却由不同的提示词产出，
        // 在别处是看不出来的（见上面 `prompts` 那段）。
        ...(runPromptDigest()?.combined ? [`prompts:${runPromptDigest()!.combined.slice(0, 12)}`] : []),
      ],
    },
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
  const next = {
    ...def,
    nodes: def.nodes.map((n) =>
      params[n.id] ? { ...n, params: { ...(n.params ?? {}), ...params[n.id] } } : n,
    ),
  };

  /*
   * 覆盖参数**当场校验**，而不是等到跑到那一步。
   *
   * 校验本来就有——runtime 会在执行每个节点前 `nodeDef.params.safeParse`。可那是
   * 二十分钟以后的事：一个把 `maxRounds` 写成 `"3"` 的起跑单，会先跑完前四步，
   * 再在第五步上报一句 zod 错误，前面那些模型调用全部白花。
   * 同一套 schema，只是提前到按下起跑的那一刻。
   */
  for (const n of next.nodes) {
    if (!params[n.id]) continue;
    const def0 = registry.get(n.type);
    if (!def0) continue;
    const parsed = def0.params.safeParse(n.params ?? {});
    if (!parsed.success)
      throw new Error(
        `${n.id}（${n.type}）的覆盖参数不对：${parsed.error.issues
          .map((i) => `${i.path.join(".") || "?"} ${i.message}`)
          .join("；")}`,
      );
  }
  return next;
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
  modelRoles?: import("@testpilot/harness-core/model-profiles").RunModels;
  mode?: RunMode;
  target?: RunTarget;
  breakpoints?: string[];
  ablate?: string[];
  paramOverrides?: Record<string, Record<string, unknown>>;
  /** 上面那份里，**人自己要求**的那一部分。项目材料的自动注入不算。 */
  requestedOverrides?: Record<string, Record<string, unknown>>;
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
  /**
   * 起跑那一刻这次运行打的是哪里，**按值记**。
   *
   * `target.envRef` 是一个引用，而环境是可以被改的：以后有人把默认环境的 baseUrl 换掉，
   * 这次旧运行的含义就跟着变了——"这些用例在 staging 上通过了"会悄悄变成一句关于另一台
   * 机器的话。所以除了引用，还把当时解析出来的地址与那句人话一起存下来。
   */
  targetSnapshot?: {
    describe: string;
    baseUrl?: string;
    envName?: string;
    usedSession?: boolean;
    /** 环境是点名的还是拿的默认；默认环境事后被改，旧运行看这一栏才知道它当时拿的是什么。 */
    envPick?: "named" | "default" | "none";
    urlFrom?: "url" | "env" | "project" | "WF_TARGET_URL";
  };
  /**
   * 这次运行的 `source.spec` 到底读了什么，以及**哪些节点因为图上写死了路径而没吃到项目材料**。
   *
   * 后者是本轮查出来的一处谎言：项目卡亮着"规格来自 N 份文档"，而内置 g1 的 docs 节点出厂
   * 就写死了 fixtures 里那份 75 行的 mock，于是第一次跑读的根本不是你挂的 PRD。
   * 记下来，起跑面才有东西可警告。
   */
  materials?: { injected?: Record<string, string[]>; graphPinned?: Array<{ node: string; said: string }> };
  /**
   * 续跑起来的运行，它的种子是从哪来的。
   *
   * 存的是**出处**不是值：种子可以是一整批用例，塞进运行记录会让这张表迅速变胖。
   * 有了出处，重跑根节点时可以按需把它取回来——此前种子只活在那一次请求里，
   * 于是续跑起来的运行**第一个节点永远重跑不了**（runtime 拿到 undefined，zod 当场报错）。
   */
  seedFrom?: { runId: string; node: string };
  /** 每一次部分重跑留下一轮记录。整跑不留——它本来就是从头开始。 */
  rounds?: Array<{ at: string; mode: RunMode; nodes: string[]; spend?: RunDetail["spend"] }>;
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
  /**
   * 停在断点上的能续，**被重启打断的、被取消的，同样能续**。
   *
   * 此前这里只认 `pausedAt`，其余一律抛错。可产物就躺在 `wf_node_outputs` 里：
   * 一次跑了两步才被打断的运行，界面上整张图是 idle，人只能自己猜从哪一步起——
   * 而"跑到哪儿了"本来就是查得出来的。
   */
  const point = await resumePoint(wfRunId);
  const at = detail.pausedAt ?? point?.from;
  if (!at)
    throw new Error(
      point === undefined && !outputStore.getRun(wfRunId)
        ? "unknown run"
        : "这次运行没有可接上的地方：它要么已经跑完，要么一个节点都没产出。",
    );
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
    seedFrom: detail.seedFrom,
    seed: detail.seedFrom ? await nodeOutput(detail.seedFrom.runId, detail.seedFrom.node).catch(() => undefined) : undefined,
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
 * 改这次运行的断点集。
 *
 * 断点**属于这次运行，不属于浏览器**。此前它只活在前端 store 里，
 * 而且只有整跑那一次随请求发出——「只跑这一步」「从这里开始」「继续」三条路
 * 都不带它，服务端沿用运行里存着的那份。于是**画布上刚点亮的红点和
 * 「这次会不会停」是两回事**，而顶栏那个「断点 N」数的是本地那一份。
 *
 * 存进运行记录之后，那个计数才第一次说的是真话。
 */
export function setRunBreakpoints(wfRunId: string, breakpoints: string[]): RunDetail {
  const row = outputStore.getRun(wfRunId);
  if (!row) throw new Error(`unknown run: ${wfRunId}`);
  const detail: RunDetail = { ...((row.detail ?? {}) as RunDetail), breakpoints };
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
/**
 * 花费**跑着的时候就落盘**，不是只在跑完时写一次。
 *
 * 崩溃时这一段的花费此前**全丢**：`spend` 只在 `wf.run.finished` 那个订阅里写一次，
 * 而一次跑三天的运行崩在第二天，那两天的账就没有了——续跑会从零重新算，
 * 于是上限在最该起作用的时候悄悄失效。
 *
 * 节流到 5 秒一次：`budget.update` 每次模型调用都发，而落盘一次是一次写事务。
 * 崩溃最坏赔掉的是最后 5 秒的账，而不是两天的。
 */
const spendWrittenAt = new Map<string, number>();
bus.subscribe((e) => {
  if (e.kind !== "budget.update" || !e.scope.wfRunId) return;
  const wfRunId = e.scope.wfRunId;
  const now = Date.now();
  if (now - (spendWrittenAt.get(wfRunId) ?? 0) < 5000) return;
  spendWrittenAt.set(wfRunId, now);
  const row = outputStore.getRun(wfRunId);
  if (!row || row.status !== "running") return;
  const total = (e.payload as { total?: RunDetail["spend"] }).total;
  if (!total) return;
  outputStore.saveRun({
    id: wfRunId,
    graphId: String(row.graphId ?? ""),
    graphVersion: Number(row.graphVersion ?? 1),
    status: "running",
    startedAt: String(row.startedAt ?? new Date().toISOString()),
    detail: { ...(row.detail as Record<string, unknown>), spend: total },
  });
});

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
      /**
       * 部分重跑**累加**步骤史，不覆盖。
       *
       * 此前这里直接 `nodes: payload.nodes` 盖上去，而 runtime 只回报这一次跑过的节点。
       * 实测 wf-mtd7gcdk：整跑是三条节点、41 次调用、719 秒；只重跑了一个 repair 之后，
       * 这次运行的记录变成一条节点、3 次调用——**一次十二分钟的运行被一次两分钟的重跑
       * 改写成了它自己的一小段**，而报告看起来完全正常。
       *
       * 花费不在这里加：重跑请求会把 `spent` 带上（见 index.ts 的重跑路由），
       * runtime 是从那个数接着算的，payload.spend 已经是累计值。在这里再加一次会翻倍。
       */
      nodes: mergeNodeRuns((row?.detail as RunDetail)?.mode, (row?.detail as RunDetail)?.nodes, payload.nodes),
      rounds: appendRound(row?.detail as RunDetail, payload),
      spend: payload.spend,
      error: payload.error,
      pausedAt: payload.pausedAt,
      // 停在上限上时把是哪个上限记下来：光有 "budget" 这个状态，人还得自己去比数字。
      stoppedBy: payload.status === "budget" ? overCap({ ...(row?.detail as RunDetail), spend: payload.spend as RunDetail["spend"] }) : undefined,
    },
  });
  active.delete(wfRunId);
  spendWrittenAt.delete(wfRunId);
});

/**
 * 还没跑完的那些运行。血缘保留策略拿它来决定哪些事件一行都不能删。
 *
 * 用运行记录而不是 `active`：`active` 只有这个进程这次启动之后起的那些，
 * 而一次跨重启的长运行恰恰不在里面——那正是最需要被保护的那一种。
 */
export function unfinishedRunIds(): string[] {
  return outputStore
    .listRuns(200)
    .filter((r) => r.status === "running" || r.status === "paused")
    .map((r) => String(r.id));
}

/**
 * 取消一次运行。
 *
 * 返回三种结果，而不是一个布尔——它们在界面上是三句不同的话：
 * `requested` 信号发出去了，当前这个节点跑完就停（取消只在节点边界生效，而实测单步
 * 耗时 spec 158 秒、codegen 505 秒，所以这几分钟里必须有话说）；`agent-gone` 进程
 * 已经不在了，这次运行就地判为已取消；`unknown-run` 没这个运行。
 *
 * 此前这里返回 `false` 有两个完全不同的含义，而界面对两者都一声不吭。
 */
export async function cancelRun(
  wfRunId: string,
): Promise<{ result: "requested" | "agent-gone" | "unknown-run"; stopsAfter?: string }> {
  const row = outputStore.getRun(wfRunId);
  if (!row) return { result: "unknown-run" };
  const rpc = await agent().catch(() => undefined);
  const ok = rpc ? await rpc.cancelRun(wfRunId).catch(() => false) : false;
  if (ok) {
    const detail = (row.detail ?? {}) as RunDetail;
    /**
     * 停在哪一步之后——**不知道就不说**。
     *
     * `detail.nodes` 只在运行结束时才写，所以运行中它是空的。第一版在这里退回
     * `graphId`，而它读起来像一个节点名（"当前这一步（g0-explore）跑完就停"）——
     * 又一次把"不知道"渲染成了一个具体答案。改成用产物反推：已经落盘的下一个就是
     * 正在跑的那个。
     */
    const def = getGraphVersion(String(row.graphId), Number(row.graphVersion ?? 1)) ?? graphs.get(String(row.graphId));
    const done = Object.keys(await outputStore.all(wfRunId));
    const stopsAfter = def ? topoOrder(def).find((id) => !done.includes(id)) : undefined;
    return { result: "requested", ...(stopsAfter ? { stopsAfter } : {}) };
  }
  // agent 拿不到、或者它说没这个运行：进程已经不在了。把记录收干净，
  // 否则一个永远停在 running 的状态没人再信。
  if (String(row.status) === "running")
    outputStore.saveRun({
      id: wfRunId,
      graphId: String(row.graphId),
      graphVersion: Number(row.graphVersion ?? 1),
      status: "cancelled",
      startedAt: String(row.startedAt),
      finishedAt: new Date().toISOString(),
      detail: { ...((row.detail ?? {}) as RunDetail), error: { message: "agent 进程已经不在了，这次运行就地判为已取消" } },
    });
  return { result: "agent-gone" };
}

/** 部分重跑只回报它跑过的那几个节点；把它们并回整次运行的步骤史。 */
function mergeNodeRuns(mode: RunMode | undefined, prev: unknown, incoming: unknown): unknown {
  const partial = mode?.kind === "only" || mode?.kind === "from";
  if (!partial || !Array.isArray(prev) || !Array.isArray(incoming)) return incoming ?? prev;
  const ran = new Set(incoming.map((n) => (n as { nodeId?: string }).nodeId));
  return [...prev.filter((n) => !ran.has((n as { nodeId?: string }).nodeId)), ...incoming];
}

/** 每一次部分重跑留一轮记录，这样"这个数字是第几次跑出来的"答得上来。 */
function appendRound(detail: RunDetail | undefined, payload: { nodes?: unknown; spend?: unknown }): RunDetail["rounds"] {
  const mode = detail?.mode;
  if (mode?.kind !== "only" && mode?.kind !== "from") return detail?.rounds;
  const ids = Array.isArray(payload.nodes)
    ? payload.nodes.map((n) => String((n as { nodeId?: string }).nodeId ?? ""))
    : [];
  return [
    ...(detail?.rounds ?? []),
    { at: new Date().toISOString(), mode, nodes: ids, spend: payload.spend as RunDetail["spend"] },
  ];
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

/**
 * 每次运行的用例/代码条数（在库里数）。总览用它，别为了两个数字把产物全搬过来。
 *
 * **等不到就先不等**：agent 子进程冷启动要二十多秒，而这条请求是项目列表的首屏。
 * 等下去的结果是界面上写着「项目列表加载失败」（2026-09-12 实测）。
 * 数不出来就先给空的——总览上那两个数字晚一轮出现，比整页打不开好。
 */
export async function outputCounts(): Promise<Record<string, { cases: number; code: number }>> {
  const rpc = (await Promise.race([
    agent(),
    new Promise((r) => setTimeout(() => r(undefined), 2000)),
  ])) as unknown as { outputCounts?: () => Promise<Record<string, { cases: number; code: number }>> } | undefined;
  if (!rpc?.outputCounts) return {};
  return (await Promise.race([
    rpc.outputCounts(),
    new Promise<Record<string, { cases: number; code: number }>>((r) => setTimeout(() => r({}), 2000)),
  ])) ?? {};
}
