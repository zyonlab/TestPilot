import type { EventStore } from "./store.js";

/**
 * Lineage retention.
 *
 * The event table is append-only and everything lands in it — including every stderr line
 * a child writes. Left alone it grows without bound, and the store is also what a
 * reconnecting client replays from, so "how far back do we keep" is a real policy, not a
 * cleanup afterthought.
 *
 * Deliberately count-based rather than age-based: what has to stay bounded is the file,
 * and a busy hour produces more rows than a quiet week.
 */
export interface RetentionOptions {
  /** How many of the newest events to keep. */
  keepLast: number;
  /** How often to trim. */
  everyMs?: number;
  /** Called after each trim that removed something (used for logging). */
  onTrim?: (removed: number, head: number) => void;
}

export interface Retention {
  /** Trim now. Returns how many rows were removed. */
  trim(): number;
  stop(): void;
}

export function startRetention(store: EventStore, opts: RetentionOptions): Retention {
  const everyMs = opts.everyMs ?? 10 * 60_000;
  const trim = (): number => {
    const removed = store.prune(opts.keepLast);
    if (removed > 0) opts.onTrim?.(removed, store.head());
    return removed;
  };
  // Trim on start too: the previous process may have exited between two intervals.
  trim();
  const timer = setInterval(trim, everyMs);
  timer.unref?.();
  return { trim, stop: () => clearInterval(timer) };
}
