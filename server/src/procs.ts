import { DATA_DIR, dataPath } from "./datadir.js";
// Process supervision for the gateway: it owns the event bus (which IS lineage) and
// keeps the agent + runner processes alive. Nothing here knows what a test case is —
// that separation is what lets the harness core move out to its own package later.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Loaded here, not only in config.ts: this module is evaluated first in the import graph
// (index → exec → procs), and capability recipes resolve `${env.*}` at registration time.
// Without this the resolution silently produced empty strings.
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import {
  capabilityToSpec,
  EventBus,
  EventKind,
  Gate,
  lendGate,
  resolveHarnessConfig,
  setModelLease,
  shutdownTracing,
  SqliteEventStore,
  startRetention,
  startTracing,
  Supervisor,
  type CapabilityRecipe,
  type ProcStatus,
} from "@testpilot/harness-core";
import harnessFile from "../harness.config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * 追踪在这里起，因为**这个模块是导入图里最早被求值的那个**（index → exec → procs），
 * 而它上面那行 `import "dotenv/config"` 保证密钥这时候已经在环境里了。
 *
 * 顺序错了的后果是文档里点名的那个经典错误：Langfuse 在环境变量加载之前初始化，
 * 于是它带着空密钥起来，然后一声不响地什么都不发。
 */
export const tracing = startTracing({ service: "gateway" });

// Events live next to the app DB but in their own file: lineage is append-heavy and
// pruned on a different schedule than the product tables.
export const eventStore = new SqliteEventStore(resolve(DATA_DIR, "events.db"));

export const bus = new EventBus(eventStore, {
  coalesceMs: 100,
});

/**
 * The single admission gate for the self-hosted model. Browsers parallelise, this model
 * does not: concurrent requests degrade it and eventually return 502. The gate lives here
 * because the gateway is the only process every other one can reach, and it covers both
 * sides — the gateway's own code-generation calls and every step a runner drives.
 */
export const config = resolveHarnessConfig(harnessFile);

export const modelGate = new Gate(config.model.concurrency);
setModelLease((fn) => modelGate.run(fn));

// Slots lent to child processes, with the bookkeeping that gets them back when one dies.
const lending = lendGate(modelGate);

/**
 * Keep lineage bounded. The cap is generous because these rows are the raw material for
 * replay (and, later, for fine-tuning): the point is that the file cannot grow forever,
 * not that history is cheap.
 */
/** 还没跑完的运行。它们的事件不参与淘汰——见 RetentionOptions.protectRuns。 */
let unfinishedRuns: () => string[] = () => [];
export const setUnfinishedRuns = (fn: () => string[]): void => {
  unfinishedRuns = fn;
};

export const retention = startRetention(eventStore, {
  keepLast: config.events.keepLast,
  everyMs: config.events.trimMs,
  /*
   * 正在跑的那些一行都不删。
   *
   * 这是「三天运行」那四个洞里最外围、也最容易被忽略的一个：保留窗口按条数算，
   * 一个忙碌的小时比一个安静的星期产生更多行——于是一次长运行会在自己还没跑完的时候
   * 被自己产生的日志挤出窗口。失败的样子是轨迹变空，而不是任何一处报错。
   */
  protectRuns: () => unfinishedRuns(),
  /*
   * 日志和进程状态各自一个小窗口。
   *
   * 实测 200,014 行事件里：`log` 148,523（74.3%）、`process.status` 40,464（20.2%）、
   * **真正的工作流血缘 2,938（1.47%）**——而血缘是「一次运行发生了什么」的唯一记录。
   * 按总条数裁的时候，一个吵闹的子进程会把上一次运行的血缘整段挤出去，
   * 而症状是那次运行的轨迹变成空的，没有任何一处报错。
   *
   * 数字的来历：日志 2 万行够覆盖最近几次运行的输出；进程状态是**级**不是事件，
   * 留 2000 行只是为了还能画出最近的抖动。
   */
  keepByKind: { log: 20_000, "process.status": 2_000 },
});

/**
 * What a child may ask the gateway for, beyond the built-ins.
 *
 * The agent runs graphs but owns neither the database nor a browser, so executing a case
 * comes back here: the gateway resolves the environment and dispatches to a runner. One
 * hop, and it keeps "who owns what" answerable.
 */
let executeForAgent: ((input: unknown) => Promise<unknown>) | undefined;
export const setAgentExecutor = (fn: (input: unknown) => Promise<unknown>): void => {
  executeForAgent = fn;
};

/** 同样的理由：看一眼跑着的产品需要浏览器，而 agent 没有。 */
let observeForAgent: ((input: unknown) => Promise<unknown>) | undefined;
export const setAgentObserver = (fn: (input: unknown) => Promise<unknown>): void => {
  observeForAgent = fn;
};

