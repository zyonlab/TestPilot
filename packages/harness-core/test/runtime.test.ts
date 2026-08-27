import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EventBus } from "../src/obs/bus.js";
import { EventKind, type Envelope } from "../src/obs/envelope.js";
import { MemoryEventStore } from "../src/obs/store.js";
import { NodeRegistry } from "../src/graph/node.js";
import { MemoryOutputStore, runGraph } from "../src/graph/runtime.js";
import type { GraphDef } from "../src/graph/graph.js";

// A three-node line: seed → double → label. Enough to exercise ordering, contracts,
// partial re-runs, breakpoints, budget and failure, with no model anywhere in sight.
function harness(overrides: { doubleFn?: (n: number) => Promise<number> } = {}) {
  const events: Envelope[] = [];
  const bus = new EventBus(new MemoryEventStore(), { coalesceMs: 0 });
  bus.subscribe((e) => events.push(e));
  const calls: string[] = [];

  const registry = new NodeRegistry()
    .register({
      type: "seed",
      title: "seed",
      inKind: null,
      outKind: "number",
      params: z.object({ start: z.number().default(1) }),
      input: z.unknown(),
      output: z.number(),
      run: async (_in, params, ctx) => {
        calls.push("seed");
        ctx.spend({ calls: 1, tokens: 10 });
        return params.start;
      },
    })
    .register({
      type: "double",
      title: "double",
      inKind: "number",
      outKind: "number",
      params: z.object({}),
      input: z.number(),
      output: z.number(),
      run: async (n, _p, ctx) => {
        calls.push("double");
        ctx.spend({ calls: 1, tokens: 20 });
        return overrides.doubleFn ? overrides.doubleFn(n) : n * 2;
      },
    })
    .register({
      type: "label",
      title: "label",
      inKind: "number",
      outKind: "text",
      params: z.object({}),
      input: z.number(),
      output: z.string(),
      run: async (n) => {
        calls.push("label");
        return `n=${n}`;
      },
    })
    .register({
      type: "liar",
      title: "liar",
      inKind: "number",
      outKind: "text",
      params: z.object({}),
      input: z.number(),
      output: z.string(),
      run: async () => 42 as unknown as string, // breaks its own contract on purpose
    });

  const def: GraphDef = {
    id: "line",
    version: 3,
    nodes: [
      { id: "a", type: "seed", params: { start: 2 } },
      { id: "b", type: "double" },
      { id: "c", type: "label" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  };

  return { bus, events, registry, def, calls, store: new MemoryOutputStore() };
}

describe("runGraph", () => {
  it("runs the line in order and reports per-node cost", async () => {
    const h = harness();
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });

    expect(r.status).toBe("done");
    expect(h.calls).toEqual(["seed", "double", "label"]);
    expect(r.outputs).toEqual({ a: 2, b: 4, c: "n=4" });
    expect(r.spend).toMatchObject({ calls: 2, tokens: 30 });
    expect(r.nodes.map((n) => `${n.nodeId}:${n.status}`)).toEqual(["a:done", "b:done", "c:done"]);
    expect(r.graph).toEqual({ id: "line", version: 3 }); // the version is pinned into the result
  });

  it("emits the events the canvas draws itself from", async () => {
    const h = harness();
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });
    const kinds = h.events.map((e) => e.kind);
    expect(kinds[0]).toBe(EventKind.wfRunStarted);
    expect(kinds.at(-1)).toBe(EventKind.wfRunFinished);
    expect(kinds.filter((k) => k === EventKind.wfNodeStarted)).toHaveLength(3);
    // Every node event is scoped so the UI can attribute it without guessing.
    const started = h.events.find((e) => e.kind === EventKind.wfNodeStarted)!;
    expect(started.scope).toMatchObject({ wfRunId: r.wfRunId, nodeRunId: `${r.wfRunId}:a` });
  });

  it("re-runs a single node from the stored upstream output — debug mode ②", async () => {
    const h = harness();
    const first = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });
    h.calls.length = 0;

    const again = await runGraph(h.def, {
      registry: h.registry,
      bus: h.bus,
      store: h.store,
      wfRunId: first.wfRunId,
      mode: { kind: "only", node: "c" },
    });
    expect(h.calls).toEqual(["label"]); // nothing upstream was recomputed
    expect(again.outputs.c).toBe("n=4");
  });

  it("re-runs from a node downwards — debug mode ③", async () => {
    const h = harness();
    const first = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });
    h.calls.length = 0;

    await runGraph(h.def, {
      registry: h.registry,
      bus: h.bus,
      store: h.store,
      wfRunId: first.wfRunId,
      mode: { kind: "from", node: "b" },
    });
    expect(h.calls).toEqual(["double", "label"]);
  });

  it("refuses to run a node whose upstream has never produced anything", async () => {
    const h = harness();
    const r = await runGraph(h.def, {
      registry: h.registry,
      bus: h.bus,
      store: h.store,
      mode: { kind: "only", node: "c" },
    });
    expect(r.status).toBe("failed");
    expect(r.error?.message).toMatch(/no stored output from b/);
  });

  it("pauses at a breakpoint and resumes from there", async () => {
    const h = harness();
    const paused = await runGraph(h.def, {
      registry: h.registry,
      bus: h.bus,
      store: h.store,
      breakpoints: ["c"],
    });
    expect(paused.status).toBe("paused");
    expect(paused.pausedAt).toBe("c");
    expect(h.calls).toEqual(["seed", "double"]);

    const resumed = await runGraph(h.def, {
      registry: h.registry,
      bus: h.bus,
      store: h.store,
      wfRunId: paused.wfRunId,
      mode: { kind: "from", node: "c" },
    });
    expect(resumed.status).toBe("done");
    expect(resumed.outputs.c).toBe("n=4");
  });

  it("resuming keeps the breakpoint set, and still runs the node it was asked for", async () => {
    // Resuming with the breakpoints cleared would be the easy way out — and it would mean
    // a run can only ever stop once. The set is kept; what changes is that a node named in
    // the mode is a node someone chose to run.
    const h = harness();
    const paused = await runGraph(h.def, {
      registry: h.registry,
      bus: h.bus,
      store: h.store,
      breakpoints: ["b", "c"],
    });
    expect(paused.pausedAt).toBe("b");

    const again = await runGraph(h.def, {
      registry: h.registry,
      bus: h.bus,
      store: h.store,
      wfRunId: paused.wfRunId,
      mode: { kind: "from", node: "b" },
      breakpoints: ["b", "c"],
    });
    // b ran; c is still a breakpoint, so it stops there next.
    expect(again.status).toBe("paused");
    expect(again.pausedAt).toBe("c");
    expect(h.calls).toEqual(["seed", "double"]);

    const last = await runGraph(h.def, {
      registry: h.registry,
      bus: h.bus,
      store: h.store,
      wfRunId: paused.wfRunId,
      mode: { kind: "from", node: "c" },
      breakpoints: ["b", "c"],
    });
    expect(last.status).toBe("done");
    expect(last.outputs.c).toBe("n=4");
  });

  it("stops on a node that breaks its own output contract, rather than passing it on", async () => {
    const h = harness();
    const def = { ...h.def, nodes: [h.def.nodes[0], h.def.nodes[1], { id: "c", type: "liar" }] };
    const r = await runGraph(def, { registry: h.registry, bus: h.bus, store: h.store });
    expect(r.status).toBe("failed");
    expect(r.error).toMatchObject({ node: "c" });
    expect(r.error?.message).toMatch(/output does not match liar/);
  });

  it("records a node failure with its message and stops the line", async () => {
    const h = harness({
      doubleFn: async () => {
        throw new Error("model said no");
      },
    });
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store });
    expect(r.status).toBe("failed");
    expect(r.error).toEqual({ node: "b", message: "model said no" });
    expect(h.calls).toEqual(["seed", "double"]); // label never ran
  });

  it("ends as 'budget' rather than 'done' when it runs out — the two must not read alike", async () => {
    const h = harness();
    const r = await runGraph(h.def, {
      registry: h.registry,
      bus: h.bus,
      store: h.store,
      budget: { calls: 1 },
    });
    expect(r.status).toBe("budget");
    expect(r.pausedAt).toBe("b");
    expect(r.outputs.c).toBeUndefined();
  });

  /**
   * 一次撞了上限、又被续上的运行仍然是**一次**运行。
   *
   * 此前计数从零重来：上限悄悄变成了「每续一次给一份」，而这次运行最后记下来的花费
   * 比它真的花的少。一个少报花费的报告比没有报告更糟，因为它看起来像一次测量。
   */
  describe("续跑时的上限", () => {
    it("接着上一段的花费算，不从零重来", async () => {
      const h = harness();
      const r = await runGraph(h.def, {
        registry: h.registry,
        bus: h.bus,
        store: h.store,
        spent: { calls: 5, tokens: 500, usd: 0, ms: 0 },
      });
      expect(r.status).toBe("done");
      // 这条线上有两步会计费，加上带过来的五次。
      expect(r.spend.calls).toBe(7);
      expect(r.spend.tokens).toBeGreaterThanOrEqual(500);
    });

    it("带过来的花费已经到顶时，第一步就停住——续跑不等于把上限撤掉", async () => {
      const h = harness();
      const r = await runGraph(h.def, {
        registry: h.registry,
        bus: h.bus,
        store: h.store,
        budget: { calls: 3 },
        spent: { calls: 3, tokens: 0, usd: 0, ms: 0 },
      });
      expect(r.status).toBe("budget");
      expect(r.pausedAt).toBe("a");
      expect(h.calls).toEqual([]);
    });

    it("时间上限算的是整次运行，不是这一段", async () => {
      const h = harness();
      const r = await runGraph(h.def, {
        registry: h.registry,
        bus: h.bus,
        store: h.store,
        budget: { ms: 1000 },
        spent: { calls: 0, tokens: 0, usd: 0, ms: 60_000 },
      });
      expect(r.status).toBe("budget");
      expect(r.pausedAt).toBe("a");
      // 报出来的耗时含上一段，否则这次运行看起来只跑了几毫秒。
      expect(r.spend.ms).toBeGreaterThanOrEqual(60_000);
    });
  });

  it("stops when cancelled", async () => {
    const h = harness();
    const ac = new AbortController();
    ac.abort();
    const r = await runGraph(h.def, { registry: h.registry, bus: h.bus, store: h.store, signal: ac.signal });
    expect(r.status).toBe("cancelled");
    expect(h.calls).toEqual([]);
  });

  it("refuses an invalid graph before running anything", async () => {
    const h = harness();
    const broken: GraphDef = { ...h.def, edges: [{ from: "a", to: "c" }, { from: "b", to: "c" }] };
    await expect(runGraph(broken, { registry: h.registry, bus: h.bus, store: h.store })).rejects.toThrow(
      /is invalid/,
    );
    expect(h.calls).toEqual([]);
  });

  it("passes the ablation set to nodes and reports it with the result", async () => {
    const h = harness();
    let seen: string[] = [];
    h.registry.register({
      type: "peek",
      title: "peek",
      inKind: "number",
      outKind: "text",
      params: z.object({}),
      input: z.number(),
      output: z.string(),
      run: async (_n, _p, ctx) => {
        seen = [...ctx.ablated];
        return "ok";
      },
    });
    const def: GraphDef = { ...h.def, nodes: [h.def.nodes[0], h.def.nodes[1], { id: "c", type: "peek" }] };
    const r = await runGraph(def, {
      registry: h.registry,
      bus: h.bus,
      store: h.store,
      ablate: ["memory", "oracle"],
    });
    expect(seen).toEqual(["memory", "oracle"]);
    expect(r.ablated).toEqual(["memory", "oracle"]);
  });
});
