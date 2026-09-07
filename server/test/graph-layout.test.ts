import { describe, it, expect } from "vitest";
import { saveGraph, getGraph, graphStore } from "../src/graphs.js";
import type { GraphDef } from "@testpilot/harness-core";

const base = (): GraphDef => ({
  id: `layout-${Math.random().toString(36).slice(2, 8)}`,
  version: 0,
  nodes: [
    { id: "a", type: "explore", params: { url: "x" } },
    { id: "b", type: "spec" },
  ],
  edges: [{ from: "a", to: "b" }],
});

describe("只挪位置不立新版本", () => {
  it("拖动节点后保存，版本号不动", () => {
    const g = base();
    const v1 = saveGraph(g, "初版");
    expect(v1.version).toBe(1);

    const moved = {
      ...v1,
      nodes: v1.nodes.map((n) => ({ ...n, pos: { x: 100, y: 40 } })),
    } as GraphDef;
    const after = saveGraph(moved);
    expect(after.version).toBe(1);
    expect(graphStore.versions(g.id)).toHaveLength(1);
  });

  it("保留原来那一版的 note——布局改动不该把它抹掉", () => {
    const g = base();
    saveGraph(g, "初版");
    saveGraph({ ...g, version: 1, nodes: g.nodes.map((n) => ({ ...n, pos: { x: 1, y: 2 } })) } as GraphDef);
    expect(graphStore.versions(g.id)[0].note).toBe("初版");
  });

  it("改了连线就照常立新版本", () => {
    const g = base();
    const v1 = saveGraph(g, "初版");
    const rewired = { ...v1, edges: [] } as GraphDef;
    expect(saveGraph(rewired, "断开").version).toBe(2);
    expect(getGraph(g.id)?.version).toBe(2);
  });

  it("改了参数也照常立新版本——参数是含义，摆位不是", () => {
    const g = base();
    const v1 = saveGraph(g, "初版");
    const tweaked = {
      ...v1,
      nodes: v1.nodes.map((n) => (n.id === "a" ? { ...n, params: { url: "y" } } : n)),
    } as GraphDef;
    expect(saveGraph(tweaked).version).toBe(2);
  });
});
