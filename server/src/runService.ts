import { bindDomainReference } from "./domainReferences.js";
import { bindCurrentRulePack } from "./rulePacks.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { RunModelsSchema, HostRuntimeSchema, resolveRunModels, type RunModels } from "@testpilot/harness-core/model-profiles";
import { canonicalJSON, type RunBinding, type ArtifactRevision } from "@testpilot/harness-core/run-contracts";
import { RunLedger, LedgerError, contentHash } from "./runLedger.js";
import { dataPath } from "./datadir.js";
import { readActiveEvolution } from './evolution/bridge.js';
import { db, getProject } from "./db.js";
import { projectProfileLayers, projectModelConnection } from "./modelProfiles.js";
import { encryptSecret, decryptSecret } from "./vault.js";
import type { Envelope } from "@testpilot/harness-core";

let ledger: RunLedger | undefined;
export function runLedger() { return ledger ??= new RunLedger(dataPath("workflows.db"), dataPath("revision-blobs")); }
const repoRoot = resolve(import.meta.dirname, "../..");
export function skillBinding() {
  const root = join(repoRoot, "plugins/testpilot");
  const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
  const files: Array<{ path: string; hash: string }> = [];
  const walk = (dir: string, prefix: string) => { for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
    else if (e.name.endsWith(".md")) files.push({ path: `${prefix}${e.name}`, hash: contentHash(readFileSync(join(dir, e.name))) });
  } };
  walk(join(root, "skills"), "skills/");
  return { skillVersion: String(manifest.skillVersions?.["testpilot-run-c"] ?? manifest.version), loadedDigest: contentHash(canonicalJSON(files)), files };
}
export function emptyRunBinding(models: RunModels): RunBinding {
  const skills = skillBinding();
  const active = readActiveEvolution();
  return { schemaVersion: 1, models: RunModelsSchema.parse(models), skillVersion: skills.skillVersion, loadedDigest: null, assetDigest: skills.loadedDigest,
    agentVersion: active.version, contextPolicy: active.policy,
    materialsHash: null, inputHash: null, environmentHash: null, materialRevisions: [] };
}
export function assertProject(projectId: string) { if (!getProject(projectId)) throw new LedgerError(404, "project_missing"); }
function grant(runId: string) {
  db.exec("CREATE TABLE IF NOT EXISTS run_write_grants (runId TEXT PRIMARY KEY, tokenHash TEXT NOT NULL, tokenEnc TEXT NOT NULL)");
  const existing = db.prepare("SELECT tokenEnc FROM run_write_grants WHERE runId=?").get(runId) as { tokenEnc: string } | undefined;
  if (existing) return decryptSecret(existing.tokenEnc);
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO run_write_grants VALUES (?,?,?)").run(runId, contentHash(token), encryptSecret(token));
  return token;
}
/** Internal adapter capability; never returned by public run reads or model tools. */
export function adapterRunGrant(runId: string, projectId: string) { runLedger().requireRun(runId, projectId); return grant(runId); }
export function authorizeRun(runId: string, token: unknown) {
  if (typeof token !== "string" || token.length !== 64) throw new LedgerError(401, "run_credential_required");
  db.exec("CREATE TABLE IF NOT EXISTS run_write_grants (runId TEXT PRIMARY KEY, tokenHash TEXT NOT NULL, tokenEnc TEXT NOT NULL)");
  if (!db.prepare("SELECT runId FROM run_write_grants WHERE runId=? AND tokenHash=?").get(runId, contentHash(token))) throw new LedgerError(403, "run_credential_invalid");
}
export interface HostRegisterInput {
  externalId: string; idempotencyKey: string; runtime: "penguin" | "claude-code" | "codex";
  model?: string; provider?: string; parameters?: Record<string, unknown>;
  materials: Array<{ name: string; text: string }>;
}
export function registerHostRun(projectId: string, input: HostRegisterInput, reservedRunId?: string) {
  assertProject(projectId); const runtime = HostRuntimeSchema.parse(input.runtime);
  return runLedger().db.transaction(() => {
  if (!input.materials?.length || input.materials.some(m => typeof m.text !== "string" || typeof m.name !== "string")) throw new LedgerError(400, "materials_required");
  const requestDigest = contentHash(canonicalJSON(input));
  const prior = runLedger().db.prepare("SELECT runId,inputJson FROM wf_run_registrations WHERE projectId=? AND idempotencyKey=?").get(projectId, input.idempotencyKey) as { runId: string; inputJson: string } | undefined;
  if (prior) {
    if (JSON.parse(prior.inputJson).parameters.requestDigest !== requestDigest) throw new LedgerError(409, "run_registration_conflict");
    return { runId: prior.runId, created: false, writeToken: grant(prior.runId), run: runLedger().getRun(prior.runId, projectId) };
  }
  const binding = emptyRunBinding(resolveRunModels({ entry: "host", mode: "skill", runtime, profiles: projectProfileLayers(projectId, "executor"),
    hostPlanner: { source: "host", role: "planner", runtime, provider: input.model ? input.provider ?? null : null,
      model: input.model ?? null, thinking: null, identityEvidence: input.model ? "host-reported" : "unknown" } }));
  const registered = runLedger().register({ ...(reservedRunId ? { id: reservedRunId } : {}), projectId, externalId: input.externalId, idempotencyKey: input.idempotencyKey, binding,
    parameters: { ...(input.parameters ?? {}), targetUrl: getProject(projectId)!.targetUrl, requestDigest } }, { kind: "agent", id: runtime });
  const executor = projectModelConnection(projectId, "executor");
  db.prepare("INSERT OR IGNORE INTO run_model_snapshots (runId,projectId,bindingJson,connectionsEnc,createdAt) VALUES (?,?,?,?,?)")
    .run(registered.runId, projectId, canonicalJSON(binding.models), encryptSecret(JSON.stringify({ executor })), new Date().toISOString());
  const revisions = input.materials.map(m => runLedger().putRevision({ projectId, runId: registered.runId, name: m.name, kind: "material", content: m.text, mediaType: "text/markdown" }, { kind: "agent", id: runtime }));
  runLedger().sealInputs(registered.runId, projectId, revisions.map(r => r.id));
  // 领域参考：项目当前那一版冻结绑定进这次运行（宿主登记的运行和 Web 建的一个待遇）。
  bindDomainReference(registered.runId, projectId);
  bindCurrentRulePack(registered.runId, projectId, { kind: "agent", id: runtime });
  return { ...registered, writeToken: grant(registered.runId), run: runLedger().getRun(registered.runId, projectId) };
  })();
}
export function registerWebRun(runId: string, projectId: string, models: RunModels, parameters: Record<string, unknown> = {}) {
  if (runLedger().registration(runId, projectId)) return runLedger().getRun(runId, projectId);
  runLedger().register({ id: runId, projectId, externalId: runId, idempotencyKey: runId, binding: emptyRunBinding(models), parameters: { ...parameters, targetUrl: getProject(projectId)!.targetUrl } }, { kind: "system", id: "web" });
  return runLedger().getRun(runId, projectId);
}
export function freezeRunMaterials(runId: string, projectId: string, directory: string): string {
  const run = runLedger().requireRun(runId, projectId);
  let revisions: ArtifactRevision[];
  if (run.binding.materialsHash) revisions = run.binding.materialRevisions.map(id => runLedger().readRevision(id, projectId).revision);
  else {
    const files: Array<{ name: string; text: string }> = [];
    const walk = (dir: string, prefix = "") => { for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (/\.(md|txt)$/.test(entry.name)) files.push({ name: `${prefix}${entry.name}`, text: readFileSync(join(dir, entry.name), "utf8") });
    } };
    walk(directory);
    const generated=runLedger().listRevisions(projectId,runId).filter(r=>r.name==='exploration.md'&&r.kind==='material'&&r.createdBy.kind==='system'&&r.createdBy.id==='explorer').sort((a,b)=>b.revision-a.revision)[0];
    revisions = files.map(f => {
      if(f.name==='exploration.md'&&generated){
        // The generator bound exact bytes, not a later file that happens to share its name.
        if(contentHash(f.text)!==generated.contentHash)throw new LedgerError(409,'exploration_material_changed');
        return runLedger().readRevision(generated.id,projectId).revision;
      }
      return runLedger().putRevision({runId,projectId,name:f.name,kind:'material',content:f.text,mediaType:'text/markdown'},{kind:'system',id:'web'});
    });
    runLedger().sealInputs(runId, projectId, revisions.map(r => r.id));
  }
  return materializeInputs(runId, projectId, revisions);
}
export function materializeInputs(runId: string, projectId: string, revisions?: ArtifactRevision[]) {
  const run = runLedger().requireRun(runId, projectId);
  const selected = revisions ?? run.binding.materialRevisions.map(id => runLedger().readRevision(id, projectId).revision);
  const directory = dataPath(`inputs/${runId}`); mkdirSync(directory, { recursive: true });
  for (const r of selected) {
    const { content } = runLedger().readRevision(r.id, projectId);
    const path = join(directory, `${r.contentHash}.md`);
    if (!existsSync(path)) writeFileSync(path, typeof content === "string" ? content : canonicalJSON(content), { mode: 0o444, flag: "wx" });
    if (contentHash(readFileSync(path)) !== r.contentHash) throw new LedgerError(409, "material_view_changed");
  }
  return directory;
}

