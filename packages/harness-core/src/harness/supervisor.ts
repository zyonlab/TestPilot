import { fork, spawn, type ChildProcess } from "node:child_process";
import { EventBus } from "../obs/bus.js";
import { EventKind, ScopeSchema } from "../obs/envelope.js";
import { supervisorChannel } from "./rpc.js";
import { ZERO_SPEND, type ChildApi, type Heartbeat, type ParentApi, type Spend } from "./protocol.js";

/**
 * Restart policy is a per-process decision, not a global one:
 *
 *   always    the agent and capabilities — losing them stalls everything, and they
 *             resume from a checkpoint, so respawning is the right default
 *   never     runners — a failure that is not worth retrying must surface immediately.
 *             Whether to retry the WORK is the loop layer's call, not the supervisor's.
 *   on-crash  restart only on abnormal exit
 */
export type RestartPolicy = "always" | "on-crash" | "never";

export type ProcState =
  /** Registered but never started — not the same as having exited, which the UI must not conflate. */
  | "idle"
  | "spawning"
  | "alive"
  | "draining"
  | "exited"
  | "crashed"
  | "restarting";

interface BaseSpec {
  id: string;
  restart: RestartPolicy;
  env?: Record<string, string>;
  cwd?: string;
  /** SIGTERM → wait → SIGKILL window. */
  graceMs?: number;
  /** Backoff before a restart; tests pass 0. */
  backoffMs?: number;
}

export interface NodeProcSpec extends BaseSpec {
  kind: "node";
  /** Module path to fork. Use `execArgv: ["--import", "tsx"]` to run TypeScript in dev. */
  entry: string;
  argv?: string[];
  execArgv?: string[];
  /** Expected heartbeat period. 0 disables liveness monitoring for this process. */
  heartbeatMs?: number;
  /** How long the first health() may take before the spawn is considered failed. */
  readyTimeoutMs?: number;
}

export interface ExecProcSpec extends BaseSpec {
  kind: "exec";
  command: string;
  args?: string[];
  /** Non-Node capabilities (anvil, mock servers) prove liveness this way instead. */
  healthcheck?: () => Promise<boolean>;
  healthIntervalMs?: number;
  readyTimeoutMs?: number;
}

export type ProcSpec = NodeProcSpec | ExecProcSpec;

export interface ProcStatus {
  id: string;
  kind: ProcSpec["kind"];
  state: ProcState;
  pid?: number;
  startedAt?: string;
  restarts: number;
  lastHeartbeat?: string;
  currentTask?: string;
  /** Self-reported memory (node children only; exec-kind capabilities do not report). */
  rssMb?: number;
  cpuPct?: number;
  spend: Spend;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  lastError?: string;
}

interface Entry {
  spec: ProcSpec;
  child?: ChildProcess;
  rpc?: unknown;
  status: ProcStatus;
  intentionalStop: boolean;
  healthTimer?: ReturnType<typeof setInterval>;
  exited?: Promise<void>;
}

export interface SupervisorOptions {
  /**
   * Extra methods a child may call on its supervisor, built per process. This is how a
   * host lends children something only it can own — the model admission gate, for one:
   * the gate has to be a single instance, and children live in other processes.
   */
  extendParentApi?: (processId: string) => Record<string, (...args: never[]) => unknown>;
  /** Missed heartbeats before a process is declared crashed. */
  missedBeats?: number;
  /** Liveness sweep period. */
  monitorMs?: number;
  now?: () => Date;
}

const DEFAULT_GRACE_MS = 3000;
const DEFAULT_READY_MS = 10_000;

/**
 * Task-level process supervision.
 *
 * Deliberately not PM2-shaped: what we need is per-task semantics — which case is this
 * runner on, what has it spent, is it still beating — and the ability to kill one
 * execution without touching the agent. Service-level restarts are the easy part.
 */
export class Supervisor {
  private entries = new Map<string, Entry>();
  private monitor?: ReturnType<typeof setInterval>;
  private readonly missedBeats: number;
  private readonly extendParentApi?: (id: string) => Record<string, (...args: never[]) => unknown>;
  private readonly monitorMs: number;
  private readonly now: () => Date;
  private hooksAttached = false;

  constructor(
    private bus: EventBus,
    opts: SupervisorOptions = {},
  ) {
    this.missedBeats = opts.missedBeats ?? 3;
    this.extendParentApi = opts.extendParentApi;
    this.monitorMs = opts.monitorMs ?? 1000;
    this.now = opts.now ?? (() => new Date());
  }

  register(spec: ProcSpec): void {
    if (this.entries.has(spec.id)) throw new Error(`process already registered: ${spec.id}`);
    this.entries.set(spec.id, {
      spec,
      intentionalStop: false,
      status: { id: spec.id, kind: spec.kind, state: "idle", restarts: 0, spend: { ...ZERO_SPEND } },
    });
  }

