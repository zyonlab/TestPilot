/** Dual model contract. Pure data: safe to import from the Web UI, no env/IO/keys. */
import { z } from "zod";

export const ModelRoleSchema = z.enum(["planner", "executor"]);
export type ModelRole = z.infer<typeof ModelRoleSchema>;
export const HostRuntimeSchema = z.enum(["penguin", "claude-code", "codex"]);
export type HostRuntime = z.infer<typeof HostRuntimeSchema>;
const id = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const name = z.string().trim().min(1).max(256);

/** Credentials must use secretRef; URLs in public bindings must never contain them. */
export const ModelEndpointSchema = z.string().url().refine((value) => {
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
  } catch { return false; }
}, "Use an HTTP(S) endpoint without credentials, query or fragment");

export const ModelProfileSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  version: z.number().int().positive(),
  role: ModelRoleSchema,
  provider: name,
  model: name,
  endpoint: ModelEndpointSchema,
  /** null means unauthenticated (e.g. a local model), not a fabricated default key. */
  secretRef: id.nullable(),
  thinking: z.boolean().nullable(),
  thinkBudget: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional(),
  vlMode: z.enum(["qwen-vl", "qwen3-vl", "doubao-vision", "gemini", "vlm-ui-tars", "vlm-ui-tars-doubao", "vlm-ui-tars-doubao-1.5"]).optional(),
  capabilities: z.object({
    vision: z.enum(["supported", "unsupported", "unknown"]),
    toolUse: z.enum(["supported", "unsupported", "unknown"]),
  }).strict(),
}).strict();
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/** Private server→consumer transport; never persist in artifacts or send to the Web. */
export const RoleModelConnectionSchema = ModelProfileSchema.pick({
  role: true, endpoint: true, model: true, thinking: true, timeoutMs: true, thinkBudget: true, vlMode: true,
}).extend({ apiKey: z.string() }).strict();
export type RoleModelConnection = z.infer<typeof RoleModelConnectionSchema>;

export function requireModelConnection(role: ModelRole, value: unknown): RoleModelConnection {
  const parsed = RoleModelConnectionSchema.safeParse(value);
  if (!parsed.success || parsed.data.role !== role) throw new ModelConfigError("invalid_profile", role);
  return parsed.data;
}

/** Transport DTO: apiKey is write-only and never part of a profile or run binding. */
export const ModelProfileDraftSchema = ModelProfileSchema.omit({
  schemaVersion: true, id: true, version: true, secretRef: true, role: true,
}).extend({
  expectedVersion: z.number().int().nonnegative(),
  apiKey: z.string().max(8192).optional(),
  clearCredential: z.boolean().optional(),
}).strict();
export type ModelProfileDraft = z.infer<typeof ModelProfileDraftSchema>;
export type PublicModelProfile = Omit<ModelProfile, "secretRef"> & {
  credentialState: "none" | "ok" | "undecryptable";
  origin?: "project" | "environment";
};

export const ConfiguredModelBindingSchema = z.object({
  source: z.literal("configured"),
  role: ModelRoleSchema,
  profileId: id,
  profileVersion: z.number().int().positive(),
  scope: z.enum(["run", "project", "default", "environment"]),
  provider: name,
  model: name,
  endpoint: ModelEndpointSchema,
  thinking: z.boolean().nullable(),
}).strict();
export type ConfiguredModelBinding = z.infer<typeof ConfiguredModelBindingSchema>;

export const HostPlannerBindingSchema = z.object({
  source: z.literal("host"),
  role: z.literal("planner"),
  runtime: HostRuntimeSchema,
  provider: name.nullable(),
  model: name.nullable(),
  thinking: z.boolean().nullable(),
  identityEvidence: z.enum(["unknown", "host-reported", "provider-response"]),
}).strict().superRefine((b, ctx) => {
  if ((b.identityEvidence === "unknown" && (b.model !== null || b.provider !== null)) ||
      (b.identityEvidence !== "unknown" && b.model === null)) {
    ctx.addIssue({ code: "custom", message: "Host model identity must agree with its evidence" });
  }
});
export type HostPlannerBinding = z.infer<typeof HostPlannerBindingSchema>;