export function freezeGraphSources(runId: string, projectId: string, nodes: Array<{ id: string; type: string; params?: unknown }>, baseDir: string) {
  const run = runLedger().requireRun(runId, projectId);
  const all: ArtifactRevision[] = [];
  for (const node of nodes) {
    if (node.type !== "source.spec") continue;
    const params = (node.params ?? {}) as { paths?: string[]; path?: string; text?: string };
    const prior = run.binding.materialRevisions.map(id => runLedger().readRevision(id, projectId).revision).filter(r => r.name.startsWith(`${node.id}:`));
    const revisions = run.binding.materialsHash ? prior : (typeof params.text === "string"
      ? [{ name: `${node.id}:inline`, text: params.text }]
      : (params.paths ?? (params.path ? [params.path] : [])).map(path => ({ name: `${node.id}:${path}`, text: readFileSync(resolve(baseDir, path), "utf8") })))
      .map(m => runLedger().putRevision({ runId, projectId, name: m.name, kind: "material", content: m.text, mediaType: "text/markdown" }, { kind: "system", id: "web" }));
    all.push(...revisions);
    if (revisions.length) {
      const directory = materializeInputs(runId, projectId, revisions);
      node.params = { ...params, text: undefined, path: undefined, paths: revisions.map(r => join(directory, `${r.contentHash}.md`)) };
    }
  }
  if (all.length) runLedger().sealInputs(runId, projectId, all.map(r => r.id));
}

