// Bounded-concurrency run queue. The vision model is the bottleneck (~15-40s/step), so
// batch regressions (Run all P0 / whole suite) must not launch N browsers at once.
//
// Default is 1: a single self-hosted VL model returns 502 ("terminated") under concurrent
// load. Raise RUN_CONCURRENCY when the model backend is a farm/replica set that can serve
// parallel requests — and raise RUNNER_COUNT with it, since a runner executes one case at
// a time (see procs.ts).
import PQueue from "p-queue";

const CONCURRENCY = Math.max(1, Number(process.env.RUN_CONCURRENCY) || 1);

const queue = new PQueue({ concurrency: CONCURRENCY });

// p-queue tracks counts, not identities. Labels are ours: "what is running right now" is
// the question the process page and the queue endpoint actually get asked.
const activeLabels = new Set<string>();
let totalQueued = 0;
let totalDone = 0;

/** Enqueue a unit of work; resolves with its result when a worker slot frees up. */
export function enqueue<T>(run: () => Promise<T>, label = "task"): Promise<T> {
  totalQueued++;
  return queue.add(
    async () => {
      activeLabels.add(label);
      try {
        return await run();
      } finally {
        activeLabels.delete(label);
        totalDone++;
      }
    },
    { throwOnTimeout: true },
  ) as Promise<T>;
}

export interface QueueStatus {
  concurrency: number;
  active: number;
  waiting: number;
  totalQueued: number;
  totalDone: number;
  activeLabels: string[];
}
export const queueStatus = (): QueueStatus => ({
  concurrency: CONCURRENCY,
  active: queue.pending,
  waiting: queue.size,
  totalQueued,
  totalDone,
  activeLabels: [...activeLabels],
});