export async function observeProduct(input: unknown): Promise<unknown> {
  if (!observeForAgent) throw new Error("observer_unavailable");
  return observeForAgent(input);
}

let askForChild: ((input: unknown) => Promise<unknown>) | undefined;
/** 让子进程能问模型。见 `extendParentApi` 里的 `askModel`。 */
export const setChildAsk = (fn: (input: unknown) => Promise<unknown>): void => {
  askForChild = fn;
};

export const supervisor = new Supervisor(bus, {
  /**
   * 心跳容忍度放到 15 秒（默认是 1 秒 × 3）。
   *
   * 2026-09-12 实测：探索跑完 28 屏、打完回执，**3 秒后 runner 被 SIGKILL**
   * （`no heartbeat for 3088ms`），整次运行 failed，四分钟的探索连材料都没写出来——
   * 一晚上因此丢了 4 次完整探索。收尾那几步逐段计时过：回执摘要 1ms / 材料 0ms / 截图 57ms，
   * 阻塞不在那里，而是探索结果那一大包（28 屏材料 + 状态图 + 回执）返回时的序列化，
   * 叠上当时 10.7 的机器负载。
   *
   * **刚跑完一次长探索、正在把几兆结果序列化回来的进程，不是卡死。**
   * 15 秒仍然抓得住真卡死（那种是分钟级的），而三秒抓的是繁忙。
   */
  missedBeats: 15,
  extendParentApi: (processId) => ({
    ...(lending.api(processId) as unknown as Record<string, (...args: never[]) => unknown>),
    execCase: async (input: never) => {
      if (!executeForAgent) throw new Error("the gateway has no executor wired up yet");
      return (await executeForAgent(input)) as never;
    },
    observeProduct: async (input: never) => {
      if (!observeForAgent) throw new Error("the gateway has no observer wired up yet");
      return (await observeForAgent(input)) as never;
    },
    /**
     * 子进程问模型。
     *
     * 探索跑在 runner 里，而那个进程**没有 `ModelClient`**（它只向网关领模型票），
     * 端点还被改写成了 Midscene 的 no-think 代理。所以"探索之前先问一次业务场景"
     * 这件事只能由 runner 发起、由网关执行——
     * 一个函数是过不了 RPC 边界的，第一版把 `ask` 直接塞进 spec，
     * 序列化时被丢掉，表现成"计划永远是 null"。
     */
    askModel: async (input: never) => {
      if (!askForChild) throw new Error("the gateway has no model wired up for children yet");
      return (await askForChild(input)) as never;
    },
  }),
});

// A crashed runner is exactly when a slot would be lost: it never gets to its finally.
bus.subscribe((e) => {
  if (e.kind !== EventKind.processStatus) return;
  const s = e.payload as ProcStatus;
  if (s.state === "crashed" || s.state === "exited") lending.releaseAllFor(s.id);
});

/** Dev runs TypeScript entries through tsx; a build step replaces this later. */
const TSX_ARGV = ["--import", "tsx"];
const appDir = (name: string) => resolve(REPO_ROOT, "apps", name);

// One runner per concurrent run: a runner executes a single case at a time, so raising
// the queue width without raising this would just make dispatch wait.
const RUNNER_COUNT = config.execution.runnerCount;

supervisor.register({
  id: "agent",
  kind: "node",
  entry: resolve(appDir("agent"), "src/main.ts"),
  cwd: appDir("agent"), // so `--import tsx` resolves from the app's own node_modules
  // It runs the graph, so it needs to find spec files and its own workflow store.
  env: {
    TP_REPO_ROOT: REPO_ROOT,
    TP_WF_DB: dataPath("workflows.db"),
    // Planner transport arrives as the run snapshot over private RPC.
  },
  execArgv: TSX_ARGV,
  // The agent resumes from its checkpoint, so respawning is always the right move.
  restart: "always",
  heartbeatMs: 1000,
  readyTimeoutMs: 30_000,
});

/**
 * 每个 runner 一份 Midscene 目录（07 T-04）：`midscene_run/<runner-id>/`，日志与报告按进程分开，
 * `cache/` 是指回共享 `midscene_run/cache` 的符号链接——缓存按用例、跨 runner 共用，账按进程各记各的。
 * 这样并发 > 1 时账不靠时间窗猜：一个 runner 一次只跑一条，它自己的日志就是这条的账。
 */
