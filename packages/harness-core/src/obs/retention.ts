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
  /**
   * 哪些运行的事件**一行都不删**，通常是「还没跑完的那些」。
   *
   * 保留窗口按条数算，而一次跑三天的运行会在自己还没跑完的时候被挤出窗口——
   * 那时候「这次运行到底发生了什么」永远失去了答案，而界面上看不出任何异常：
   * 轨迹只是空的。每次修剪都重新问一遍，因为「还没跑完」这件事一直在变。
   */
  protectRuns?: () => string[];
  /**
   * 吵闹的那几类各自的窗口，例如 `{ log: 20000, "process.status": 2000 }`。
   *
   * 血缘和日志挤在同一张表里，而按总条数裁的时候日志赢——实测 20 万行里
   * `log` 占 74.3%、血缘只占 1.47%，而血缘是「一次运行发生了什么」的唯一记录。
   * 给吵的那几类单独一个小窗口，血缘就能在同样大小的文件里活得久得多。
   */
  keepByKind?: Record<string, number>;
}

export interface Retention {
  /** Trim now. Returns how many rows were removed. */
  trim(): number;
  stop(): void;
}

export function startRetention(store: EventStore, opts: RetentionOptions): Retention {
  const everyMs = opts.everyMs ?? 10 * 60_000;
  const trim = (): number => {
    const protect = opts.protectRuns?.() ?? [];
    // 先按 kind 裁吵的那几类，再按总条数兜底。顺序反过来的话，
    // 总条数那一刀会先把血缘裁掉，而它恰恰是最该留的那 1.47%。
    let removed = 0;
    for (const [kind, keep] of Object.entries(opts.keepByKind ?? {}))
      removed += store.pruneKind?.(kind, keep, protect) ?? 0;
    removed += store.prune(opts.keepLast, protect);
    if (removed > 0) opts.onTrim?.(removed, store.head());
    return removed;
  };
  // Trim on start too: the previous process may have exited between two intervals.
  trim();
  const timer = setInterval(trim, everyMs);
  timer.unref?.();
  return { trim, stop: () => clearInterval(timer) };
}
