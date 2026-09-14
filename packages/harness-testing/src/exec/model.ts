import { requireModelConnection, type RoleModelConnection } from "@testpilot/harness-core/model-profiles";

/** Midscene's internal `planning` intent is action planning, still the executor role. */
export function midsceneModelConfig(connection: RoleModelConnection) {
  const c = requireModelConnection("executor", connection);
  const config = {
    MIDSCENE_MODEL_NAME: c.model,
    MIDSCENE_OPENAI_BASE_URL: c.endpoint,
    MIDSCENE_OPENAI_API_KEY: c.apiKey,
    ...(c.vlMode ? { MIDSCENE_VL_MODE: c.vlMode } : {}),
    ...(c.timeoutMs ? { MIDSCENE_OPENAI_INIT_CONFIG_JSON: JSON.stringify({ timeout: c.timeoutMs }) } : {}),
  };
  return () => ({ ...config });
}
