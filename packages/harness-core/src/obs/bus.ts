import {
  COALESCED_KINDS,
  coalesceKey,
  type Envelope,
  type Scope,
} from "./envelope.js";
import type { EventStore } from "./store.js";

export interface Subscription {
  close(): void;
}

export interface BusOptions {
  /** Delivery-side merge window for high-frequency kinds. 0 disables merging. */
  coalesceMs?: number;
  coalesced?: ReadonlySet<string>;
  /** Injectable clock so tests don't have to sleep in wall time. */
  now?: () => Date;
}

/**
 * Publish/subscribe over a durable store.
 *
 * Two rules that the rest of the system depends on:
 *
 *  1. **Persist first, then notify.** A subscriber can never observe an event that
 *     is not in lineage, so "what the UI showed" is always replayable.
 *  2. **Coalescing is a delivery concern only.** Progress-type kinds are merged per
 *     (kind, scope) inside a small window before reaching a subscriber, but every
 *     single one is stored. Pending merges are flushed before any non-coalesced
 *     event is delivered, so a subscriber never sees `run.finished` before the
 *     progress line that preceded it.
 */
export class EventBus {
  private subs = new Set<Sub>();
  private readonly coalesceMs: number;
  private readonly coalesced: ReadonlySet<string>;
  private readonly now: () => Date;

  constructor(
    private store: EventStore,
    opts: BusOptions = {},
  ) {
    this.coalesceMs = opts.coalesceMs ?? 100;
    this.coalesced = opts.coalesced ?? COALESCED_KINDS;
    this.now = opts.now ?? (() => new Date());
  }

  publish<T>(kind: string, payload: T, scope: Scope = {}): Envelope<T> {
    const env = this.store.append({
      ts: this.now().toISOString(),
      kind,
      scope,
      payload,
    }) as Envelope<T>;
    for (const s of this.subs) s.offer(env);
    return env;
  }

  /**
   * `sinceId` replays everything after that id from the store before live delivery
   * starts — this is how a reconnecting UI catches up without a full state refetch.
   */
  subscribe(fn: (e: Envelope) => void, opts: { sinceId?: number; limit?: number } = {}): Subscription {
    const sub = new Sub(fn, this.coalesceMs, this.coalesced);
    if (opts.sinceId !== undefined) {
      for (const e of this.store.since(opts.sinceId, opts.limit)) sub.deliverNow(e);
    }
    this.subs.add(sub);
    return {
      close: () => {
        sub.dispose();
        this.subs.delete(sub);
      },
    };
  }

  head(): number {
    return this.store.head();
  }

  /** Raw lineage read — used by replay and by resync when a client fell too far behind. */
  replay(fromId = 0, limit = 10_000): Envelope[] {
    return this.store.since(fromId, limit);
  }

  close(): void {
    for (const s of this.subs) s.dispose();
    this.subs.clear();
  }
}

class Sub {
  private pending = new Map<string, Envelope>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private fn: (e: Envelope) => void,
    private coalesceMs: number,
    private coalesced: ReadonlySet<string>,
  ) {}

  offer(e: Envelope): void {
    if (this.disposed) return;
    if (this.coalesceMs > 0 && this.coalesced.has(e.kind)) {
      this.pending.set(coalesceKey(e), e); // last one wins
      if (!this.timer) this.timer = setTimeout(() => this.flush(), this.coalesceMs);
      return;
    }
    this.flush(); // keep ordering: anything held back goes out first
    this.deliverNow(e);
  }

  deliverNow(e: Envelope): void {
    if (this.disposed) return;
    try {
      this.fn(e);
    } catch {
      // A throwing subscriber must not take down the publisher or the other subscribers.
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending.size) return;
    const batch = [...this.pending.values()].sort((a, b) => a.id - b.id);
    this.pending.clear();
    for (const e of batch) this.deliverNow(e);
  }

  dispose(): void {
    this.flush();
    this.disposed = true;
  }
}
