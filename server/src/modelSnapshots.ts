import { RunModelsSchema, requireModelConnection, resolveRunModels, type HostRuntime, type RoleModelConnection, type RunModels } from "@testpilot/harness-core/model-profiles";
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

/**
 * Web 发起、由宿主运行时（Claude Code）规划的运行。
 *
 * 规划模型是宿主自己登录的那一个，TestPilot 既不配置也看不到它，所以绑定里记成
 * `entry: "host"`、身份 `unknown`——不替它编一个模型名。这里只冻结项目的执行模型，
 * 和 `registerHostRun` 同一个形状；续跑时同一个运行拿回同一份绑定。
 */
export function captureHostWebModels(runId: string, projectId: string | undefined, runtime: HostRuntime): { binding: RunModels } {
  if (!projectId) throw new ProfileStoreError(400, "host_planner_requires_project");
  return db.transaction(() => {
    const row = db.prepare("SELECT projectId,bindingJson FROM run_model_snapshots WHERE runId=?").get(runId) as { projectId: string | null; bindingJson: string } | undefined;
    if (row) {
      if (row.projectId !== projectId) throw new ProfileStoreError(409, "run_model_scope_conflict");
      const binding = RunModelsSchema.parse(JSON.parse(row.bindingJson));
      if (binding.entry !== "host" || binding.runtime !== runtime) throw new ProfileStoreError(409, "run_model_binding_conflict");
      return { binding };
    }
    const binding = resolveRunModels({ entry: "host", mode: "skill", runtime, profiles: projectProfileLayers(projectId, "executor"),
      hostPlanner: { source: "host", role: "planner", runtime, provider: null, model: null, thinking: null, identityEvidence: "unknown" } });
    const executor = projectModelConnection(projectId, "executor");
    db.prepare("INSERT INTO run_model_snapshots (runId,projectId,bindingJson,connectionsEnc,createdAt) VALUES (?,?,?,?,?)")
      .run(runId, projectId, JSON.stringify(binding), encryptSecret(JSON.stringify({ executor })), new Date().toISOString());
    return { binding };
  })();
}

export function snapshotExecutor(runId: string, projectId?: string): RoleModelConnection {
  const row = db.prepare("SELECT projectId,bindingJson,connectionsEnc FROM run_model_snapshots WHERE runId=?").get(runId) as Row | undefined;
  if (!row) throw new ProfileStoreError(404, "run_model_snapshot_missing", "executor");
  if (row.projectId !== (projectId ?? null)) throw new ProfileStoreError(409, "run_model_scope_conflict");
  try { RunModelsSchema.parse(JSON.parse(row.bindingJson)); return requireModelConnection("executor", JSON.parse(decryptSecret(row.connectionsEnc)).executor); }
  catch { throw new ProfileStoreError(400, "run_model_snapshot_unreadable"); }
}

/**
 * 暂停中的运行换执行模型（人来做，留审计）。
 *
 * 运行把模型冻结在开始时，续跑沿用原凭据——这是对的，除非那个执行模型已经不能用了：
 * 2026-09-26 执行器模型服务额度用完，每次调用都 402，剩下的用例一条也跑不了。
 * 这里只换执行器（规划器不动），按项目当前的执行模型配置重新解析；换前换后的模型身份
 * （不含密钥）写进账本。已经验证过的用例保留原回执，回执里记着当时用的是哪个模型。
 */
export function rebindRunExecutor(runId: string, projectId: string): { before: RunModels["executor"]; after: RunModels["executor"] } {
  return db.transaction(() => {
    const row = db.prepare("SELECT projectId,bindingJson,connectionsEnc FROM run_model_snapshots WHERE runId=?").get(runId) as Row | undefined;
    if (!row) throw new ProfileStoreError(404, "run_model_snapshot_missing", "executor");
    if (row.projectId !== projectId) throw new ProfileStoreError(409, "run_model_scope_conflict");
    const binding = RunModelsSchema.parse(JSON.parse(row.bindingJson));
    const fresh = binding.entry === "host"
      ? resolveRunModels({ entry: "host", mode: binding.mode, runtime: binding.runtime as HostRuntime, profiles: projectProfileLayers(projectId, "executor"), hostPlanner: binding.planner as never })
      : resolveRunModels({ entry: "web", mode: binding.mode, runtime: binding.runtime, profiles: projectProfileLayers(projectId) });
    const connections = JSON.parse(decryptSecret(row.connectionsEnc)) as Record<string, unknown>;
    connections.executor = projectModelConnection(projectId, "executor");
    const next = RunModelsSchema.parse({ ...binding, executor: fresh.executor });
    db.prepare("UPDATE run_model_snapshots SET bindingJson=?, connectionsEnc=? WHERE runId=?").run(JSON.stringify(next), encryptSecret(JSON.stringify(connections)), runId);
    return { before: binding.executor, after: next.executor };
  })();
}
