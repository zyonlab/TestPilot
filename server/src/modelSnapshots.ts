import { RunModelsSchema, requireModelConnection, resolveRunModels, type RoleModelConnection, type RunModels } from "@testpilot/harness-core/model-profiles";
import { environmentModelProfile, plannerConnectionFromEnv, executorConnectionFromEnv } from "@testpilot/harness-core";
import { db } from "./db.js";
import { decryptSecret, encryptSecret } from "./vault.js";
import { projectProfileLayers, projectModelConnection, ProfileStoreError } from "./modelProfiles.js";
import type { ManagedModels } from "./runtime/managed-penguin.js";

type Row = { projectId: string | null; bindingJson: string; connectionsEnc: string };

/** Private runtime data. Only binding may be added to API responses/artifacts. */
export function readModelSnapshot(runId: string, projectId?: string): ManagedModels | undefined {
  const row = db.prepare("SELECT projectId,bindingJson,connectionsEnc FROM run_model_snapshots WHERE runId=?").get(runId) as Row | undefined;
  if (!row) return undefined;
  if (row.projectId !== (projectId ?? null)) throw new ProfileStoreError(409, "run_model_scope_conflict");
  try {
    const connections = JSON.parse(decryptSecret(row.connectionsEnc));
    return { binding: RunModelsSchema.parse(JSON.parse(row.bindingJson)), planner: requireModelConnection("planner", connections.planner), executor: requireModelConnection("executor", connections.executor) };
  } catch { throw new ProfileStoreError(400, "run_model_snapshot_unreadable"); }
}

/** Atomic capture; retries/resume with the same run retain original credentials and versions. */
export function captureWebModels(runId: string, projectId: string | undefined, runtime: RunModels["runtime"], mode: RunModels["mode"] = "pipeline"): ManagedModels {
  return db.transaction(() => {
    const existing = readModelSnapshot(runId, projectId);
    if (existing) {
      if (existing.binding.runtime !== runtime || existing.binding.mode !== mode) throw new ProfileStoreError(409, "run_model_binding_conflict");
      return existing;
    }
    const profiles = projectId ? projectProfileLayers(projectId) : { environment: { planner: environmentModelProfile("planner"), executor: environmentModelProfile("executor") } };
    const binding = resolveRunModels({ entry: "web", mode, runtime, profiles });
    const planner = projectId ? projectModelConnection(projectId, "planner") : plannerConnectionFromEnv();
    const executor = projectId ? projectModelConnection(projectId, "executor") : executorConnectionFromEnv();
    db.prepare("INSERT INTO run_model_snapshots (runId,projectId,bindingJson,connectionsEnc,createdAt) VALUES (?,?,?,?,?)")
      .run(runId, projectId ?? null, JSON.stringify(binding), encryptSecret(JSON.stringify({ planner, executor })), new Date().toISOString());
    return { binding, planner, executor };
  })();
}

export function snapshotExecutor(runId: string, projectId?: string): RoleModelConnection {
  const row = db.prepare("SELECT projectId,bindingJson,connectionsEnc FROM run_model_snapshots WHERE runId=?").get(runId) as Row | undefined;
  if (!row) throw new ProfileStoreError(404, "run_model_snapshot_missing", "executor");
  if (row.projectId !== (projectId ?? null)) throw new ProfileStoreError(409, "run_model_scope_conflict");
  try { RunModelsSchema.parse(JSON.parse(row.bindingJson)); return requireModelConnection("executor", JSON.parse(decryptSecret(row.connectionsEnc)).executor); }
  catch { throw new ProfileStoreError(400, "run_model_snapshot_unreadable"); }
}
