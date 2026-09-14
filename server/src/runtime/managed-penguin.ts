import { recordModelRequests } from '../roleSpend.js';
import type { RoleRequestRecord } from '@testpilot/harness-core';
import type { RunBudget } from "../runBudget.js";
import { configuredRunBudget } from "../runBudget.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunModelsSchema, requireModelConnection, type RoleModelConnection, type RunModels } from "@testpilot/harness-core/model-profiles";

export interface ManagedModels {
  binding: RunModels;
  planner: RoleModelConnection;
  executor: RoleModelConnection;
}
export interface ManagedPenguinInput {
  runId: string; projectId: string; agentId: string; root: string;
  workspace: string; outDir: string; message: string;
  nodeBin: string; penguinBin: string;
  mcpEnv: Record<string, string>;
  models: ManagedModels;
  budget?: RunBudget;
}
type Live = { child: ChildProcess; state: "running" | "idle" | "gone" };
const live = new Map<string, Live>();

/** Penguin core is import-only; require.resolve cannot select its ESM export. */
export function sdkEntry(binary: string): string {
  const paths = createRequire(realpathSync(binary)).resolve.paths("@prismshadow/penguin-core") ?? [];
  for (const base of paths) {
    const root = join(base, "@prismshadow/penguin-core"), manifest = join(root, "package.json");
    if (!existsSync(manifest)) continue;
    const entry = JSON.parse(readFileSync(manifest, "utf8")).exports?.["."]?.import;
    if (typeof entry === "string" && entry.startsWith("./")) return resolve(root, entry);
  }
  throw new Error("penguin_sdk_not_found");
}

export function managedRunState(runId: string) { return live.get(runId)?.state; }
export function cancelManagedRun(runId: string): boolean {
  const item = live.get(runId);
  if (!item || item.state !== "running") return false;
  item.child.send?.({ type: "cancel" });
  const timer = setTimeout(() => { if (item.state === "running") item.child.kill("SIGKILL"); }, 5000); timer.unref();
  return true;
}

/** Node 24 SDK worker: credentials travel over private IPC, never argv, YAML or stdout. */
export async function launchManagedPenguin(input: ManagedPenguinInput): Promise<{ sessionId: string }> {
  if (live.get(input.runId)?.state === "running") throw new Error("managed_run_already_active");
  const models = { binding: RunModelsSchema.parse(input.models.binding), planner: requireModelConnection("planner", input.models.planner), executor: requireModelConnection("executor", input.models.executor) };
  if (models.binding.entry !== "web" || models.binding.runtime !== "penguin") throw new Error("managed_model_binding_conflict");
  for (const role of ["planner", "executor"] as const) {
    const binding = models.binding[role], connection = models[role];
    if (binding.source !== "configured" || binding.model !== connection.model || binding.endpoint !== connection.endpoint || binding.thinking !== connection.thinking)
      throw new Error("managed_model_binding_conflict");
  }
  const sdkPath = sdkEntry(input.penguinBin);
  const worker = fileURLToPath(new URL("./penguin-worker.ts", import.meta.url));
  const env = { ...process.env };
  env.TP_MANAGED_WORKER = "1";
  // The worker gets the two captured roles explicitly, not ambient host credentials.
  for (const key of Object.keys(env)) if (/^(TP_PLANNER_|MIDSCENE_|OPENAI_|ANTHROPIC_)/.test(key)) delete env[key];
  const child = spawn(input.nodeBin, ["--import", "tsx", worker], { cwd: fileURLToPath(new URL("../..", import.meta.url)), env, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const item: Live = { child, state: "running" }; live.set(input.runId, item);
  return new Promise((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("managed_runtime_start_timeout")); }, 60_000); timer.unref();
    child.on("message", (raw) => {
      const event = raw as { type?: string; sessionId?: string; record?: RoleRequestRecord };
      if (event.type === "model-request" && event.record) { try { recordModelRequests(input.runId, [event.record]); } catch { child.kill("SIGTERM"); } }
      if (event.type === "ready" && typeof event.sessionId === "string") { ready = true; clearTimeout(timer); resolve({ sessionId: event.sessionId }); }
    });
    child.on("error", () => { clearTimeout(timer); item.state = "gone"; if (!ready) reject(new Error("managed_runtime_spawn_failed")); });
    child.on("exit", (code) => {
      clearTimeout(timer); item.state = code === 0 ? "idle" : "gone";
      if (!ready) reject(new Error("managed_runtime_initialization_failed"));
      const forget = setTimeout(() => { if (live.get(input.runId) === item) live.delete(input.runId); }, 120_000); forget.unref();
    });
    child.send({ type: "start", ...input, budget: input.budget ?? configuredRunBudget(), models, sdkPath }, error => { if (error) { child.kill(); reject(new Error("managed_runtime_ipc_failed")); } });
  });
}
