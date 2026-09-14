import { expect, it } from "vitest";
import { enqueue, queueStatus } from "../src/queue.js";

// The whole point of this queue is that a suite run cannot open more browsers than the
// model backend can serve. That invariant is what gets tested here — not p-queue itself.
it("never runs more than RUN_CONCURRENCY tasks at once, and reports what is running", async () => {
  const { concurrency } = queueStatus();
  let inFlight = 0;
  let peak = 0;
  const release: Array<() => void> = [];

  const tasks = Array.from({ length: 5 }, (_, i) =>
    enqueue(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => release.push(r));
      inFlight -= 1;
      return i;
    }, `case-${i}`),
  );

  await new Promise((r) => setTimeout(r, 20));
  expect(queueStatus().active).toBe(concurrency);
  expect(queueStatus().waiting).toBe(5 - concurrency);
  expect(queueStatus().activeLabels).toEqual(["case-0"].slice(0, concurrency));

  // Drain: each release lets the next queued task in.
  while (release.length) {
    release.shift()!();
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3, 4]);
  expect(peak).toBeLessThanOrEqual(concurrency);
  expect(queueStatus().activeLabels).toEqual([]);
  expect(queueStatus().totalDone).toBe(5);
});

it("propagates a task's failure to its caller without stalling the queue", async () => {
  await expect(enqueue(async () => {
    throw new Error("task blew up");
  }, "boom")).rejects.toThrow("task blew up");
  expect(await enqueue(async () => "next runs fine", "after")).toBe("next runs fine");
});
