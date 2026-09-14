// Dispatch a case run to a runner process.
//
// The split: the runner owns everything that needs a live page (drive the steps, take the
// screenshots, read the performance timings); the gateway owns everything that needs the
// database (baselines, verdicts, run records). Pixels cross as file paths, never as bytes.
import { readFileSync, rmSync } from "node:fs";
import { projectModelConnection } from "./modelProfiles.js";
import { snapshotExecutor } from "./modelSnapshots.js";
import { executorConnectionFromEnv } from "@testpilot/harness-core";
import type {
  DebugSpec,
  ExecResult,
  ExecSpec,
  ExploreResult,
  ExploreSpec,
  ObserveResult,
  ObserveSpec,
} from "@testpilot/runner/exec";
import { EventKind, type Envelope } from "@testpilot/harness-core";
import { bus, supervisor } from "./procs.js";

interface RunnerApi {
  exec(spec: ExecSpec): Promise<ExecResult>;
  verifyDapp(spec: unknown): Promise<unknown>;
  checkWallet(path?: string): Promise<unknown>;
  walletDappTest(spec: unknown): Promise<unknown>;
  captureSession(spec: unknown): Promise<unknown>;
  cancelAll(): Promise<{ stopped: number; busy: boolean }>;
  explore(spec: ExploreSpec): Promise<ExploreResult>;
  observe(spec: ObserveSpec): Promise<ObserveResult>;
  debug(spec: DebugSpec): Promise<void>;
  cancel(execId: string): Promise<boolean>;
  releaseSession(key: string): Promise<boolean>;
  capabilities(): Promise<{ web: boolean; android: boolean; ios: boolean }>;
}

const isRunner = (id: string) => id.startsWith("runner-");

/**
 * Runners are `restart: never` on purpose, so a crashed one stays down until work arrives.
 * That makes "start it if it isn't up" part of dispatch rather than a background loop —
 * and it keeps a dead runner visible on the process page instead of silently flapping.
 */
async function pickRunner(): Promise<string> {
  const runners = supervisor.status().filter((s) => isRunner(s.id));
  if (!runners.length) throw new Error("no runner process registered");
  // Prefer an idle one: a runner executes a single case at a time, so handing work to a
  // busy runner would be rejected. With the default RUN_CONCURRENCY=1 there is only ever
  // one, but the queue width and the runner count are meant to be raised together.
  const idle = runners.find((s) => s.state === "alive" && s.currentTask === "idle");
  if (idle) return idle.id;
  const stopped = runners.find((s) => s.state !== "alive");
  if (stopped) {
    await supervisor.start(stopped.id);
    if (supervisor.statusOf(stopped.id)?.state === "alive") return stopped.id;
  }
  const alive = runners.find((s) => s.state === "alive");
  if (alive) return alive.id;
  const target = runners[0].id;
  await supervisor.start(target);
  if (supervisor.statusOf(target)?.state !== "alive")
    throw new Error(`runner ${target} did not come up: ${supervisor.statusOf(target)?.lastError ?? "unknown"}`);
  return target;
}

/**
 * 批次结束：让每个活着的 runner 关掉这个 key 下复用的浏览器。池是每个 runner 进程各一份，
 * 所以要都问一遍；没有的返回 false，不算错。
 */
export async function releaseSessionOnRunners(key: string): Promise<number> {
  let released = 0;
  for (const s of supervisor.status().filter((x) => isRunner(x.id) && x.state === "alive")) {
    const rpc = supervisor.rpc<RunnerApi>(s.id);
    if (!rpc) continue;
    try {
      if (await rpc.releaseSession(key)) released += 1;
    } catch {
      /* runner 正在死或没这个方法：下一次 spawn 就没有池了 */
    }
  }
  return released;
}

/** 谁跑的就写谁：账要去它自己的 Midscene 目录里读（07 T-04）。 */
export type ExecResultWithRunner = ExecResult & { runnerId: string };

export async function execOnRunner(spec: ExecSpec, control?: { signal?: AbortSignal }): Promise<ExecResultWithRunner> {
  spec = { ...spec, opts: { ...spec.opts, executorModel: spec.modelSnapshotRunId
    ? snapshotExecutor(spec.modelSnapshotRunId, spec.scopeProjectId) : spec.scopeProjectId
    ? projectModelConnection(spec.scopeProjectId, "executor")
    : executorConnectionFromEnv() } };
  if (control?.signal?.aborted) throw control.signal.reason ?? new Error("EXEC_CANCELLED");
  const id = await pickRunner();
  if (control?.signal?.aborted) throw control.signal.reason ?? new Error("EXEC_CANCELLED");
  const rpc = supervisor.rpc<RunnerApi>(id);
  if (!rpc) throw new Error(`runner ${id} has no RPC channel`);
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => { abort = () => { void rpc.cancel(spec.execId).catch(() => {}); reject(control?.signal?.reason ?? new Error("EXEC_CANCELLED")); }; });
  control?.signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await Promise.race([rpc.exec(spec), stopped]);
    return { ...result, runnerId: id };
  } finally { control?.signal?.removeEventListener("abort", abort); }
}

/**
 * Read back the PNGs the runner wrote, then drop them: they are a handoff across the
 * process boundary, not an artifact. What is worth keeping (baseline / current / diff)
 * gets written by the baseline step under its own name.
 */
export function readPngs(paths: string[]): Buffer[] {
  return paths.map((p) => {
    const buf = readFileSync(p);
    try {
      rmSync(p);
    } catch {
      /* best effort — a leftover handoff file is harmless */
    }
    return buf;
  });
}

