import {plannerConnectionFromEnv,executorConnectionFromEnv} from './connections-env.js';
export {plannerConnectionFromEnv,executorConnectionFromEnv} from './connections-env.js';
import { createHash } from "node:crypto";
import { ModelProfileSchema, requireModelConnection, type ModelRole, type ModelProfile, type RoleModelConnection } from "./profiles.js";
import { OpenAIModel } from "./openai.js";

export function plannerModel(connection: RoleModelConnection): OpenAIModel {
  const c = requireModelConnection("planner", connection);
  return new OpenAIModel({ baseUrl: c.endpoint, apiKey: c.apiKey, model: c.model,
    noThink: c.thinking === false, providerThinkingDefault: c.thinking === null,
    timeoutMs: c.timeoutMs, thinkBudget: c.thinkBudget });
}

/** Optional evaluation model name still uses planner transport, never executor credentials. */
export function evaluationPlannerModel(env: Record<string, string | undefined> = process.env): OpenAIModel {
  const c = plannerConnectionFromEnv(env);
  return plannerModel({ ...c, model: env.TP_JUDGE_MODEL?.trim() || c.model });
}

/** Non-secret settings fingerprint identifies env changes; no hidden saved-key fallback. */
export function environmentModelProfile(role: ModelRole, env: Record<string, string | undefined> = process.env): ModelProfile | undefined {
  if (!(role === "planner" ? env.TP_PLANNER_MODEL_NAME : env.MIDSCENE_MODEL_NAME)?.trim()) return undefined;
  const { apiKey, ...c } = role === "planner" ? plannerConnectionFromEnv(env) : executorConnectionFromEnv(env);
  const fingerprint = createHash("sha256").update(JSON.stringify(c)).digest("hex").slice(0, 16);
  return ModelProfileSchema.parse({ ...c, schemaVersion: 1, id: `env:${role}:${fingerprint}`, version: 1,
    provider: "openai-compatible", secretRef: apiKey ? `env:${role}` : null,
    capabilities: { vision: "unknown", toolUse: "unknown" } });
}
