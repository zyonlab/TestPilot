import type { z } from "zod";
import type { Scope } from "../obs/envelope.js";
import type { Spend } from "../harness/protocol.js";

/**
 * What a node gets while it runs. Everything a node wants to tell the outside world goes
 * through here — nodes never touch the bus, the database or the process table directly,
 * which is what keeps them portable between the gateway, the agent and a test.
 */
export interface NodeContext {
  nodeId: string;
  /** Publish a fact (progress, partial output, a warning). */
  emit(kind: string, payload: unknown, scope?: Scope): void;
  /** Report cost. Attribution is per node — that is how "is this node worth it" gets answered. */
  spend(delta: Partial<Spend>): void;
  /** Cancellation: a paused or cancelled run must not leave work running. */
  signal: AbortSignal;
  /** Ablation switches in force for this run, so a node can disable part of itself. */
  ablated: ReadonlySet<string>;
}

/**
 * A node type.
 *
 * `inKind`/`outKind` are the *edge* contract: what may connect to what, checked when a
 * graph is saved. The zod schemas are the *runtime* contract, checked when the node runs.
 * Two levels because the canvas has to reject a bad connection while it is being drawn,
 * long before there is a payload to inspect.
 */
export interface NodeDef<P = unknown, I = unknown, O = unknown> {
  type: string;
  title: string;
  description?: string;
  /** null for a source node: it produces without consuming. */
  inKind: string | null;
  outKind: string;
  // The third type argument is the schema's INPUT type, which differs from its output as
  // soon as a field has a default. Nodes care about the parsed value, so it is left open.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: z.ZodType<P, z.ZodTypeDef, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: z.ZodType<I, z.ZodTypeDef, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output: z.ZodType<O, z.ZodTypeDef, any>;
  run(input: I, params: P, ctx: NodeContext): Promise<O>;
}

/**
 * A registry holds node types with different shapes, so the stored element type has to be
 * the erased one. Registration stays typed; the runtime re-checks every payload against
 * the node's own schemas anyway, which is where the real guarantee comes from.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNodeDef = NodeDef<any, any, any>;

export class NodeRegistry {
  private defs = new Map<string, AnyNodeDef>();

  register<P, I, O>(def: NodeDef<P, I, O>): this {
    if (this.defs.has(def.type)) throw new Error(`node type already registered: ${def.type}`);
    this.defs.set(def.type, def as AnyNodeDef);
    return this;
  }

  get(type: string): AnyNodeDef | undefined {
    return this.defs.get(type);
  }

  /** Everything the canvas may offer. A type that is not here cannot be placed. */
  list(): Array<{ type: string; title: string; description?: string; inKind: string | null; outKind: string }> {
    return [...this.defs.values()].map((d) => ({
      type: d.type,
      title: d.title,
      description: d.description,
      inKind: d.inKind,
      outKind: d.outKind,
    }));
  }
}
