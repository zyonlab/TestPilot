import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { NativePenguinInput } from "./native-penguin.js";

/** Native host: inherit project model configuration, including credentials, in memory. */
export async function runNativeSession(input: NativePenguinInput & { sdkPath: string }, signal: AbortSignal, ready: (id: string) => void) {
  const { Agent, createAgent } = await import(pathToFileURL(input.sdkPath).href);
  const base = await createAgent({ root: input.root, projectId: input.projectId, agentId: input.agentId });
  const state = { ...base.state, systemConfig: { ...base.state.systemConfig, tools: { ...base.state.systemConfig.tools,
    mcpServers: [{ name: "testpilot", config: { transport: "stdio", command: input.nodeBin,
      args: [join(input.repoRoot, "packages/testpilot-mcp/bin/testpilot-mcp.mjs")], cwd: input.repoRoot, env: input.mcpEnv,
      connectTimeoutMs: 60_000, timeoutMs: 600_000, permission: "rw" } }],
  } } };
  const agent = new Agent(state, base.projectConfig);
  const session = await agent.createSession({ workspaceDir: input.workspace });
  try {
    writeFileSync(join(input.outDir, "host-identity.json"), JSON.stringify({ runtime: "penguin", inheritedDefaultModel: base.projectConfig.default_model ?? null, sessionId: session.sessionId }));
    ready(session.sessionId);
    for await (const event of session.run([{ timestamp: new Date().toISOString(), type: "model_msg", payload: { type: "text", role: "user", text: input.message } }],
      { signal, approve: async () => "allow" })) {
      const p = event.payload ?? {};
      appendFileSync(join(input.outDir, "host-events.jsonl"), JSON.stringify({ type: event.type, subtype: p.type, name: p.name ?? p.tool_name, stopReason: p.stop_reason }) + "\n");
      if (p.type === "request_end" && p.stop_reason === "fatal") throw new Error("native_model_request_failed");
    }
    if (signal.aborted) throw new Error("native_run_cancelled");
  } finally { await session.dispose(); }
}
if (process.send && process.env.TP_NATIVE_WORKER === "1") {
  const controller = new AbortController(); let started = false;
  process.on("disconnect", () => controller.abort()); process.on("SIGTERM", () => controller.abort());
  process.on("message", async raw => {
    const message = raw as NativePenguinInput & { type: string; sdkPath: string };
    if (message.type === "cancel") { controller.abort(); return; }
    if (message.type !== "start" || started) return;
    started = true;
    try { await runNativeSession(message, controller.signal, id => process.send?.({ type: "ready", sessionId: id })); process.exitCode = 0; }
    catch { writeFileSync(join(message.outDir, "runtime-error.json"), JSON.stringify({ code: controller.signal.aborted ? "native_run_cancelled" : "native_runtime_failed" })); process.exitCode = 1; }
    finally { process.disconnect?.(); }
  });
}
