import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/** Read local role settings without copying keys into .mcp.json or host agent YAML. */
export function loadModelEnv(path, env = process.env) {
  const values = parseEnv(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (/^(TP_PLANNER_|MIDSCENE_)/.test(key) || ["TP_MODEL_THINK", "TP_MODEL_TIMEOUT_MS", "TP_JUDGE_MODEL"].includes(key)) {
      if (env[key] === undefined) env[key] = value;
    }
  }
  // Legacy executor aliases are read from this file, never from a host's ambient key.
  if (env.MIDSCENE_MODEL_BASE_URL === undefined && env.MIDSCENE_OPENAI_BASE_URL === undefined)
    env.MIDSCENE_MODEL_BASE_URL = values.OPENAI_BASE_URL ?? "";
  if (env.MIDSCENE_MODEL_API_KEY === undefined && env.MIDSCENE_OPENAI_API_KEY === undefined)
    env.MIDSCENE_MODEL_API_KEY = values.OPENAI_API_KEY ?? "";
}
