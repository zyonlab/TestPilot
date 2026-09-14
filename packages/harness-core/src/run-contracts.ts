import { z } from "zod";
import { RunModelsSchema } from "./model/profiles.js";

export const EntityIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/);
export const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const PrincipalSchema = z.object({ kind: z.enum(["human", "agent", "system"]), id: EntityIdSchema }).strict();
export type Principal = z.infer<typeof PrincipalSchema>;
export const RunBindingSchema = z.object({
  schemaVersion: z.literal(1), models: RunModelsSchema,
  skillVersion: z.string().min(1).nullable(), loadedDigest: ContentHashSchema.nullable(),
  assetDigest: ContentHashSchema.optional(),
  memoryDigest: ContentHashSchema.optional(),
  agentVersion: z.string().min(1).optional(),
  contextPolicy: z.object({ memory: z.enum(['scoped', 'off']) }).strict().optional(),
  materialsHash: ContentHashSchema.nullable(), inputHash: ContentHashSchema.nullable(),
  environmentHash: ContentHashSchema.nullable(), materialRevisions: z.array(EntityIdSchema),
}).strict();
export type RunBinding = z.infer<typeof RunBindingSchema>;
export const ArtifactKindSchema = z.enum(["material", "spec", "stories", "cases", "gate", "code", "execution", "report", "memory", "evaluation"]);
export const ArtifactRevisionSchema = z.object({
  schemaVersion: z.literal(1), id: EntityIdSchema, artifactId: EntityIdSchema, projectId: EntityIdSchema,
  runId: EntityIdSchema, name: z.string().min(1).max(160), kind: ArtifactKindSchema,
  revision: z.number().int().positive(), contentHash: ContentHashSchema,
  mediaType: z.enum(["application/json", "text/plain", "text/markdown", "text/javascript"]),
  sourceRefs: z.array(EntityIdSchema), parentRevision: EntityIdSchema.nullable(),
  createdAt: z.string().datetime(), createdBy: PrincipalSchema,
}).strict();
export type ArtifactRevision = z.infer<typeof ArtifactRevisionSchema>;
export const RunRegistrationSchema = z.object({
  id: EntityIdSchema.optional(), projectId: EntityIdSchema, externalId: EntityIdSchema,
  idempotencyKey: EntityIdSchema, binding: RunBindingSchema,
  template: z.string().min(1).max(120).default("testpilot-v1"), parentRunId: EntityIdSchema.nullable().default(null),
  parameters: z.record(z.unknown()).default({}),
}).strict();
export type RunRegistration = z.input<typeof RunRegistrationSchema>;
export const RunEventSchema = z.object({
  id: EntityIdSchema, runId: EntityIdSchema, node: EntityIdSchema,
  attempt: z.number().int().nonnegative(), sequence: z.number().int().nonnegative(),
  phase: z.enum(["queued", "running", "waiting_review", "done", "failed", "cancelled", "blocked"]),
  at: z.string().datetime(), revisionId: EntityIdSchema.optional(), message: z.string().max(2000).optional(),
}).strict();
export type RunEvent = z.infer<typeof RunEventSchema>;

/** Stable for objects, order-preserving for arrays; undefined is never evidence. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`).join(",")}}`;
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("unsupported_evidence_value");
  return json;
}
