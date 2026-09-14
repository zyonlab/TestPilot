import { childChannel } from "./rpc.js";
import { ZERO_SPEND, type ChildApi, type ParentApi, type Spend } from "./protocol.js";

export interface ChildHandle {
  /** Process id assigned by the supervisor (also in `TP_PROCESS_ID`). */
  id: string;
  /**
   * The supervisor's API. Typed as ParentApi plus an open map, because the extra methods
   * a host lends its children (see `extendParentApi`) are known to the host, not here.
   */
  parent: ParentApi & { [method: string]: (...args: never[]) => Promise<never> };
  /** Publish a fact upward. It lands in lineage and reaches the UI. */
  emit(kind: string, payload: unknown, scope?: Record<string, string>): void;
  /** What this process is doing right now — shown on its process card. */
  setTask(task: string | undefined): void;
  /** Accumulate spend so cost can be attributed per process. */
  addSpend(delta: Partial<Spend>): void;
  stop(): void;
}

export interface StartChildOptions {
  /** Extra RPC methods this process exposes beyond health/shutdown. */
  api?: Record<string, (...args: never[]) => unknown>;
  health?: () => Promise<{ ok: boolean; detail?: string }> | { ok: boolean; detail?: string };
  onShutdown?: () => Promise<void> | void;
  heartbeatMs?: number;
}

/**
 * Boilerplate for a supervised process: RPC wiring, heartbeat loop, spend accounting.
 * Apps should not re-implement any of this — a process that beats differently is a
 * process the supervisor can't reason about.
 */
export function startChild(opts: StartChildOptions = {}): ChildHandle {
  const id = process.env.TP_PROCESS_ID ?? "unknown";
  let task: string | undefined;
  const spend: Spend = { ...ZERO_SPEND };
  const startedAt = Date.now();
  // CPU is a rate, not a level: it only means anything as a delta between two beats.
  let lastCpu = process.cpuUsage();
  let lastBeat = Date.now();

  const api: ChildApi & Record<string, unknown> = {
    health: async () => (opts.health ? await opts.health() : { ok: true, detail: id }),
    shutdown: async () => {
      await opts.onShutdown?.();
      clearInterval(timer);
      // Give the reply a tick to reach the supervisor before we go.
      setTimeout(() => process.exit(0), 10).unref();
    },
    ...(opts.api ?? {}),
  };

  const rpc = childChannel<ParentApi, typeof api>(api);

  // If the supervisor goes away — including a SIGKILL it can't run handlers for — the IPC
  // channel closes. Leave rather than linger: an orphaned runner still holds a browser,
  // a port and a test account, and nothing is left that knows it exists.
  process.on("disconnect", () => process.exit(0));
  const beat = () => {
    spend.ms = Date.now() - startedAt;
    const now = Date.now();
    const cpu = process.cpuUsage();
    const elapsedUs = Math.max(1, (now - lastBeat) * 1000);
    const usedUs = cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
    lastCpu = cpu;
    lastBeat = now;
    rpc.heartbeat({
      at: new Date().toISOString(),
      task,
      spend: { ...spend },
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      cpuPct: Math.min(999, Math.round((usedUs / elapsedUs) * 100)),
    });
  };
  const timer = setInterval(beat, opts.heartbeatMs ?? 1000);
  timer.unref?.();
  beat();

  return {
    id,
    parent: rpc as unknown as ChildHandle["parent"],
    emit: (kind, payload, scope) => rpc.emit(kind, payload, scope),
    setTask: (t) => {
      task = t;
      beat();
    },
    addSpend: (d) => {
      spend.calls += d.calls ?? 0;
      spend.tokens += d.tokens ?? 0;
      spend.usd += d.usd ?? 0;
    },
    stop: () => clearInterval(timer),
  };
}
