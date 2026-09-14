import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NodeRegistry, type AnyNodeDef } from "../src/graph/node.js";
import { registerPack, registerPacks, type DomainPack } from "../src/graph/pack.js";

const node = (type: string, inKind: string | null, outKind: string): AnyNodeDef =>
  ({
    type,
    title: type,
    inKind,
    outKind,
    params: z.object({}),
    input: z.unknown(),
    output: z.unknown(),
    run: async () => ({}),
  }) as AnyNodeDef;

/**
 * The framework's own acceptance test: a pack the core has never heard of registers and
 * runs. If this needed a change in core, the claim that the core is domain-agnostic would
 * be false.
 */
const contractReview: DomainPack = {
  name: "contract-review",
  description: "A vertical this repository knows nothing about",
  nodes: [
    node("source.contract", null, "contract"),
    node("plan.clauses", "contract", "clauses"),
    node("gate.clauses", "clauses", "gated-clauses"),
  ],
  capabilities: [{ id: "ocr", kind: "other", command: "ocr-server" }],
  graphs: [{ id: "review", version: 1, nodes: [], edges: [] }],
  ablatable: ["clause-taxonomy"],
};

describe("domain packs", () => {
  it("registers a vertical the core has never heard of", () => {
    const registry = new NodeRegistry();
    const registered = registerPack(registry, contractReview);
    expect(registered).toMatchObject({
      name: "contract-review",
      nodeTypes: ["source.contract", "plan.clauses", "gate.clauses"],
      capabilities: ["ocr"],
      graphs: ["review"],
    });
    expect(registry.list()).toHaveLength(3);
    expect(registry.get("plan.clauses")?.inKind).toBe("contract");
  });

  it("refuses two packs claiming the same node type instead of letting import order decide", () => {
    const registry = new NodeRegistry();
    registerPack(registry, contractReview);
    expect(() => registerPack(registry, contractReview)).toThrow(/already registered/);
  });

  it("registers several packs side by side", () => {
    const registry = new NodeRegistry();
    const other: DomainPack = { name: "triage", nodes: [node("source.incident", null, "incident")] };
    const out = registerPacks(registry, [contractReview, other]);
    expect(out.map((p) => p.name)).toEqual(["contract-review", "triage"]);
    expect(registry.list().map((n) => n.type)).toContain("source.incident");
  });
});
