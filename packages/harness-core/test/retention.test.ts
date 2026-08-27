import { afterEach, expect, it, vi } from "vitest";
import { MemoryEventStore } from "../src/obs/store.js";
import { startRetention } from "../src/obs/retention.js";

const fill = (store: MemoryEventStore, n: number) => {
  for (let i = 0; i < n; i++)
    store.append({ ts: new Date().toISOString(), kind: "log", scope: {}, payload: { i } });
};

afterEach(() => vi.useRealTimers());

it("trims on start — a process that died between two intervals must not leave the file huge", () => {
  const store = new MemoryEventStore();
  fill(store, 50);
  const trims: number[] = [];
  const r = startRetention(store, { keepLast: 10, onTrim: (n) => trims.push(n) });
  expect(trims).toEqual([40]);
  expect(store.since(0)).toHaveLength(10);
  r.stop();
});

it("keeps trimming on its interval", () => {
  vi.useFakeTimers();
  const store = new MemoryEventStore();
  const r = startRetention(store, { keepLast: 5, everyMs: 1000 });
  fill(store, 20);
  expect(store.since(0)).toHaveLength(20);
  vi.advanceTimersByTime(1000);
  expect(store.since(0)).toHaveLength(5);
  r.stop();
});

it("keeps ids monotonic across trims, so a reconnecting client can still resume", () => {
  const store = new MemoryEventStore();
  fill(store, 20);
  const r = startRetention(store, { keepLast: 5 });
  const head = store.head();
  fill(store, 1);
  expect(store.head()).toBe(head + 1);
  expect(store.since(head)).toHaveLength(1);
  r.stop();
});

it("stops trimming after stop()", () => {
  vi.useFakeTimers();
  const store = new MemoryEventStore();
  const r = startRetention(store, { keepLast: 5, everyMs: 1000 });
  r.stop();
  fill(store, 20);
  vi.advanceTimersByTime(5000);
  expect(store.since(0)).toHaveLength(20);
});
