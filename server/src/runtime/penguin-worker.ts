import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openRoleProxy, type RoleRequestRecord } from "@testpilot/harness-core";
import { RunModelsSchema, requireModelConnection } from "@testpilot/harness-core/model-profiles";
import type { ManagedPenguinInput } from "./managed-penguin.js";

/** Exported for an installed-SDK integration test; uses public Agent/session APIs only. */
export async function runManagedSession(input: ManagedPenguinInput & { sdkPath: string }, signal: AbortSignal, ready: (sessionId: string) => void) {
  const binding = RunModelsSchema.parse(input.models.binding);
  const originalPlanner = requireModelConnection("planner", input.models.planner);
  const originalExecutor = requireModelConnection("executor", input.models.executor);
  const record = (r: RoleRequestRecord) => { appendFileSync(join(input.outDir, "model-requests.jsonl"), JSON.stringify({ at: new Date().toISOString(), runId: input.runId, ...r }) + "\n"); process.send?.({ type: "model-request", record: r }); };
  const budget = input.budget ?? { plannerCalls: 100, executorCalls: 100, wallMs: 600_000 };
  const deadlineAt = Date.now() + budget.wallMs;
  const planner = await openRoleProxy(originalPlanner, record, { maxCalls: budget.plannerCalls, deadlineAt });
  let executor: Awaited<ReturnType<typeof openRoleProxy>> | undefined;
  let session: { sessionId: string; run: Function; dispose: Function } | undefined;
  try {
    executor = await openRoleProxy(originalExecutor, record, { maxCalls: budget.executorCalls, deadlineAt });
    const { Agent, createAgent } = await import(pathToFileURL(input.sdkPath).href);
    if (typeof Agent !== "function" || typeof createAgent !== "function") throw new Error("unsupported_penguin_sdk");
    const base = await createAgent({ root: input.root, projectId: input.projectId, agentId: input.agentId });
    const p = planner.connection, e = executor.connection;
    const env = {
      ...input.mcpEnv,
      TP_PLANNER_MODEL_NAME: p.model, TP_PLANNER_BASE_URL: p.endpoint, TP_PLANNER_API_KEY: p.apiKey,
      TP_PLANNER_THINK: p.thinking === null ? "" : p.thinking ? "1" : "0",
      TP_PLANNER_TIMEOUT_MS: String(p.timeoutMs ?? 900_000), TP_PLANNER_THINK_BUDGET: String(p.thinkBudget ?? 0),
      MIDSCENE_MODEL_NAME: e.model, MIDSCENE_MODEL_BASE_URL: e.endpoint, MIDSCENE_MODEL_API_KEY: e.apiKey,
      MIDSCENE_VL_MODE: e.vlMode ?? "", MIDSCENE_USE_QWEN3_VL: "0", MIDSCENE_USE_QWEN_VL: "0",
      TP_MODEL_THINK: e.thinking === null ? "" : e.thinking ? "1" : "0", TP_MODEL_TIMEOUT_MS: String(e.timeoutMs ?? 900_000),
      TP_RUN_MODELS_JSON: JSON.stringify(binding), TP_MODEL_RUN_ID: input.runId,
    };
    // Whole per-session copies. No addModel/saveProjectConfig or mutation of host defaults.
    const state = { ...base.state, systemConfig: { ...base.state.systemConfig, tools: { ...base.state.systemConfig.tools,
      mcpServers: [{ name: "testpilot", config: { transport: "stdio", command: input.nodeBin,
        args: [join(input.mcpEnv.TP_REPO_ROOT, "packages/testpilot-mcp/bin/testpilot-mcp.mjs")],
        cwd: join(input.mcpEnv.TP_REPO_ROOT, "packages/testpilot-mcp"), env,
        connectTimeoutMs: 60_000, timeoutMs: 3600_000, permission: "rw" } }],
    } } };
    const model = { provider: "testpilot", model_id: p.model, client_type: "openai-chat", base_url: p.endpoint, api_key: p.apiKey };
    const config = { ...base.projectConfig, models: [model], default_model: { provider: model.provider, model_id: model.model_id }, vision_model: undefined };
    const agent = new Agent(state, config);
    session = await agent.createSession({ workspaceDir: input.workspace, provider: model.provider, modelId: p.model,
      apiKey: p.apiKey, baseUrl: p.endpoint, thinkingLevel: p.thinking ? "medium" : null });
    writeFileSync(join(input.outDir, "model-binding.json"), JSON.stringify(binding, null, 2));
    ready(session!.sessionId);
    writeFileSync(join(input.outDir, "run-budget.json"), JSON.stringify({ ...budget, deadlineAt }));
    const messages = [{ timestamp: new Date().toISOString(), type: "model_msg", payload: { type: "text", role: "user", text: input.message } }];
    const deadline = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
    const sessionSignal = AbortSignal.any([signal, deadline]);
    for await (const event of session!.run(messages, { signal: sessionSignal, approve: async () => "allow" })) {
      // SDK writes its own full trace. This file is deliberately metadata only.
      if (event.type === "event_msg" && event.payload?.type === "request_end" && event.payload?.stop_reason === "fatal") throw new Error("managed_model_request_failed");
    }
    if (sessionSignal.aborted) throw new Error("managed_run_cancelled");
  } finally {
    try { await session?.dispose(); } finally { await executor?.close(); await planner.close(); }
  }
}

if (process.send && process.env.TP_MANAGED_WORKER === "1") {
  let started = false; const controller = new AbortController();
  process.on("disconnect", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  process.on("message", async raw => {
    const message = raw as ManagedPenguinInput & { type: string; sdkPath: string };
    if (message.type === "cancel") { controller.abort(); return; }
    if (message.type !== "start" || started) return;
    started = true;
    try {
      await runManagedSession(message, controller.signal, sessionId => process.send?.({ type: "ready", sessionId }));
      process.exitCode = 0;
    } catch {
      writeFileSync(join(message.outDir, "runtime-error.json"), JSON.stringify({ code: controller.signal.aborted ? "managed_run_cancelled" : "managed_runtime_failed" }));
      process.exitCode = 1;
    } finally { process.disconnect?.(); }
  });
}
