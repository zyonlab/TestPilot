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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  capabilityToSpec,
  EventBus,
  EventKind,
  Gate,
  lendGate,
  resolveHarnessConfig,
  setModelLease,
  SqliteEventStore,
  startRetention,
  Supervisor,
  type CapabilityRecipe,
  type ProcStatus,
} from "@testpilot/harness-core";
import harnessFile from "../harness.config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// Events live next to the app DB but in their own file: lineage is append-heavy and
// pruned on a different schedule than the product tables.
const eventStore = new SqliteEventStore(resolve(DATA_DIR, "events.db"));

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
export const retention = startRetention(eventStore, {
  keepLast: config.events.keepLast,
  everyMs: config.events.trimMs,
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

export const supervisor = new Supervisor(bus, {
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
    // 思考开关要透传给 agent：模型客户端住在那个进程里。见 `modelFromEnv`。
    ...(process.env.TP_MODEL_THINK ? { TP_MODEL_THINK: process.env.TP_MODEL_THINK } : {}),
    ...(process.env.TP_MODEL_THINK_BUDGET ? { TP_MODEL_THINK_BUDGET: process.env.TP_MODEL_THINK_BUDGET } : {}),
  },
  execArgv: TSX_ARGV,
  // The agent resumes from its checkpoint, so respawning is always the right move.
  restart: "always",
  heartbeatMs: 1000,
  readyTimeoutMs: 30_000,
});

for (let i = 1; i <= RUNNER_COUNT; i++) {
  supervisor.register({
    id: `runner-${i}`,
    kind: "node",
    entry: resolve(appDir("runner"), "src/main.ts"),
    // The gateway's cwd, not the app's: Midscene writes midscene_run/ relative to cwd and
    // the wallet build lives in .wallets/, and both must stay where the gateway reads them.
    cwd: resolve(__dirname, ".."),
    execArgv: TSX_ARGV,
    // Midscene reads these at call time. It has no hook for per-request body fields, so
    // its traffic goes through the no-think proxy while the platform's own model config
    // keeps pointing at the model itself.
    env: {
      OPENAI_BASE_URL: process.env.MIDSCENE_PROXY_URL || "http://127.0.0.1:8010/v1",
      MIDSCENE_MODEL_BASE_URL: process.env.MIDSCENE_PROXY_URL || "http://127.0.0.1:8010/v1",
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
  bus.publish(EventKind.log, { stream: "gateway", text: "gateway up" }, { processId: "gateway" });
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