/** Existing bus facts project into the same node timeline as host API facts. */
export async function projectWorkflowEvent(event: Envelope) {
  const runId = event.scope.wfRunId;
  if (!runId || !["wf.node.started", "wf.node.finished", "wf.run.finished"].includes(event.kind)) return;
  const registered = runLedger().registration(runId);
  if (!registered || registered.input.parameters?.stageControlVersion === 1) return;
  const payload = event.payload as { nodeId?: string; status?: string; error?: string };
  if (event.kind !== "wf.run.finished" && payload.nodeId) {
    const phase = event.kind === "wf.node.started" ? "running" : payload.status === "failed" ? "failed" : payload.status === "cancelled" ? "cancelled" : "done";
    runLedger().appendEvent({ id: `bus-${event.id}-${contentHash(canonicalJSON(event)).slice(0, 16)}`, runId, node: payload.nodeId,
      attempt: 0, sequence: event.id, phase, at: event.ts,
      ...(typeof payload.error === "string" ? { message: payload.error.slice(0, 2000) } : {}) }, registered.projectId);
  }
  if (event.kind !== "wf.node.started") await captureRunOutputs(runId, registered.projectId);
}
export async function captureRunOutputs(runId: string, projectId: string) {
  const registered = runLedger().requireRun(runId, projectId);
  const outputs = await runLedger().outputs.all(runId);
  const kinds: Record<string, ArtifactRevision["kind"]> = { docs: "material", spec: "spec", stories: "stories", design: "cases", gate: "gate", code: "code", run: "execution" };
  for (const [name, content] of Object.entries(outputs)) {
    const prior = runLedger().listRevisions(projectId, runId).filter(r => r.name === name && r.kind === (kinds[name] ?? "report")).at(-1);
    runLedger().putRevision({ runId, projectId, name, kind: kinds[name] ?? "report", content,
      sourceRefs: registered.binding.materialRevisions, parentRevision: prior?.id }, { kind: "system", id: "runtime" });
  }
}
export async function recoverRunProjections() {
  runLedger().rebuild();
  const runs = runLedger().db.prepare("SELECT runId,projectId FROM wf_run_registrations").all() as Array<{ runId: string; projectId: string }>;
  for (const r of runs) {
    try {
      for (const revision of runLedger().listRevisions(r.projectId, r.runId)) runLedger().readRevision(revision.id, r.projectId);
      await captureRunOutputs(r.runId, r.projectId);
    } catch { runLedger().db.prepare("UPDATE wf_runs SET status='blocked' WHERE id=?").run(r.runId); }
  }
  if (runLedger().db.prepare("SELECT name FROM sqlite_master WHERE name='workflow_start_requests'").get())
    runLedger().db.prepare("DELETE FROM workflow_start_requests WHERE runId NOT IN (SELECT runId FROM wf_run_registrations)").run();
}
