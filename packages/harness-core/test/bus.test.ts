import { describe, expect, it } from "vitest";
import { EventBus } from "../src/obs/bus.js";
import { EventKind, type Envelope } from "../src/obs/envelope.js";
import { MemoryEventStore } from "../src/obs/store.js";
import { until } from "./helpers.js";

const bus = (coalesceMs = 0) => new EventBus(new MemoryEventStore(), { coalesceMs });

describe("EventBus", () => {
  it("persists before it notifies, so anything a subscriber saw is replayable", () => {
    const store = new MemoryEventStore();
    const b = new EventBus(store, { coalesceMs: 0 });
    const seen: Envelope[] = [];
    b.subscribe((e) => seen.push(e));
    const env = b.publish(EventKind.wfRunStarted, { graphVersion: 3 }, { wfRunId: "w1" });

    expect(seen.map((e) => e.id)).toEqual([env.id]);
    expect(store.since(0)).toHaveLength(1);
    expect(env.scope).toEqual({ wfRunId: "w1" });
  });

  it("replays from sinceId before live delivery — this is reconnect", () => {
    const b = bus();
    const first = b.publish(EventKind.log, { text: "a" });
    b.publish(EventKind.log, { text: "b" });
    const seen: string[] = [];
    b.subscribe((e) => seen.push((e.payload as { text: string }).text), { sinceId: first.id });
    b.publish(EventKind.log, { text: "c" });
    expect(seen).toEqual(["b", "c"]);
  });

  it("coalesces DELIVERY of progress kinds but stores every one", async () => {
    const store = new MemoryEventStore();
    const b = new EventBus(store, { coalesceMs: 20 });
    const seen: Envelope[] = [];
    b.subscribe((e) => seen.push(e));

    for (let i = 0; i < 5; i++) b.publish(EventKind.runProgress, { step: i }, { runId: "r1" });

    await until(() => seen.length > 0, "coalesced delivery");
    expect(seen).toHaveLength(1);
    expect((seen[0].payload as { step: number }).step).toBe(4); // last one wins
    expect(store.since(0)).toHaveLength(5); // lineage keeps all of them
  });

  it("keeps different scopes apart while coalescing", async () => {
    const b = bus(20);
    const seen: Envelope[] = [];
    b.subscribe((e) => seen.push(e));
    b.publish(EventKind.runProgress, { step: 1 }, { runId: "r1" });
    b.publish(EventKind.runProgress, { step: 1 }, { runId: "r2" });
    await until(() => seen.length >= 2, "two scopes delivered");
    expect(seen.map((e) => e.scope.runId).sort()).toEqual(["r1", "r2"]);
  });

  it("flushes held progress before a non-coalesced event, preserving order", async () => {
    const b = bus(50);
    const seen: string[] = [];
    b.subscribe((e) => seen.push(e.kind));
    b.publish(EventKind.runProgress, { step: 1 }, { runId: "r1" });
    b.publish(EventKind.runProgress, { step: 2 }, { runId: "r1" });
    b.publish(EventKind.runFinished, { status: "passed" }, { runId: "r1" });
    expect(seen).toEqual([EventKind.runProgress, EventKind.runFinished]);
  });

  it("a throwing subscriber cannot take down the publisher or its peers", () => {
    const b = bus();
    const seen: number[] = [];
    b.subscribe(() => {
      throw new Error("boom");
    });
    b.subscribe((e) => seen.push(e.id));
    expect(() => b.publish(EventKind.log, { text: "x" })).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("stops delivering after close()", () => {
    const b = bus();
    const seen: number[] = [];
    const sub = b.subscribe((e) => seen.push(e.id));
    b.publish(EventKind.log, {});
    sub.close();
    b.publish(EventKind.log, {});
    expect(seen).toHaveLength(1);
    expect(b.head()).toBe(2);
  });
});
