import {ModelConfigError,requireModelConnection,type RoleModelConnection} from "./profiles.js";
/** Explicit names only. Legacy shared/Midscene env never supplies a planner. */
export function plannerConnectionFromEnv(env: Record<string, string | undefined> = process.env): RoleModelConnection {
  if (!env.TP_PLANNER_MODEL_NAME?.trim() || !env.TP_PLANNER_BASE_URL?.trim())
    throw new ModelConfigError("missing_profile", "planner");
  return requireModelConnection("planner", {
    role: "planner", model: env.TP_PLANNER_MODEL_NAME.trim(), endpoint: env.TP_PLANNER_BASE_URL.trim(),
    apiKey: env.TP_PLANNER_API_KEY ?? "", thinking: env.TP_PLANNER_THINK === "0" ? false : env.TP_PLANNER_THINK === "1" ? true : null,
    ...(env.TP_PLANNER_TIMEOUT_MS ? { timeoutMs: Number(env.TP_PLANNER_TIMEOUT_MS) } : {}),
    ...(env.TP_PLANNER_THINK_BUDGET ? { thinkBudget: Number(env.TP_PLANNER_THINK_BUDGET) } : {}),
  });
}

export function executorConnectionFromEnv(env: Record<string, string | undefined> = process.env): RoleModelConnection {
  if (!env.MIDSCENE_MODEL_NAME?.trim()) throw new ModelConfigError("missing_profile", "executor");
  return requireModelConnection("executor", {
    role: "executor", model: env.MIDSCENE_MODEL_NAME.trim(),
    endpoint: env.MIDSCENE_MODEL_BASE_URL ?? env.MIDSCENE_OPENAI_BASE_URL ?? env.OPENAI_BASE_URL,
    apiKey: env.MIDSCENE_MODEL_API_KEY ?? env.MIDSCENE_OPENAI_API_KEY ?? env.OPENAI_API_KEY ?? "",
    thinking: env.TP_MODEL_THINK === "0" ? false : env.TP_MODEL_THINK === "1" ? true : null,
    ...(env.TP_MODEL_TIMEOUT_MS ? { timeoutMs: Number(env.TP_MODEL_TIMEOUT_MS) } : {}),
    ...(env.MIDSCENE_VL_MODE ? { vlMode: env.MIDSCENE_VL_MODE } : env.MIDSCENE_USE_QWEN3_VL === "1" ? { vlMode: "qwen3-vl" } : env.MIDSCENE_USE_QWEN_VL === "1" ? { vlMode: "qwen-vl" } : {}),
  });
}

