import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, linkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteOutputStore } from "@testpilot/harness-core";
import { ArtifactRevisionSchema, RunBindingSchema, RunEventSchema, RunRegistrationSchema, PrincipalSchema, canonicalJSON,
  type ArtifactRevision, type Principal, type RunEvent, type RunRegistration } from "@testpilot/harness-core/run-contracts";

export class LedgerError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const contentHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type RegistrationRow = { runId: string; projectId: string; requestHash: string; bindingJson: string; inputJson: string };
type RevisionRow = { id: string; projectId: string; runId: string; artifactId: string; revision: number; json: string };
export interface RevisionInput {
  projectId: string; runId: string; name: string; kind: ArtifactRevision["kind"]; content: unknown;
  mediaType?: ArtifactRevision["mediaType"]; sourceRefs?: string[]; parentRevision?: string | null;
}

/** New facts and existing workflow projections share one transaction and one database. */
export class RunLedger {
  readonly db: Database.Database;
  readonly outputs: SqliteOutputStore;
  constructor(path: string, private blobRoot: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    mkdirSync(blobRoot, { recursive: true });
    this.db = new Database(path); this.db.pragma("journal_mode = WAL"); this.db.pragma("foreign_keys = ON");
    this.outputs = new SqliteOutputStore(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wf_run_registrations (
        runId TEXT PRIMARY KEY REFERENCES wf_runs(id), projectId TEXT NOT NULL,
        externalId TEXT NOT NULL, runtime TEXT NOT NULL, entry TEXT NOT NULL,
        idempotencyKey TEXT NOT NULL, requestHash TEXT NOT NULL, bindingJson TEXT NOT NULL, inputJson TEXT NOT NULL,
        UNIQUE(projectId,idempotencyKey), UNIQUE(projectId,entry,runtime,externalId)
      );
      CREATE TABLE IF NOT EXISTS artifact_revisions (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, runId TEXT NOT NULL REFERENCES wf_run_registrations(runId),
        artifactId TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL,
        UNIQUE(artifactId,revision)
      );
      CREATE INDEX IF NOT EXISTS artifact_project ON artifact_revisions(projectId,runId);
      CREATE TABLE IF NOT EXISTS workflow_events (
        id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES wf_run_registrations(runId), node TEXT NOT NULL,
        attempt INTEGER NOT NULL, sequence INTEGER NOT NULL, json TEXT NOT NULL,
        UNIQUE(runId,node,attempt,sequence)
      );
      CREATE TABLE IF NOT EXISTS workflow_node_states (
        runId TEXT NOT NULL, node TEXT NOT NULL, attempt INTEGER NOT NULL, sequence INTEGER NOT NULL,
        json TEXT NOT NULL, PRIMARY KEY(runId,node)
      );
    `);
  }
  close() { this.db.close(); }
  registration(runId: string, projectId?: string) {
    const row = this.db.prepare("SELECT * FROM wf_run_registrations WHERE runId=?").get(runId) as RegistrationRow | undefined;
    if (row && projectId !== undefined && row.projectId !== projectId) throw new LedgerError(409, "run_project_conflict");
    return row ? { ...row, binding: RunBindingSchema.parse(JSON.parse(row.bindingJson)), input: JSON.parse(row.inputJson) } : undefined;
  }
  requireRun(runId: string, projectId: string) {
    const run = this.registration(runId, projectId);
    if (!run) throw new LedgerError(404, "registered_run_missing");
    return run;
  }
  register(raw: RunRegistration, actor: Principal) {
    const input = RunRegistrationSchema.parse(raw); const principal = PrincipalSchema.parse(actor);
    const requestHash = contentHash(canonicalJSON({ input, principal }));
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM wf_run_registrations WHERE
        (projectId=? AND idempotencyKey=?) OR (projectId=? AND entry=? AND runtime=? AND externalId=?) OR runId=?`)
        .all(input.projectId, input.idempotencyKey, input.projectId, input.binding.models.entry, input.binding.models.runtime, input.externalId, input.id ?? "") as RegistrationRow[];
      if (existing.length) {
        if (existing.length !== 1 || existing[0].projectId !== input.projectId || existing[0].requestHash !== requestHash)
          throw new LedgerError(409, "run_registration_conflict");
        return { runId: existing[0].runId, created: false };
      }
      if (input.parentRunId) this.requireRun(input.parentRunId, input.projectId);
      const runId = input.id ?? `run-${randomUUID()}`;
      const prior = this.outputs.getRun(runId);
      const detail = (prior?.detail ?? {}) as Record<string, unknown>;
      if (prior && (detail.target as { projectId?: string } | undefined)?.projectId !== input.projectId)
        throw new LedgerError(409, "run_project_conflict");
      this.outputs.saveRun({ id: runId, graphId: String(prior?.graphId ?? input.template), graphVersion: Number(prior?.graphVersion ?? 1),
        status: String(prior?.status ?? "registered"), startedAt: String(prior?.startedAt ?? new Date().toISOString()),
        ...(typeof prior?.finishedAt === "string" ? { finishedAt: prior.finishedAt } : {}),
        detail: { ...detail, target: { ...((detail.target ?? {}) as object), projectId: input.projectId }, binding: input.binding,
          modelRoles: input.binding.models, principal, template: input.template, parentRunId: input.parentRunId, parameters: input.parameters },
      });
      this.db.prepare("INSERT INTO wf_run_registrations VALUES (?,?,?,?,?,?,?,?,?)").run(runId, input.projectId, input.externalId,
        input.binding.models.runtime, input.binding.models.entry, input.idempotencyKey, requestHash, canonicalJSON(input.binding), canonicalJSON({ ...input, createdBy: principal }));
      return { runId, created: true };
    })();
  }
  getRun(runId: string, projectId: string) {
    const row = this.outputs.getRun(runId);
    if (!row) throw new LedgerError(404, "run_missing");
    const detail = (row.detail ?? {}) as Record<string, unknown>;
    if ((detail.target as { projectId?: string } | undefined)?.projectId !== projectId) throw new LedgerError(409, "run_project_conflict");
    const registration = this.registration(runId, projectId);
    const { json: _json, ...publicRow } = row;
    return { ...publicRow, id: runId, status: String(row.status), detail, provenance: registration ? "registered" : "unknown", binding: registration?.binding ?? null, principal: registration?.input.createdBy ?? null,
      nodes: this.nodeStates(runId), revisions: this.listRevisions(projectId, runId) };
  }
  sealInputs(runId: string, projectId: string, revisionIds: string[]) {
    return this.db.transaction(() => {
      const run = this.requireRun(runId, projectId);
      const revisions = revisionIds.map(id => this.readRevision(id, projectId).revision);
      if (!revisions.length || revisions.some(r => r.kind !== "material")) throw new LedgerError(400, "material_revisions_required");
      const materialsHash = contentHash(canonicalJSON(revisions.map(r => ({ name: r.name, hash: r.contentHash }))));
      const { requestDigest: _requestDigest, ...parameters } = run.input.parameters;
      const binding = { ...run.binding, materialRevisions: revisionIds, materialsHash,
        inputHash: contentHash(canonicalJSON({ materialsHash, parameters, environmentHash: run.binding.environmentHash })) };
      if (run.binding.materialsHash !== null && canonicalJSON(run.binding) !== canonicalJSON(binding)) throw new LedgerError(409, "run_inputs_already_sealed");
      this.db.prepare("UPDATE wf_run_registrations SET bindingJson=? WHERE runId=?").run(canonicalJSON(binding), runId);
      const row = this.outputs.getRun(runId)!;
      this.db.prepare("UPDATE wf_runs SET json=? WHERE id=?").run(canonicalJSON({ ...(row.detail as object), binding }), runId);
      return binding;
    })();
  }
  listRuns(projectId: string) {
    return this.outputs.listRuns(500).filter(r => r.projectId === projectId).map(r => this.getRun(String(r.id), projectId));
  }
  revision(id: string, projectId: string): ArtifactRevision {
    const row = this.db.prepare("SELECT * FROM artifact_revisions WHERE id=?").get(id) as RevisionRow | undefined;
    if (!row) throw new LedgerError(404, "revision_missing");
    if (row.projectId !== projectId) throw new LedgerError(409, "revision_project_conflict");
    return ArtifactRevisionSchema.parse(JSON.parse(row.json));
  }
  listRevisions(projectId: string, runId?: string): ArtifactRevision[] {
    const rows = this.db.prepare(`SELECT json FROM artifact_revisions WHERE projectId=? ${runId ? "AND runId=?" : ""} ORDER BY rowid`)
      .all(...(runId ? [projectId, runId] : [projectId])) as Array<{ json: string }>;
    return rows.map(r => ArtifactRevisionSchema.parse(JSON.parse(r.json)));
  }
  readRevision(id: string, projectId: string) {
    const revision = this.revision(id, projectId);
    let bytes: Buffer;
    try { bytes = readFileSync(join(this.blobRoot, revision.contentHash)); }
    catch { throw new LedgerError(409, "revision_content_missing"); }
    if (contentHash(bytes) !== revision.contentHash) throw new LedgerError(409, "revision_content_changed");
    return { revision, content: revision.mediaType === "application/json" ? JSON.parse(bytes.toString()) : bytes.toString() };
  }
  putRevision(input: RevisionInput, actor: Principal): ArtifactRevision {
    this.requireRun(input.runId, input.projectId);
    const mediaType = input.mediaType ?? "application/json";
    if (mediaType !== "application/json" && typeof input.content !== "string") throw new LedgerError(400, "text_content_required");
    const bytes = mediaType === "application/json" ? canonicalJSON(input.content) : input.content as string;
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new LedgerError(413, "artifact_too_large");
    const hash = contentHash(bytes);
    const artifactId = `artifact-${contentHash(canonicalJSON([input.projectId, input.runId, input.kind, input.name])).slice(0, 32)}`;
    return this.db.transaction(() => {
      for (const ref of input.sourceRefs ?? []) this.readRevision(ref, input.projectId);
      const priorRow = this.db.prepare("SELECT json FROM artifact_revisions WHERE artifactId=? ORDER BY revision DESC LIMIT 1").get(artifactId) as { json: string } | undefined;
      const prior: ArtifactRevision | undefined = priorRow ? ArtifactRevisionSchema.parse(JSON.parse(priorRow.json)) : undefined;
      // Retrying identical content is idempotent, including provenance.
      if (prior?.contentHash === hash && canonicalJSON(prior.sourceRefs) === canonicalJSON(input.sourceRefs ?? []) && prior.mediaType === mediaType) return prior;
      if ((input.parentRevision ?? null) !== (prior?.id ?? null)) throw new LedgerError(409, "revision_version_conflict");
      const revision = ArtifactRevisionSchema.parse({ schemaVersion: 1, id: `rev-${randomUUID()}`, artifactId, projectId: input.projectId,
        runId: input.runId, name: input.name, kind: input.kind, revision: (prior?.revision ?? 0) + 1, contentHash: hash, mediaType,
        sourceRefs: input.sourceRefs ?? [], parentRevision: prior?.id ?? null, createdAt: new Date().toISOString(), createdBy: actor });
      const path = join(this.blobRoot, hash);
      const temporary = join(this.blobRoot, `.tmp-${randomUUID()}`);
      try {
        writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600, flush: true });
        try { linkSync(temporary, path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (contentHash(readFileSync(path)) !== hash) throw new LedgerError(409, "revision_content_changed"); }
      } finally { rmSync(temporary, { force: true }); }
      this.db.prepare("INSERT INTO artifact_revisions VALUES (?,?,?,?,?,?)").run(revision.id, input.projectId, input.runId, artifactId, revision.revision, canonicalJSON(revision));
      return revision;
    })();
  }
  appendEvent(raw: RunEvent, projectId: string) {
    const event = RunEventSchema.parse(raw); this.requireRun(event.runId, projectId);
    if (event.revisionId) {
      const revision = this.readRevision(event.revisionId, projectId).revision;
      if (revision.runId !== event.runId) throw new LedgerError(409, "event_revision_run_conflict");
    }
    const json = canonicalJSON(event);
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT json FROM workflow_events WHERE id=? OR (runId=? AND node=? AND attempt=? AND sequence=?)")
        .all(event.id, event.runId, event.node, event.attempt, event.sequence) as Array<{ json: string }>;
      if (existing.length) { if (existing.some(e => e.json !== json)) throw new LedgerError(409, "event_identity_conflict"); return { created: false }; }
      this.db.prepare("INSERT INTO workflow_events VALUES (?,?,?,?,?,?)").run(event.id, event.runId, event.node, event.attempt, event.sequence, json);
      this.projectEvent(event); return { created: true };
    })();
  }
  private projectEvent(event: RunEvent) {
    this.db.prepare(`INSERT INTO workflow_node_states VALUES (?,?,?,?,?) ON CONFLICT(runId,node) DO UPDATE SET
      attempt=excluded.attempt, sequence=excluded.sequence, json=excluded.json
      WHERE excluded.attempt>workflow_node_states.attempt OR (excluded.attempt=workflow_node_states.attempt AND excluded.sequence>workflow_node_states.sequence)`)
      .run(event.runId, event.node, event.attempt, event.sequence, canonicalJSON(event));
  }
  nodeStates(runId: string): RunEvent[] {
    return (this.db.prepare("SELECT json FROM workflow_node_states WHERE runId=? ORDER BY node").all(runId) as Array<{ json: string }>).map(r => RunEventSchema.parse(JSON.parse(r.json))).filter(e => !(this.registration(runId)?.input.parameters?.stageControlVersion === 1 && e.id.startsWith("bus-")));
  }
  rebuild() {
    const corruptRuns = new Set<string>();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM workflow_node_states").run();
      for (const row of this.db.prepare("SELECT runId,json FROM workflow_events ORDER BY attempt,sequence").all() as Array<{ runId: string; json: string }>) {
        try { this.projectEvent(RunEventSchema.parse(JSON.parse(row.json))); } catch { corruptRuns.add(row.runId); }
      }
      for (const id of corruptRuns) this.db.prepare("UPDATE wf_runs SET status='blocked' WHERE id=?").run(id);
    })();
    return [...corruptRuns];
  }
  integrity() {
    const issues: string[] = [];
    if ((this.db.pragma("foreign_key_check") as unknown[]).length) issues.push("foreign_key_violation");
    for (const row of this.db.prepare("SELECT id,projectId FROM artifact_revisions").all() as RevisionRow[]) {
      try { const { revision } = this.readRevision(row.id, row.projectId);
        for (const ref of [...revision.sourceRefs, ...(revision.parentRevision ? [revision.parentRevision] : [])]) this.revision(ref, row.projectId);
      } catch (e) { issues.push(`${row.id}:${(e as Error).message}`); }
    }
    return { ok: issues.length === 0, issues };
  }
}
