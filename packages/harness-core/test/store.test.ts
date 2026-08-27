import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEventStore, SqliteEventStore, type EventStore } from "../src/obs/store.js";

const row = (kind: string, payload: unknown = {}) => ({
  ts: new Date().toISOString(),
  kind,
  scope: {},
  payload,
});

function contract(name: string, make: () => EventStore) {
  describe(name, () => {
    it("assigns monotonic ids and reads back everything after an id", () => {
      const s = make();
      const a = s.append(row("one"));
      const b = s.append(row("two"));
      expect(b.id).toBeGreaterThan(a.id);
      expect(s.head()).toBe(b.id);
      expect(s.since(a.id).map((e) => e.kind)).toEqual(["two"]);
      expect(s.since(0).length).toBe(2);
      s.close();
    });

    it("keeps ids monotonic across pruning — resume-from-lastEventId depends on it", () => {
      const s = make();
      for (let i = 0; i < 5; i++) s.append(row(`k${i}`));
      const removed = s.prune(2);
      expect(removed).toBe(3);
      const next = s.append(row("after-prune"));
      expect(next.id).toBe(6);
      expect(s.since(0).map((e) => e.kind)).toEqual(["k3", "k4", "after-prune"]);
      s.close();
    });

    it("round-trips scope and payload", () => {
      const s = make();
      s.append({ ...row("x", { a: 1, nested: { b: [1, 2] } }), scope: { runId: "r1" } });
      const [e] = s.since(0);
      expect(e.scope).toEqual({ runId: "r1" });
      expect(e.payload).toEqual({ a: 1, nested: { b: [1, 2] } });
      s.close();
    });
  });
}

contract("MemoryEventStore", () => new MemoryEventStore());
contract("SqliteEventStore", () => new SqliteEventStore(":memory:"));

describe("SqliteEventStore durability", () => {
  it("survives a reopen — lineage is the point of this table", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-store-"));
    const path = join(dir, "events.db");
    const a = new SqliteEventStore(path);
    a.append(row("persisted", { n: 1 }));
    a.close();

    const b = new SqliteEventStore(path);
    expect(b.since(0).map((e) => e.kind)).toEqual(["persisted"]);
    expect(b.append(row("next")).id).toBe(2);
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
