import type { CapabilityRecipe } from "../config/types.js";
import type { AnyNodeDef, NodeRegistry } from "./node.js";

/**
 * A domain pack: everything one vertical adds to the harness.
 *
 * This is the only extension point. The core knows about nodes, graphs, events, budgets and
 * evaluation; it does not know what a test case is, and the litmus test for that claim is
 * that a second pack — contract review, incident triage, whatever — can be registered here
 * without the core changing at all.
 *
 * Registration is one call rather than a hand-written loop in the host, because "what does
 * this vertical contribute" should have one answer you can read, not a sequence of imports
 * spread across a server file.
 */
export interface DomainPack {
  name: string;
  description?: string;
  nodes: AnyNodeDef[];
  /** External services the pack needs (a chain, a mock server, a device bridge). */
  capabilities?: CapabilityRecipe[];
  /** Graphs the pack ships ready to run. */
  graphs?: Array<{ id: string; version: number; nodes: unknown[]; edges: unknown[] }>;
  /** Names of things the pack lets an ablation switch off, for the report to list. */
  ablatable?: string[];
}

export interface RegisteredPack {
  name: string;
  nodeTypes: string[];
  capabilities: string[];
  graphs: string[];
}

/**
 * Register a pack's nodes into a registry.
 *
 * A duplicate node type is an error rather than a silent overwrite: two packs quietly
 * claiming `design.cases` would make which one runs depend on import order.
 */
export function registerPack(registry: NodeRegistry, pack: DomainPack): RegisteredPack {
  for (const node of pack.nodes) registry.register(node);
  return {
    name: pack.name,
    nodeTypes: pack.nodes.map((n) => n.type),
    capabilities: (pack.capabilities ?? []).map((c) => c.id),
    graphs: (pack.graphs ?? []).map((g) => g.id),
  };
}

/** Register several packs, reporting what each contributed. */
export function registerPacks(registry: NodeRegistry, packs: DomainPack[]): RegisteredPack[] {
  return packs.map((p) => registerPack(registry, p));
}