/** The UI still stores step screenshots as data URLs on the run record. */
export function toDataUrls(buffers: Buffer[]): string[] {
  return buffers.map((b) => `data:image/png;base64,${b.toString("base64")}`);
}

/* ---- interactive sessions ---- */

export interface Interactive {
  execId: string;
  /** Frames for THIS session, already screenshot-inlined, in order. */
  onFrame(fn: (evt: Record<string, unknown>) => void): () => void;
  explore(spec: Omit<ExploreSpec, "execId" | "artifactDir">, artifactDir: string): Promise<ExploreResult>;
  /** 看一眼跑着的产品，取回屏幕上原样的东西——采集是确定性的，不问模型「这该怎么测」。 */
  observe(spec: Omit<ObserveSpec, "execId" | "artifactDir">, artifactDir: string): Promise<ObserveResult>;
  debug(spec: Omit<DebugSpec, "execId" | "artifactDir">, artifactDir: string): Promise<void>;
  /** The browser went away: stop the session instead of leaving a browser open. */
  cancel(): Promise<void>;
}

/**
 * A streamed session on a runner. The runner emits `session.progress` events; this filters
 * the bus down to one execId and turns each frame's screenshot ref back into the inline
 * data URL the existing SSE clients expect — the UI contract does not change just because
 * the browser moved to another process.
 */
export function interactiveSession(prefix: string, projectId?: string): Interactive {
  const executorModel = projectId ? projectModelConnection(projectId, "executor") : executorConnectionFromEnv();
  const execId = `${prefix}-${Date.now().toString(36)}`;
  let runnerId: string | undefined;
  let watcher: ((evt: Record<string, unknown>) => void) | undefined;

  // Subscribe for the whole life of the session, not just while someone is watching:
  // every frame carries a screenshot file that has to be consumed, and the non-streaming
  // explore has no watcher at all. Without this the live/ directory grows forever.
  const sub = bus.subscribe((e: Envelope) => {
    if (e.kind !== EventKind.sessionProgress || e.scope.runId !== execId) return;
    const frame = inlineShot(e.payload as Record<string, unknown>);
    watcher?.(frame);
  });

  const onFrame = (fn: (evt: Record<string, unknown>) => void): (() => void) => {
    watcher = fn;
    return () => {
      watcher = undefined;
    };
  };

  const call = async <T>(fn: (rpc: RunnerApi) => Promise<T>): Promise<T> => {
    runnerId = await pickRunner();
    const rpc = supervisor.rpc<RunnerApi>(runnerId);
    if (!rpc) throw new Error(`runner ${runnerId} has no RPC channel`);
    return fn(rpc);
  };

  return {
    execId,
    onFrame,
    explore: (spec, artifactDir) =>
      call((rpc) => rpc.explore({ ...spec, execId, artifactDir, launch: { ...spec.launch, executorModel } })).finally(() => sub.close()),
    observe: (spec, artifactDir) =>
      call((rpc) => rpc.observe({ ...spec, execId, artifactDir, projectId, launch: { ...spec.launch, executorModel } })).finally(() => sub.close()),
    debug: (spec, artifactDir) =>
      call((rpc) => rpc.debug({ ...spec, execId, artifactDir, launch: { ...spec.launch, executorModel } })).finally(() => sub.close()),
    cancel: async () => {
      sub.close();
      if (!runnerId) return;
      await supervisor.rpc<RunnerApi>(runnerId)?.cancel(execId).catch(() => false);
    },
  };
}

/** Read a screenshot the runner wrote and consume it (used for the final frame of a session). */
export function readShot(ref?: string): string | undefined {
  if (!ref) return undefined;
  try {
    const buf = readFileSync(ref);
    rmSync(ref, { force: true });
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** Swap a screenshot file ref for the inline data URL the SSE clients read, then drop the file. */
function inlineShot(evt: Record<string, unknown>): Record<string, unknown> {
  const ref = evt.shotRef;
  if (typeof ref !== "string") return evt;
  const { shotRef: _drop, ...rest } = evt;
  void _drop;
  try {
    const buf = readFileSync(ref);
    rmSync(ref, { force: true });
    return { ...rest, screenshot: `data:image/jpeg;base64,${buf.toString("base64")}` };
  } catch {
    return rest; // a missed frame is better than a broken stream
  }
}

/** Stop whatever a runner is doing right now (process page action). */
export async function cancelRunnerWork(id: string): Promise<{ stopped: number; busy: boolean }> {
  const rpc = supervisor.rpc<RunnerApi>(id);
  if (!rpc) throw new Error(`runner ${id} is not running`);
  return rpc.cancelAll();
}
export async function cancelExecution(execId: string): Promise<boolean> {
  const results = await Promise.all(supervisor.status().filter(s => isRunner(s.id) && s.state === "alive").map(async s => {
    try { return await supervisor.rpc<RunnerApi>(s.id)?.cancel(execId) ?? false; } catch { return false; }
  }));
  return results.some(Boolean);
}

/** Web3 diagnostics run on a runner too: one process owns the browsers. */
export async function diagnoseOnRunner<T>(
  which: "verifyDapp" | "checkWallet" | "walletDappTest" | "captureSession",
  arg?: unknown,
): Promise<T> {
  const id = await pickRunner();
  const rpc = supervisor.rpc<RunnerApi>(id);
  if (!rpc) throw new Error(`runner ${id} has no RPC channel`);
  if (which === "checkWallet") return rpc.checkWallet(arg as string | undefined) as Promise<T>;
  return rpc[which](arg) as Promise<T>;
}
