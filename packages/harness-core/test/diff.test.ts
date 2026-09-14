import { describe, expect, it } from "vitest";
import { diffGraphs, describeDiff, SqliteGraphStore, type GraphDef } from "../src/index.js";

/**
 * The diff exists so that "v3 beat v1" can be followed by "because of what". These check it
 * answers that at the resolution a person edits at — one parameter, one wire — rather than
 * reporting that the graph is not the same graph.
 */

const base: GraphDef = {
  id: "g",
  version: 1,
  nodes: [
    { id: "spec", type: "source.spec", params: { path: "a.md" } },
    { id: "design", type: "design.cases", params: { maxCasesPerStory: 4, lang: "zh" } },
  ],
  edges: [{ from: "spec", to: "design" }],
};

describe("diffing two versions", () => {
  it("says nothing changed when nothing did", () => {
    const d = diffGraphs(base, { ...base, version: 2 });
    expect(d.identical).toBe(true);
    expect(describeDiff(d)).toEqual(["no change"]);
  });

  it("names the parameter that moved, not just the node", () => {
    const next = {
      ...base,
      version: 2,
      nodes: base.nodes.map((n) => (n.id === "design" ? { ...n, params: { maxCasesPerStory: 6, lang: "zh" } } : n)),
    };
    const d = diffGraphs(base, next);
    expect(d.paramsChanged).toEqual([{ nodeId: "design", key: "maxCasesPerStory", from: 4, to: 6 }]);
    expect(describeDiff(d)).toEqual(["~ design.maxCasesPerStory: 4 → 6"]);
  });

  it("reports added and removed nodes and wires", () => {
    const next: GraphDef = {
      id: "g",
      version: 2,
      nodes: [base.nodes[0], { id: "gate", type: "gate.textcase" }],
      edges: [{ from: "spec", to: "gate" }],
    };
    const d = diffGraphs(base, next);
    expect(d.nodesAdded.map((n) => n.id)).toEqual(["gate"]);
    expect(d.nodesRemoved.map((n) => n.id)).toEqual(["design"]);
    expect(d.edgesAdded).toEqual([{ from: "spec", to: "gate" }]);
    expect(d.edgesRemoved).toEqual([{ from: "spec", to: "design" }]);
    expect(d.identical).toBe(false);
  });

  it("catches a node id kept while its type was swapped underneath", () => {
    const next = {
      ...base,
      version: 2,
      nodes: base.nodes.map((n) => (n.id === "design" ? { ...n, type: "design.other" } : n)),
    };
    expect(diffGraphs(base, next).typeChanged).toEqual([
      { nodeId: "design", from: "design.cases", to: "design.other" },
    ]);
  });

  it("treats a param appearing or disappearing as a change", () => {
    const next = {
      ...base,
      version: 2,
      nodes: base.nodes.map((n) => (n.id === "spec" ? { ...n, params: {} } : n)),
    };
    expect(diffGraphs(base, next).paramsChanged).toEqual([
      { nodeId: "spec", key: "path", from: "a.md", to: undefined },
    ]);
  });
});

describe("the version store", () => {
  it("keeps every version and hands back the one asked for", () => {
    const store = new SqliteGraphStore(":memory:");
    store.save(base);
    store.save({ ...base, version: 2, nodes: [base.nodes[0]] }, "dropped design");
    expect(store.versions("g").map((v) => v.version)).toEqual([2, 1]);
    expect(store.get("g", 1)?.nodes).toHaveLength(2);
    expect(store.latest("g")?.version).toBe(2);
    expect(store.versions("g")[0].note).toBe("dropped design");
  });

  it("lists each graph at its newest version, not every version of it", () => {
    const store = new SqliteGraphStore(":memory:");
    store.save(base);
    store.save({ ...base, version: 2 });
    store.save({ ...base, id: "h", version: 1 });
    expect(store.all().map((g) => `${g.id}v${g.version}`).sort()).toEqual(["gv2", "hv1"]);
  });

  it("survives a graph being saved twice at the same version", () => {
    const store = new SqliteGraphStore(":memory:");
    store.save(base);
    store.save({ ...base, nodes: [] });
    expect(store.get("g", 1)?.nodes).toEqual([]);
  });
});
