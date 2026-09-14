import { resolveRunModels, type RoleModelConnection } from "@testpilot/harness-core/model-profiles";
import { environmentModelProfile } from "@testpilot/harness-core";

/** Graph unit suites fake the runtime boundary; model-snapshots.test covers real persistence. */
export function captureWebModels() {
  const env = { TP_PLANNER_MODEL_NAME: "record-planner", TP_PLANNER_BASE_URL: "https://planner.test/v1", TP_PLANNER_API_KEY: "test-only",
    MIDSCENE_MODEL_NAME: "record-executor", MIDSCENE_MODEL_BASE_URL: "https://executor.test/v1", MIDSCENE_MODEL_API_KEY: "test-executor" };
  const planner: RoleModelConnection = { role: "planner", endpoint: env.TP_PLANNER_BASE_URL, model: env.TP_PLANNER_MODEL_NAME, apiKey: env.TP_PLANNER_API_KEY, thinking: null };
  const executor: RoleModelConnection = { role: "executor", endpoint: env.MIDSCENE_MODEL_BASE_URL, model: env.MIDSCENE_MODEL_NAME, apiKey: env.MIDSCENE_MODEL_API_KEY, thinking: null };
  return { planner, executor, binding: resolveRunModels({ entry: "web", mode: "pipeline", runtime: "pipeline", profiles: { environment: {
    planner: environmentModelProfile("planner", env), executor: environmentModelProfile("executor", env),
  } } }) };
}
