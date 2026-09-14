import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NodeRegistry, type AnyNodeDef } from "../src/graph/node.js";
import { downstreamOf, topoOrder, validateGraph, type GraphDef } from "../src/graph/graph.js";

const node = (over: Partial<AnyNodeDef> & { type: string }): AnyNodeDef =>
  ({
    title: over.type,
    inKind: null,
    outKind: "cases",
    params: z.object({}).passthrough(),
    input: z.unknown(),
    output: z.unknown(),
    run: async () => ({}),
    ...over,
  }) as AnyNodeDef;

const registry = new NodeRegistry()
  .register(node({ type: "source.spec", inKind: null, outKind: "spec" }))
  .register(node({ type: "plan.stories", inKind: "spec", outKind: "stories" }))
  .register(
    node({
      type: "design.cases",
      inKind: "stories",
      outKind: "cases",
      params: z.object({ negativeRatio: z.number().min(0).max(1).default(0.3) }),
    }),
  )
  .register(node({ type: "gate.textcase", inKind: "cases", outKind: "cases" }));

const line = (): GraphDef => ({
  id: "g1",
  version: 1,
  nodes: [
    { id: "spec", type: "source.spec" },
    { id: "stories", type: "plan.stories" },
    { id: "design", type: "design.cases", params: { negativeRatio: 0.4 } },
    { id: "gate", type: "gate.textcase" },
  ],
  edges: [
    { from: "spec", to: "stories" },
    { from: "stories", to: "design" },
    { from: "design", to: "gate" },
  ],
});

describe("graph validation", () => {
  it("accepts a well-formed pipeline", () => {
    expect(validateGraph(line(), registry)).toEqual([]);
  });

  it("rejects a connection whose kinds do not line up — the canvas must refuse it while it is drawn", () => {
    const def = line();
    def.edges = [{ from: "spec", to: "design" }, { from: "stories", to: "gate" }];
    const issues = validateGraph(def, registry);
    expect(issues.some((i) => i.message.includes('outputs "spec" but design.cases expects "stories"'))).toBe(true);
  });

  it("rejects params that do not satisfy the node's schema", () => {
    const def = line();
    def.nodes[2].params = { negativeRatio: 5 };
    const issues = validateGraph(def, registry);
    expect(issues[0].at.node).toBe("design");
    expect(issues[0].message).toMatch(/invalid params/);
  });

  it("rejects an unknown node type instead of failing twenty minutes into a run", () => {
    const def = line();
    def.nodes.push({ id: "mystery", type: "does.not.exist" });
    expect(validateGraph(def, registry).some((i) => i.message.includes("unknown node type"))).toBe(true);
  });

  it("allows a graph that starts halfway down: the run seeds its root", () => {
    // Stage two is run on its own this way — the runtime still rejects a seed whose shape
    // does not match the root node's input schema.
    const def: GraphDef = {
      id: "half",
      version: 1,
      nodes: [
        { id: "design", type: "design.cases" },
        { id: "gate", type: "gate.textcase" },
      ],
      edges: [{ from: "design", to: "gate" }],
    };
    expect(validateGraph(def, registry)).toEqual([]);
  });

  it("rejects two inputs into one node — merging is an explicit operation, not a hidden rule", () => {
    const def = line();
    def.nodes.push({ id: "stories2", type: "plan.stories" });
    def.edges.push({ from: "spec", to: "stories2" }, { from: "stories2", to: "design" });
    expect(validateGraph(def, registry).some((i) => i.message.includes("use a merge node"))).toBe(true);
  });

  it("rejects feeding anything into a source node", () => {
    const def = line();
    def.edges.push({ from: "gate", to: "spec" });
    expect(validateGraph(def, registry).some((i) => i.message.includes("takes no input"))).toBe(true);
  });

  it("reports a cycle with the path, not just the fact", () => {
    const def: GraphDef = {
      id: "cyc",
      version: 1,
      nodes: [
        { id: "a", type: "plan.stories" },
        { id: "b", type: "design.cases" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    };
    const cycle = validateGraph(def, registry).find((i) => i.message.startsWith("cycle:"));
    expect(cycle?.message).toContain("→");
  });
});

describe("graph traversal", () => {
  it("orders nodes stably — the same graph runs in the same sequence every time", () => {
    expect(topoOrder(line())).toEqual(["spec", "stories", "design", "gate"]);
    const shuffled = line();
    shuffled.nodes.reverse();
    expect(topoOrder(shuffled)).toEqual(["spec", "stories", "design", "gate"]);
  });

  it("computes what a re-run from a node has to redo", () => {
    expect(downstreamOf(line(), "design")).toEqual(["design", "gate"]);
    expect(downstreamOf(line(), "spec")).toEqual(["spec", "stories", "design", "gate"]);
  });

  it("throws on a cycle rather than looping", () => {
    const def = line();
    def.edges.push({ from: "gate", to: "stories" });
    expect(() => topoOrder(def)).toThrow(/cycle/);
  });
});