export const RunModelsSchema = z.object({
  schemaVersion: z.literal(1),
  entry: z.enum(["web", "host"]),
  mode: z.enum(["skill", "pipeline"]),
  runtime: z.enum(["penguin", "claude-code", "codex", "pipeline"]),
  planner: z.union([ConfiguredModelBindingSchema, HostPlannerBindingSchema]),
  executor: ConfiguredModelBindingSchema,
}).strict().superRefine((b, ctx) => {
  const invalid = b.planner.role !== "planner" || b.executor.role !== "executor" ||
    (b.entry === "web" && b.planner.source !== "configured") ||
    (b.entry === "host" && (b.mode !== "skill" || b.planner.source !== "host" || b.planner.runtime !== b.runtime)) ||
    (b.mode === "skill" && b.runtime === "pipeline");
  if (invalid) ctx.addIssue({ code: "custom", message: "Entry, runtime and model roles do not agree" });
});
export type RunModels = z.infer<typeof RunModelsSchema>;

/** No input values in these errors: they can be returned to clients without key leakage. */
export class ModelConfigError extends Error {
  constructor(readonly code: "missing_profile" | "invalid_profile" | "invalid_binding", readonly role?: ModelRole) {
    super(`Model configuration: ${code}${role ? ` (${role})` : ""}`);
    this.name = "ModelConfigError";
  }
}

export type ProfileLayers = Partial<Record<"run" | "project" | "default" | "environment", Partial<Record<ModelRole, ModelProfile>>>>;

/** Select a whole versioned profile; never combine model/key/URL from different scopes. */
export function selectModelProfile(role: ModelRole, layers: ProfileLayers): {
  profile: ModelProfile; binding: ConfiguredModelBinding;
} {
  for (const scope of ["run", "project", "default", "environment"] as const) {
    const candidate = layers[scope]?.[role];
    if (candidate === undefined) continue;
    const parsed = ModelProfileSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.role !== role) throw new ModelConfigError("invalid_profile", role);
    const p = parsed.data;
    return { profile: p, binding: {
      source: "configured", role, scope, profileId: p.id, profileVersion: p.version,
      provider: p.provider, model: p.model, endpoint: p.endpoint, thinking: p.thinking,
    } };
  }
  throw new ModelConfigError("missing_profile", role);
}

export function resolveRunModels(input: {
  entry: RunModels["entry"]; mode: RunModels["mode"]; runtime: RunModels["runtime"];
  profiles: ProfileLayers; hostPlanner?: HostPlannerBinding;
}): RunModels {
  const planner = input.entry === "host" ? input.hostPlanner : selectModelProfile("planner", input.profiles).binding;
  if (!planner) throw new ModelConfigError("invalid_binding", "planner");
  const result = RunModelsSchema.safeParse({
    schemaVersion: 1, entry: input.entry, mode: input.mode, runtime: input.runtime,
    planner, executor: selectModelProfile("executor", input.profiles).binding,
  });
  if (!result.success) throw new ModelConfigError("invalid_binding");
  return result.data;
}

/** Read-only migration inventory. Returns presence only, never raw env or saved values. */
export function previewLegacyModelMigration(env: Record<string, string | undefined>, saved: Record<string, unknown> = {}) {
  const has = (keys: string[]) => keys.some((k) => typeof env[k] === "string" && !!env[k]?.trim());
  return {
    schemaVersion: 1 as const,
    requiresConfirmation: true as const,
    planner: { configured: false as const, requiresExplicitChoice: true as const },
    legacy: {
      endpointPresent: has(["OPENAI_BASE_URL", "MIDSCENE_MODEL_BASE_URL"]) || !!saved.baseUrl,
      modelPresent: has(["MIDSCENE_MODEL_NAME"]) || !!saved.modelName,
      credentialPresent: has(["OPENAI_API_KEY", "MIDSCENE_MODEL_API_KEY"]) || !!saved.apiKeyEnc,
      settingsPresent: has(["TP_MODEL_THINK", "TP_MODEL_TIMEOUT_MS"]) || saved.think !== undefined,
    },
    reason: "Legacy model settings were shared; choose each role explicitly before migration.",
  };
}

/** Missing old role bindings mean unknown; do not guess roles from the legacy model field. */
export function readRunModels(meta: { modelRoles?: unknown }): RunModels | null {
  if (meta.modelRoles === undefined) return null;
  const result = RunModelsSchema.safeParse(meta.modelRoles);
  if (!result.success) throw new ModelConfigError("invalid_binding");
  return result.data;
}
