import type { GraphDef, GraphNode, GraphEdge } from "./graph.js";

/**
 * What changed between two versions of a graph.
 *
 * Saving a graph produces a new version and never rewrites an old one, so a run from last
 * week still names the shape it actually ran. That guarantee is only worth something if the
 * difference between then and now can be read — otherwise "v3 scored better than v1" is a
 * fact about two numbers and nothing else.
 *
 * Parameters are compared key by key rather than as whole objects, because "params changed"
 * is not an answer to "what did you change", and one threshold moving is the change this
 * project's loop is usually about.
 */

export interface ParamChange {
  nodeId: string;
  key: string;
  from?: unknown;
  to?: unknown;
}

export interface GraphDiff {
  from: { id: string; version: number };
  to: { id: string; version: number };
  nodesAdded: GraphNode[];
  nodesRemoved: GraphNode[];
  /** A node id that stayed but now runs a different node type. */
  typeChanged: Array<{ nodeId: string; from: string; to: string }>;
  paramsChanged: ParamChange[];
  edgesAdded: GraphEdge[];
  edgesRemoved: GraphEdge[];
  /** True when nothing about the shape or the settings differs. */
  identical: boolean;
}

const edgeKey = (e: GraphEdge): string => `${e.from}->${e.to}`;

function diffParams(nodeId: string, a: Record<string, unknown>, b: Record<string, unknown>): ParamChange[] {
  const out: ParamChange[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    // Structural comparison via JSON: params are plain data by contract (they are validated
    // by a zod schema before a graph is saved), so this holds and keeps the diff readable.
    const from = a[key];
    const to = b[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) out.push({ nodeId, key, from, to });
  }
  return out;
}

export function diffGraphs(from: GraphDef, to: GraphDef): GraphDiff {
  const fromNodes = new Map(from.nodes.map((n) => [n.id, n]));
  const toNodes = new Map(to.nodes.map((n) => [n.id, n]));

  const nodesAdded = to.nodes.filter((n) => !fromNodes.has(n.id));
  const nodesRemoved = from.nodes.filter((n) => !toNodes.has(n.id));

  const typeChanged: GraphDiff["typeChanged"] = [];
  const paramsChanged: ParamChange[] = [];
  for (const [id, before] of fromNodes) {
    const after = toNodes.get(id);
    if (!after) continue;
    if (before.type !== after.type) typeChanged.push({ nodeId: id, from: before.type, to: after.type });
    paramsChanged.push(...diffParams(id, (before.params ?? {}) as Record<string, unknown>, (after.params ?? {}) as Record<string, unknown>));
  }

  const fromEdges = new Set(from.edges.map(edgeKey));
  const toEdges = new Set(to.edges.map(edgeKey));
  const edgesAdded = to.edges.filter((e) => !fromEdges.has(edgeKey(e)));
  const edgesRemoved = from.edges.filter((e) => !toEdges.has(edgeKey(e)));

  return {
    from: { id: from.id, version: from.version },
    to: { id: to.id, version: to.version },
    nodesAdded,
    nodesRemoved,
    typeChanged,
    paramsChanged,
    edgesAdded,
    edgesRemoved,
    identical:
      !nodesAdded.length &&
      !nodesRemoved.length &&
      !typeChanged.length &&
      !paramsChanged.length &&
      !edgesAdded.length &&
      !edgesRemoved.length,
  };
}

/** One line per change, for a UI that has a narrow column and a person reading it quickly. */
export function describeDiff(d: GraphDiff): string[] {
  if (d.identical) return ["no change"];
  return [
    ...d.nodesAdded.map((n) => `+ node ${n.id} (${n.type})`),
    ...d.nodesRemoved.map((n) => `- node ${n.id} (${n.type})`),
    ...d.typeChanged.map((c) => `~ ${c.nodeId}: ${c.from} → ${c.to}`),
    ...d.paramsChanged.map(
      (c) => `~ ${c.nodeId}.${c.key}: ${JSON.stringify(c.from) ?? "unset"} → ${JSON.stringify(c.to) ?? "unset"}`,
    ),
    ...d.edgesAdded.map((e) => `+ edge ${e.from} → ${e.to}`),
    ...d.edgesRemoved.map((e) => `- edge ${e.from} → ${e.to}`),
  ];
}
