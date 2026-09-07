import type { NodeRegistry } from "./node.js";

export interface GraphNode {
  id: string;
  type: string;
  params?: unknown;
}

export interface GraphEdge {
  from: string;
  to: string;
}

/**
 * A graph definition. Persisted and versioned: every run pins the version it used, so
 * editing the canvas never rewrites the meaning of a result that already happened.
 */
export interface GraphDef {
  id: string;
  version: number;
  /**
   * 这张图是干什么的，一句话。
   *
   * 四张图的真正差别此前**只写在 pack.ts 的注释里**——选择器上只有 `g0-explore · v1`，
   * 而「看产品」和「读文档」会得出完全不同的东西。说明属于定义，不属于某一个前端的
   * 硬编码字符串表：换一个前端，差别不该跟着消失。
   */
  title?: string;
  description?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphIssue {
  /** Which element the problem is on, so the canvas can highlight it. */
  at: { node?: string; edge?: GraphEdge };
  message: string;
}

/**
 * Validation is the price of an editable canvas.
 *
 * "Editable" must not mean "connectable in any way at all": a graph that type-checks when
 * it is saved is a graph that cannot fail halfway through a twenty-minute run because a
 * node was handed something it never expected.
 */
export function validateGraph(def: GraphDef, registry: NodeRegistry): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const byId = new Map<string, GraphNode>();

  for (const node of def.nodes) {
    if (byId.has(node.id)) issues.push({ at: { node: node.id }, message: `duplicate node id: ${node.id}` });
    byId.set(node.id, node);
    const nodeDef = registry.get(node.type);
    if (!nodeDef) {
      issues.push({ at: { node: node.id }, message: `unknown node type: ${node.type}` });
      continue;
    }
    const params = nodeDef.params.safeParse(node.params ?? {});
    if (!params.success)
      issues.push({
        at: { node: node.id },
        message: `invalid params: ${params.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`,
      });
  }

  const inbound = new Map<string, GraphEdge[]>();
  for (const edge of def.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      issues.push({ at: { edge }, message: `edge refers to a node that does not exist` });
      continue;
    }
    inbound.set(edge.to, [...(inbound.get(edge.to) ?? []), edge]);
    const fromDef = registry.get(from.type);
    const toDef = registry.get(to.type);
    if (!fromDef || !toDef) continue;
    if (toDef.inKind === null) {
      issues.push({ at: { edge }, message: `${to.type} is a source node and takes no input` });
      continue;
    }
    if (fromDef.outKind !== toDef.inKind)
      issues.push({
        at: { edge },
        message: `${from.type} outputs "${fromDef.outKind}" but ${to.type} expects "${toDef.inKind}"`,
      });
  }

  // One input per node. Merging several upstreams is a real operation with real semantics
  // (which order? which wins?), so it belongs in an explicit merge node rather than in an
  // implicit rule nobody can see on the canvas.
  for (const [nodeId, edges] of inbound)
    if (edges.length > 1)
      issues.push({ at: { node: nodeId }, message: `${nodeId} has ${edges.length} inputs; use a merge node` });

  // A root that expects an input is not an error: the run seeds it. That is how a graph
  // can start halfway down the pipeline — stage two run on its own, for instance — and the
  // runtime still rejects a seed that does not match the node's schema.

  const cycle = findCycle(def);
  if (cycle) issues.push({ at: { node: cycle[0] }, message: `cycle: ${cycle.join(" → ")}` });

  return issues;
}

/** Execution order. Throws on a cycle — validate first. */
export function topoOrder(def: GraphDef): string[] {
  const indeg = new Map(def.nodes.map((n) => [n.id, 0]));
  const next = new Map<string, string[]>();
  for (const e of def.edges) {
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  }
  // Stable order: nodes keep the order they were declared in, so two runs of the same
  // graph produce the same sequence — reproducibility starts here.
  const queue = def.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const out: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const to of next.get(id) ?? []) {
      const d = (indeg.get(to) ?? 0) - 1;
      indeg.set(to, d);
      if (d === 0) queue.push(to);
    }
  }
  if (out.length !== def.nodes.length) throw new Error("graph has a cycle");
  return out;
}

/** Nodes reachable from `start`, including it. Used by "run from here". */
export function downstreamOf(def: GraphDef, start: string): string[] {
  const order = topoOrder(def);
  const reach = new Set([start]);
  for (const id of order)
    for (const e of def.edges) if (e.from === id && reach.has(id)) reach.add(e.to);
  return order.filter((id) => reach.has(id));
}

export function upstreamOf(def: GraphDef, target: string): string | undefined {
  return def.edges.find((e) => e.to === target)?.from;
}

function findCycle(def: GraphDef): string[] | undefined {
  const next = new Map<string, string[]>();
  for (const e of def.edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const state = new Map<string, "open" | "closed">();
  const stack: string[] = [];

  const walk = (id: string): string[] | undefined => {
    if (state.get(id) === "closed") return undefined;
    if (state.get(id) === "open") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "open");
    stack.push(id);
    for (const to of next.get(id) ?? []) {
      const found = walk(to);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "closed");
    return undefined;
  };

  for (const node of def.nodes) {
    const found = walk(node.id);
    if (found) return found;
  }
  return undefined;
}