export const MIDSCENE_ROOT = resolve(__dirname, "..", "midscene_run");
export const midsceneDirFor = (runnerId: string): string => resolve(MIDSCENE_ROOT, runnerId);
function ensureRunnerMidsceneDir(runnerId: string): string {
  const dir = midsceneDirFor(runnerId);
  mkdirSync(resolve(MIDSCENE_ROOT, "cache"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  const cacheLink = resolve(dir, "cache");
  if (!existsSync(cacheLink)) symlinkSync(resolve(MIDSCENE_ROOT, "cache"), cacheLink, "dir");
  return dir;
}

for (let i = 1; i <= RUNNER_COUNT; i++) {
  supervisor.register({
    id: `runner-${i}`,
    kind: "node",
    entry: resolve(appDir("runner"), "src/main.ts"),
    // The gateway's cwd, not the app's: Midscene writes midscene_run/ relative to cwd and
    // the wallet build lives in .wallets/, and both must stay where the gateway reads them.
    cwd: resolve(__dirname, ".."),
    execArgv: TSX_ARGV,
    env: {
      MIDSCENE_RUN_DIR: ensureRunnerMidsceneDir(`runner-${i}`),
      // Both roles arrive over private RPC. Ambient host credentials and old proxy URLs
      // must not become a fallback when a saved project configuration clears a value.
      ...Object.fromEntries(Object.keys(process.env)
        .filter(k => /^(TP_PLANNER_|OPENAI_|ANTHROPIC_|MIDSCENE_(MODEL_|OPENAI_|USE_.*_VL$|VL_MODE$))/.test(k))
        .map(k => [k, ""])),
    },
    // Deliberately never: a dead runner has a reason, and whether to retry the WORK
    // is the loop layer's decision, not the supervisor's.
    restart: "never",
    heartbeatMs: 1000,
    readyTimeoutMs: 30_000,
  });
}

/**
 * Capabilities are declared, not spawned ad hoc. The one substitution we make is the
 * anvil mnemonic: the recipe cannot contain the seed (it is a secret on disk), so the
 * placeholder is replaced at registration time when a seed exists.
 */
function materialize(recipe: CapabilityRecipe): CapabilityRecipe {
  // `${env.NAME}` in healthcheck headers is resolved here, so secrets stay out of the file.
  if (recipe.healthcheck?.kind === "http" && recipe.healthcheck.headers) {
    const headers = Object.fromEntries(
      Object.entries(recipe.healthcheck.headers).map(([k, v]) => [
        k,
        v.replace(/\$\{env\.([A-Z0-9_]+)\}/g, (_m, name: string) => process.env[name] ?? ""),
      ]),
    );
    recipe = { ...recipe, healthcheck: { ...recipe.healthcheck, headers } };
  }
  const seedFile = resolve(__dirname, "..", ".wallets", "seed.txt");
  if (recipe.kind !== "chain" || !recipe.args?.includes("--mnemonic-random") || !existsSync(seedFile))
    return recipe;
  const seed = readFileSync(seedFile, "utf8").trim();
  return {
    ...recipe,
    args: recipe.args.flatMap((a) => (a === "--mnemonic-random" ? ["--mnemonic", seed] : [a])),
  };
}

/**
 * Capabilities come from two places: the config file, and whatever was added at runtime.
 *
 * The second kind exists because the plan was always that a person could ask the agent for
 * a capability. What the agent produces is a recipe — data — so it is stored as data next
 * to the rest of this instance's state rather than written back into the source file: a
 * process the gateway will execute should be readable in one place, and that place should
 * not be a file that a `git checkout` rewrites.
 */
const SAVED_CAPS = resolve(DATA_DIR, "capabilities.json");

function loadSaved(): CapabilityRecipe[] {
  if (!existsSync(SAVED_CAPS)) return [];
  try {
    const parsed = JSON.parse(readFileSync(SAVED_CAPS, "utf8")) as CapabilityRecipe[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt file must not take the gateway down with it; the file-declared ones are
    // still there, and the UI shows an empty saved list rather than a broken process page.
    return [];
  }
}

export const capabilities: CapabilityRecipe[] = [...config.capabilities, ...loadSaved()];

function registerCapability(recipe: CapabilityRecipe): void {
  const spec = capabilityToSpec(materialize(recipe));
  supervisor.register({ ...spec, cwd: spec.cwd ?? resolve(__dirname, "..") });
}

for (const recipe of capabilities) registerCapability(recipe);

/**
 * Add one at runtime. Registering it is what makes it startable; it is NOT started here —
 * saving a recipe and running a program are two decisions, and only the first one was made
 * by whoever pressed save.
 */
export function addCapability(recipe: CapabilityRecipe): CapabilityRecipe {
  if (supervisor.statusOf(recipe.id))
    throw new Error(`${recipe.id} is already a registered process`);
  registerCapability(recipe);
  capabilities.push(recipe);
  const saved = loadSaved();
  writeFileSync(SAVED_CAPS, JSON.stringify([...saved, recipe], null, 2));
  return recipe;
}

/**
 * 改一条能力的工作目录。
 *
 * 唯一可以在运行时改的字段，因为它是唯一**会因为换一台机器而失效**的：
 * 命令与参数是这条配方的定义，而 cwd 是一个本机事实。基准应用装在
 * `/Users/xxx/bench/...` 下，配置文件里写死的那个路径在别人的机器上一定不存在，
 * 而症状是「启动了、立刻退出」——去改源码里的一行常量不是那个人该做的事。
 *
 * 改完重新注册（supervisor 认 spec，不认配方），并落盘：下次启动网关还得是这个目录。
 */
export function setCapabilityCwd(id: string, cwd: string): CapabilityRecipe {
  const recipe = capabilities.find((c) => c.id === id);
  if (!recipe) throw new Error(`${id} 不是一条已知的能力`);
  if (supervisor.statusOf(id)?.state === "alive")
    throw new Error(`${id} 正在跑——先停掉它再改工作目录，否则改的是下一次启动的事，界面却像是这一次`);
  if (!existsSync(cwd)) throw new Error(`${cwd} 不存在`);
  recipe.cwd = cwd;
  registerCapability(recipe);
  // 配置文件里声明的那些不写盘也能改（内存里已经生效），但写下来才跨得过重启。
  const saved = loadSaved();
  const at = saved.findIndex((c) => c.id === id);
  if (at >= 0) saved[at] = recipe;
  else saved.push(recipe);
  writeFileSync(SAVED_CAPS, JSON.stringify(saved, null, 2));
  return recipe;
}

/** Which ids are taken, so a draft can be told before it is saved rather than after. */
export const takenProcessIds = (): string[] => supervisor.status().map((s) => s.id);

const bootedAt = new Date().toISOString();
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

/** The gateway itself, so the process page accounts for every process, not just children. */
function selfStatus(): ProcStatus {
  const mem = process.memoryUsage();
  return {
    id: "gateway",
    kind: "node",
    state: "alive",
    pid: process.pid,
    startedAt: bootedAt,
    restarts: 0,
    lastHeartbeat: new Date().toISOString(),
    currentTask: "serving",
    rssMb: Math.round(mem.rss / 1024 / 1024),
    cpuPct: (() => {
      const now = Date.now();
      const cpu = process.cpuUsage();
      const used = cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
      const elapsed = Math.max(1, (now - lastCpuAt) * 1000);
      lastCpu = cpu;
      lastCpuAt = now;
      return Math.min(999, Math.round((used / elapsed) * 100));
    })(),
    spend: { calls: 0, tokens: 0, usd: 0, ms: Math.round(process.uptime() * 1000) },
  };
}

export function processStatuses(): ProcStatus[] {
  return [selfStatus(), ...supervisor.status()];
}

/**
 * Boot the supervised processes. A failure here must NOT take the gateway down —
 * the UI is how you find out why a process won't start, so the UI has to stay up.
 */
export async function startProcesses(log: (msg: string) => void): Promise<void> {
  if (process.env.TP_PROCESSES === "0") {
    log("process supervision disabled (TP_PROCESSES=0)");
    return;
  }
  supervisor.attachExitHooks();
  /**
   * 退出时冲刷追踪。
   *
   * `attachExitHooks` 管的是子进程，管不到这里的 span 缓冲。不接这一段，网关自己发出的
   * 调用（chat 起草、critic、语义判官、复核重写）在每次重启时都会丢掉最后一批——
   * 而开发期重启是最频繁的事件。
   *
   * `once` 而不是 `on`：SIGINT 连按两次不该排队两次冲刷。
   */
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      void shutdownTracing();
    });
  }
  process.once("beforeExit", () => {
    void shutdownTracing();
  });
  bus.publish(EventKind.log, { stream: "gateway", text: "gateway up" }, { processId: "gateway" });
  log(tracing.enabled ? "Langfuse 追踪已开（gateway）" : `Langfuse 追踪关闭：${tracing.reason ?? "未配置"}`);
  const autostart = new Set(
    capabilities.filter((c) => c.autostart).map((c) => c.id),
  );
  try {
    // Capabilities are heavy and often optional (a chain, a proxy): start the ones that
    // asked for it, leave the rest for the UI to start when they are actually needed.
    await Promise.all(
      supervisor
        .status()
        .filter((s) => !capabilities.some((c) => c.id === s.id) || autostart.has(s.id))
        .map((s) => supervisor.start(s.id)),
    );
    for (const s of supervisor.status())
      // Capabilities nobody asked to autostart are simply idle; saying so beats listing
      // them as if something had gone wrong.
      log(`process ${s.id}: ${s.state}${s.pid ? ` (pid ${s.pid})` : ""}`);
  } catch (e) {
    log(`process startup failed: ${(e as Error).message}`);
  }
}