  status(): ProcStatus[] {
    return [...this.entries.values()].map((e) => ({ ...e.status, spend: { ...e.status.spend } }));
  }

  statusOf(id: string): ProcStatus | undefined {
    const e = this.entries.get(id);
    return e ? { ...e.status, spend: { ...e.status.spend } } : undefined;
  }

  /** Typed remote for a Node child (undefined while it is not running). */
  rpc<R extends object>(id: string): R | undefined {
    return this.entries.get(id)?.rpc as R | undefined;
  }

  async start(id: string): Promise<void> {
    const e = this.must(id);
    if (e.child) return;
    e.intentionalStop = false;
    this.ensureMonitor();
    this.set(e, { state: "spawning", exitCode: undefined, exitSignal: undefined, lastError: undefined });
    e.spec.kind === "node" ? this.spawnNode(e) : this.spawnExec(e);
    await this.awaitReady(e);
  }

  async startAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.start(id)));
  }

  async stop(id: string): Promise<void> {
    const e = this.must(id);
    // Recorded before the early return, not after it: a process inside its restart backoff
    // has no child at this moment, and returning early left the pending restart armed — so
    // the one process you most want to stop, the one crash-looping, was the one that came
    // back. "Stopped" has to mean it stays stopped.
    e.intentionalStop = true;
    if (!e.child) {
      this.set(e, { state: "idle" });
      return;
    }
    this.set(e, { state: "draining" });
    const child = e.child;
    const grace = e.spec.graceMs ?? DEFAULT_GRACE_MS;
    if (e.spec.kind === "node") {
      // Ask nicely first so the child can flush its own state; the signals below are the backstop.
      await withTimeout((e.rpc as ChildApi | undefined)?.shutdown?.(), Math.min(grace, 1000)).catch(
        () => undefined,
      );
    }
    const done = e.exited ?? Promise.resolve();
    child.kill("SIGTERM");
    const killer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, grace);
    await done;
    clearTimeout(killer);
  }

  async restart(id: string): Promise<void> {
    await this.stop(id);
    await this.start(id);
  }

  /** Nothing may outlive the supervisor — orphan browsers and chains are a real leak. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
    if (this.monitor) {
      clearInterval(this.monitor);
      this.monitor = undefined;
    }
  }

  /** Kill children on our own exit paths, including the synchronous `exit` one. */
  attachExitHooks(): void {
    if (this.hooksAttached) return;
    this.hooksAttached = true;
    const bye = () => {
      for (const e of this.entries.values()) e.child?.kill("SIGKILL");
    };
    process.once("exit", bye);
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => {
        void this.stopAll().finally(() => process.exit(0));
      });
    }
  }

  /* ---------------------------------------------------------------- internals */

  private must(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`unknown process: ${id}`);
    return e;
  }

  private set(e: Entry, patch: Partial<ProcStatus>): void {
    e.status = { ...e.status, ...patch };
    // Every transition is a fact on the bus — the process page is a pure projection of these.
    this.bus.publish(EventKind.processStatus, { ...e.status }, { processId: e.spec.id });
  }

  private spawnNode(e: Entry): void {
    const spec = e.spec as NodeProcSpec;
    const child = fork(spec.entry, spec.argv ?? [], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env, TP_PROCESS_ID: spec.id },
      execArgv: spec.execArgv ?? [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      // Structured clone, not JSON: a rejected RPC must arrive with its message intact.
      // Under the default json serialization an Error crosses as `{}` and the caller is
      // left with "something failed" — which is exactly the failure you most need to read.
      serialization: "advanced",
    });
    e.child = child;
    const parentApi: ParentApi = {
      /**
       * Events arrive from another process, so they are input, not internal calls: a bad
       * kind or a stray scope field would otherwise be persisted into lineage forever.
       * Rejected events become an `error` event — dropping them silently would hide a bug
       * in whatever produced them.
       */
      emit: (kind, payload, scope) => {
        const parsed = ScopeSchema.safeParse(scope ?? {});
        if (typeof kind !== "string" || !kind.trim() || !parsed.success) {
          this.bus.publish(
            EventKind.error,
            {
              code: "WIRE_INVALID",
              message: `rejected an event from ${spec.id}`,
              detail: { kind, scopeError: parsed.success ? undefined : parsed.error.issues },
            },
            { processId: spec.id },
          );
          return;
        }
        this.bus.publish(kind, payload, { ...parsed.data, processId: spec.id });
      },
      heartbeat: (hb: Heartbeat) => {
        e.status.lastHeartbeat = hb.at;
        e.status.currentTask = hb.task;
        e.status.rssMb = hb.rssMb;
        e.status.cpuPct = hb.cpuPct;
        if (hb.spend) e.status.spend = hb.spend;
      },
    };
    e.rpc = supervisorChannel<ChildApi, ParentApi>(child, {
      ...parentApi,
      ...(this.extendParentApi?.(spec.id) ?? {}),
    } as ParentApi);
    this.pipeLogs(e, child);
    this.watchExit(e, child);
    this.set(e, { pid: child.pid, startedAt: this.now().toISOString(), lastHeartbeat: undefined });
  }

  private spawnExec(e: Entry): void {
    const spec = e.spec as ExecProcSpec;
    const child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    e.child = child;
    this.pipeLogs(e, child);
    this.watchExit(e, child);
    this.set(e, { pid: child.pid, startedAt: this.now().toISOString() });
    if (spec.healthcheck) {
      e.healthTimer = setInterval(() => {
        void spec
          .healthcheck!()
          .then((ok) => {
            if (!ok && e.status.state === "alive") this.set(e, { state: "spawning" });
            else if (ok && e.status.state !== "alive") this.set(e, { state: "alive" });
          })
          .catch(() => undefined);
      }, spec.healthIntervalMs ?? 2000);
    }
  }

  private pipeLogs(e: Entry, child: ChildProcess): void {
    const emit = (stream: "stdout" | "stderr") => (buf: Buffer) => {
      for (const line of buf.toString().split("\n")) {
        const text = line.trimEnd();
        if (text) {
          this.bus.publish(
            EventKind.log,
            { stream, text: text.slice(0, 2000) },
            { processId: e.spec.id },
          );
        }
      }
    };
    child.stdout?.on("data", emit("stdout"));
    child.stderr?.on("data", emit("stderr"));
  }

  private watchExit(e: Entry, child: ChildProcess): void {
    e.exited = new Promise<void>((resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null, err?: Error) => {
        if (e.child !== child) return resolve(); // already replaced by a restart
        if (e.healthTimer) clearInterval(e.healthTimer);
        e.child = undefined;
        e.rpc = undefined;
        const crashed = !e.intentionalStop;
        this.set(e, {
          state: crashed ? "crashed" : "exited",
          pid: undefined,
          currentTask: undefined,
          exitCode: code,
          exitSignal: signal,
          lastError: err?.message ?? e.status.lastError,
        });
        resolve();
        if (crashed) this.maybeRestart(e, code, signal);
      };
      child.once("exit", (code, signal) => finish(code, signal));
      child.once("error", (err) => finish(null, null, err));
    });
  }

  private maybeRestart(e: Entry, code: number | null, signal: NodeJS.Signals | null): void {
    const policy = e.spec.restart;
    const abnormal = code !== 0 || signal !== null;
    const should = policy === "always" || (policy === "on-crash" && abnormal);
    if (!should) return;
    e.status.restarts += 1;
    this.set(e, { state: "restarting" });
    const base = e.spec.backoffMs ?? 250;
    const delay = Math.min(30_000, base * 2 ** Math.max(0, e.status.restarts - 1));
    setTimeout(() => {
      if (e.intentionalStop || e.child) return;
      void this.start(e.spec.id).catch((err: Error) => this.set(e, { lastError: err.message }));
    }, delay).unref?.();
  }

  private async awaitReady(e: Entry): Promise<void> {
    const spec = e.spec;
    const timeout = (spec as NodeProcSpec).readyTimeoutMs ?? DEFAULT_READY_MS;
    if (spec.kind === "node") {
      const api = e.rpc as ChildApi;
      const res = await withTimeout(api.health(), timeout).catch((err: Error) => {
        this.set(e, { lastError: err.message });
        return undefined;
      });
      if (res?.ok) this.set(e, { state: "alive" });
      return;
    }
    if (!spec.healthcheck) {
      this.set(e, { state: "alive" });
      return;
    }
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await spec.healthcheck().catch(() => false)) {
        this.set(e, { state: "alive" });
        return;
      }
      await sleep(spec.healthIntervalMs ?? 200);
    }
    this.set(e, { lastError: "healthcheck did not pass before the ready timeout" });
  }

  /**
   * Liveness sweep. A hung process is worse than a dead one: it holds its slot and
   * reports nothing, so missing heartbeats are treated exactly like a crash.
   */
  private ensureMonitor(): void {
    if (this.monitor) return;
    this.monitor = setInterval(() => {
      const now = this.now().getTime();
      for (const e of this.entries.values()) {
        if (e.spec.kind !== "node" || !e.child || e.status.state !== "alive") continue;
        const period = e.spec.heartbeatMs ?? 0;
        if (!period) continue;
        const last = e.status.lastHeartbeat ? Date.parse(e.status.lastHeartbeat) : undefined;
        const since = now - (last ?? Date.parse(e.status.startedAt ?? new Date().toISOString()));
        if (since > period * this.missedBeats) {
          this.set(e, { lastError: `no heartbeat for ${since}ms` });
          e.child.kill("SIGKILL"); // exit handler classifies it as a crash and applies policy
        }
      }
    }, this.monitorMs);
    this.monitor.unref?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!p) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}
