import { expect, it } from "vitest";
import { midsceneModelConfig } from "../src/exec/model.js";
import type { RoleModelConnection } from "@testpilot/harness-core/model-profiles";
import { plannerModel } from "@testpilot/harness-core";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

it("Midscene receives an isolated executor snapshot, including its action planning intent", () => {
  const input: RoleModelConnection = { role: "executor", endpoint: "https://executor.test/v1", model: "vision", apiKey: "executor-only", thinking: false, vlMode: "qwen3-vl" };
  const config = midsceneModelConfig(input);
  input.apiKey = "changed";
  expect(config()).toMatchObject({ MIDSCENE_MODEL_NAME: "vision", MIDSCENE_OPENAI_API_KEY: "executor-only", MIDSCENE_VL_MODE: "qwen3-vl" });
  expect(() => midsceneModelConfig({ ...input, role: "planner" })).toThrow("invalid_profile (executor)");
  const second = midsceneModelConfig({ ...input, model: "another", endpoint: "https://another.test/v1" });
  expect(second().MIDSCENE_OPENAI_BASE_URL).toBe("https://another.test/v1");
  expect(config().MIDSCENE_OPENAI_BASE_URL).toBe("https://executor.test/v1");
});

it("the installed Midscene SDK and planner send concurrent HTTP requests to their own endpoints", async () => {
  // Resolve the actual transitive SDK bundled with @midscene/web, not a substitute client.
  const requireWeb = createRequire(createRequire(import.meta.url).resolve("@midscene/web"));
  const { ModelConfigManager } = requireWeb("@midscene/shared/env");
  const { callAI, AIActionType } = requireWeb("@midscene/core/ai-model");
  const requests: { role: string; key: string | undefined; model: string }[] = [];
  const servers: Server[] = [];
  async function endpoint(role: string) {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ role, key: req.headers.authorization, model: body.model });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
    servers.push(server); server.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  }
  try {
    const planning: RoleModelConnection = { role: "planner", endpoint: await endpoint("planner"), model: "reasoner", apiKey: "planner-only", thinking: null };
    const execution: RoleModelConnection = { role: "executor", endpoint: await endpoint("executor"), model: "vision", apiKey: "executor-only", thinking: null };
    const manager = new ModelConfigManager(midsceneModelConfig(execution));
    for (const intent of ["default", "VQA", "grounding", "planning"]) {
      expect(manager.getModelConfig(intent)).toMatchObject({ modelName: "vision", openaiBaseURL: execution.endpoint, openaiApiKey: "executor-only" });
    }
    await Promise.all([
      plannerModel(planning).chat({ stable: "", variable: "ok", maxTokens: 16 }),
      callAI([{ role: "user", content: "ok" }], AIActionType.TEXT, manager.getModelConfig("planning")),
    ]);
    expect(requests).toHaveLength(2);
    expect(requests.find(r => r.role === "planner")).toMatchObject({ key: "Bearer planner-only", model: "reasoner" });
    expect(requests.find(r => r.role === "executor")).toMatchObject({ key: "Bearer executor-only", model: "vision" });
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  }
});
