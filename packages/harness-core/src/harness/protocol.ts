/**
 * The control-plane contract between the supervisor and a supervised Node process.
 *
 * Commands travel over RPC (this file); facts travel over the event bus. A child
 * never mutates shared state directly — it reports, and the supervisor publishes.
 */

export interface Spend {
  calls: number;
  tokens: number;
  usd: number;
  ms: number;
}

export const ZERO_SPEND: Spend = { calls: 0, tokens: 0, usd: 0, ms: 0 };

export interface Heartbeat {
  at: string;
  /** Resident set size, MB. Self-reported: a child knows its own memory, the parent guesses. */
  rssMb?: number;
  /** Share of one core used since the last beat, 0-100. Also self-reported, same reason. */
  cpuPct?: number;
  /** What this process is working on right now — shown on the process card. */
  task?: string;
  /** Cumulative spend for THIS process, so cost can be attributed per process. */
  spend?: Spend;
}

/** Implemented by every supervised Node child. */
export interface ChildApi {
  health(): Promise<{ ok: boolean; detail?: string }>;
  /** Ask the child to wind down. The supervisor still enforces SIGTERM/SIGKILL after grace. */
  shutdown(): Promise<void>;
}

/** Implemented by the supervisor, callable from a child. */
export interface ParentApi {
  emit(kind: string, payload: unknown, scope?: Record<string, string>): void;
  heartbeat(hb: Heartbeat): void;
}

/** One-way methods: the caller must not wait for a reply. */
export const EVENT_METHODS = ["emit", "heartbeat"] as const;
