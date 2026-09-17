/**
 * 失败 → 回归候选 → 人批准 → 项目回归集。
 *
 * 两种来源，各自只收**有回归意义**的那部分：
 *
 * - `defect`：执行里判定失败（归属 `assert`）的用例。它抓到过一次产品不对，
 *   以后每次都该跑。环境失败（`infra`）与步骤没落到界面上（`locate`）不收——
 *   前者什么都没证明，后者该改的是用例措辞，不是把它钉进回归集。
 *   有执行基线且这条用例判决来回翻（`flaky`）的也不收：那是判官或定位不稳，不是缺陷。
 * - `rejection`：人驳回了一条用例并写了理由。它进回归集是作为**生成器的反例评测项**
 *   ——「这样写会被拒，原因是……」——下一版生成器可以拿它回归，不是一条可执行用例。
 *
 * 为什么不把候选塞回原运行的复核队列：复核、g2 编译与上板都只认定稿时冻结的那份用例
 * （`reviewRevisions` 读 `validated/cases`，定稿后写不进新用例，改了回执会让门禁过期）。
 * 候选因此单独存一张表，再在原运行上落一条 `regression-candidate/*` 修订留住血缘；
 * 原批次的批准与 `approvalsHash` 一概不碰。
 *
 * **这里不写新的用例内容。** 缺陷候选指向那条已经批准、已经上板的用例；
 * 由失败或拒绝理由生成全新的用例要调模型，而且写出来还得走一遍完整复核——那是下一步。
 *
 * 批准与驳回必须是人（`human_review_required`，与用例复核同一条规则）。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJSON, PrincipalSchema, type Principal } from "@testpilot/harness-core/run-contracts";
import { classifyFailure } from "@testpilot/harness-testing";
import { runLedger } from "./runService.js";
import { contentHash, LedgerError } from "./runLedger.js";
import { compareToBaseline } from "./executionBaseline.js";

export type CandidateKind = "defect" | "rejection";
export type CandidateStatus = "pending" | "approved" | "dismissed";

export interface RegressionCandidate {
  id: string;
  projectId: string;
  runId: string;
  kind: CandidateKind;
  caseId: string;
  sourceRevisionId: string;
  status: CandidateStatus;
  revisionId: string;
  createdAt: string;
  title: string;
  evidence: Record<string, unknown>;
  seen: number;
  decision?: { by: string; at: string; note: string };
}

const system = { kind: "system" as const, id: "regression-candidates" };

function ledger() {
  const l = runLedger();
  l.db.exec(`
    CREATE TABLE IF NOT EXISTS regression_candidates (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, runId TEXT NOT NULL, kind TEXT NOT NULL, caseId TEXT NOT NULL,
      sourceRevisionId TEXT NOT NULL, status TEXT NOT NULL, revisionId TEXT NOT NULL, json TEXT NOT NULL, createdAt TEXT NOT NULL,
      UNIQUE(projectId, kind, sourceRevisionId));
    CREATE TABLE IF NOT EXISTS regression_suite (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL, candidateId TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, json TEXT NOT NULL, addedAt TEXT NOT NULL);
  `);
  return l;
}

type Row = { json: string; status: string };
const fromRow = (row: Row): RegressionCandidate => ({ ...JSON.parse(row.json), status: row.status });

function upsertCandidate(input: {
  projectId: string; runId: string; kind: CandidateKind; caseId: string; sourceRevisionId: string;
  title: string; content: unknown; evidence: Record<string, unknown>; sourceRefs: string[];
}): { candidate: RegressionCandidate; created: boolean } {
  const l = ledger();
  const existing = l.db.prepare("SELECT json,status FROM regression_candidates WHERE projectId=? AND kind=? AND sourceRevisionId=?")
    .get(input.projectId, input.kind, input.sourceRevisionId) as Row | undefined;
  if (existing) {
    // 同一条批准过的用例又挂了一次：不重复出候选，只记次数与最近一次证据（驳回过的也不再冒出来）。
    const prior = fromRow(existing);
    if (prior.status !== "pending") return { candidate: prior, created: false };
    const next = { ...prior, seen: prior.seen + 1, evidence: input.evidence };
    l.db.prepare("UPDATE regression_candidates SET json=? WHERE id=?").run(canonicalJSON(next), prior.id);
    return { candidate: next, created: false };
  }
  const id = `regcand-${randomUUID()}`;
  const revision = l.putRevision({
    runId: input.runId, projectId: input.projectId, name: `regression-candidate/${input.caseId}/${id}`, kind: "report",
    content: { schemaVersion: 1, candidateId: id, kind: input.kind, caseId: input.caseId, sourceRevisionId: input.sourceRevisionId, case: input.content, evidence: input.evidence },
    sourceRefs: input.sourceRefs,
  }, system);
  const candidate: RegressionCandidate = {
    id, projectId: input.projectId, runId: input.runId, kind: input.kind, caseId: input.caseId, sourceRevisionId: input.sourceRevisionId,
    status: "pending", revisionId: revision.id, createdAt: new Date().toISOString(), title: input.title, evidence: input.evidence, seen: 1,
  };
  l.db.prepare("INSERT INTO regression_candidates VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    id, input.projectId, input.runId, input.kind, input.caseId, input.sourceRevisionId, "pending", revision.id, canonicalJSON(candidate), candidate.createdAt);
  return { candidate, created: true };
}

type Any = any; // 执行与代码产物是各自的 schema，这里只读几个字段。

/** 执行判定失败的用例 → 缺陷候选。默认读最近一次执行。 */
export function proposeFromExecution(runId: string, projectId: string, raw: unknown = {}) {
  const input = z.object({ executionId: z.string().optional() }).parse(raw ?? {});
  const l = ledger();
  l.requireRun(runId, projectId);
  const row = (input.executionId
    ? l.db.prepare("SELECT id,codeRevision,resultRevision FROM workflow_executions WHERE runId=? AND id=?").get(runId, input.executionId)
    : l.db.prepare("SELECT id,codeRevision,resultRevision FROM workflow_executions WHERE runId=? AND resultRevision IS NOT NULL ORDER BY startedAt DESC LIMIT 1").get(runId)
  ) as { id: string; codeRevision: string; resultRevision: string | null } | undefined;
  if (!row) throw new LedgerError(404, "execution_not_found");
  if (!row.resultRevision) return { executionId: row.id, created: [], updated: [], skipped: [{ reason: "execution_not_finished" }] };

  const result = l.readRevision(row.resultRevision, projectId).content as Any;
  const code = l.readRevision(row.codeRevision, projectId).content as Any;
  // 这次执行编译自哪几版批准过的用例：caseId → 那一版的修订与内容。
  const approved = new Map<string, { revisionId: string; content: Any }>();
  for (const ref of (code.approvedRevisions ?? []) as string[]) {
    const content = l.readRevision(ref, projectId).content as Any;
    if (content?.id) approved.set(content.id, { revisionId: ref, content });
  }
  let changes: Record<string, string> = {};
  try {
    const c = compareToBaseline(runId, projectId, { executionId: row.id }) as Any;
    changes = Object.fromEntries((c.cases ?? []).map((x: Any) => [x.caseId, x.change]));
  } catch { /* 没立基线：不知道谁在来回翻，照常收判定失败 */ }

  const created: RegressionCandidate[] = [], updated: RegressionCandidate[] = [], skipped: Array<Record<string, unknown>> = [];
  for (const r of (result.results ?? []) as Any[]) {
    if (!r?.caseId || r.status !== "failed") continue;
    const failure = r.failure ?? (r.failureReason ? classifyFailure(String(r.failureReason)) : undefined);
    const attribution = r.infraError ? "infra" : failure?.attribution ?? "assert";
    if (attribution !== "assert") { skipped.push({ caseId: r.caseId, reason: `attribution_${attribution}` }); continue; }
    if (changes[r.caseId] === "flaky") { skipped.push({ caseId: r.caseId, reason: "flaky" }); continue; }
    const source = approved.get(r.caseId);
    if (!source) { skipped.push({ caseId: r.caseId, reason: "approved_revision_missing" }); continue; }
    const evidence = {
      executionId: row.id,
      failureCode: failure?.code ?? null,
      failureReason: String(r.failureReason ?? "").slice(0, 1000),
      change: changes[r.caseId] ?? null,
      oracle: (r.oracle ?? []).map((o: Any) => ({ status: o.status, decidedBy: o.decidedBy, assertion: o.assertion, detail: o.detail })).slice(0, 20),
      // 批准时投到项目用例板上的那一条（decisionDelivery 同一算法）。
      boardCaseId: `tc-rev-${contentHash(source.revisionId).slice(0, 24)}`,
    };
    const out = upsertCandidate({ projectId, runId, kind: "defect", caseId: r.caseId, sourceRevisionId: source.revisionId,
      title: String(source.content.title ?? r.caseId), content: source.content, evidence, sourceRefs: [source.revisionId, row.resultRevision] });
    (out.created ? created : updated).push(out.candidate);
  }
  return { executionId: row.id, created, updated, skipped };
}

/** 人驳回、且写了理由的用例 → 反例候选。没写理由的不收：没有理由就没有可回归的东西。 */
export function proposeFromRejections(runId: string, projectId: string, decisions: Array<Record<string, unknown>>, note: string | undefined) {
  const reason = (note ?? "").trim();
  if (reason.length < 4) return { created: [], updated: [] };
  const l = ledger();
  const created: RegressionCandidate[] = [], updated: RegressionCandidate[] = [];
  for (const d of decisions) {
    if (d.decision !== "rejected" || d.status !== "recorded") continue;
    const revisionId = String(d.revisionId);
    const content = l.readRevision(revisionId, projectId).content as Any;
    const principal = d.principal as { id?: string } | undefined;
    const out = upsertCandidate({ projectId, runId, kind: "rejection", caseId: String(d.caseId), sourceRevisionId: revisionId,
      title: String(content?.title ?? d.caseId), content,
      evidence: { reason: reason.slice(0, 4000), rejectedBy: principal?.id ?? null, decisionId: d.id ?? null }, sourceRefs: [revisionId] });
    (out.created ? created : updated).push(out.candidate);
  }
  return { created, updated };
}

export function listRegressionCandidates(projectId: string, filter: { runId?: string; status?: string } = {}) {
  const rows = ledger().db.prepare("SELECT json,status FROM regression_candidates WHERE projectId=? ORDER BY createdAt").all(projectId) as Row[];
  return rows.map(fromRow).filter((c) => (!filter.runId || c.runId === filter.runId) && (!filter.status || c.status === filter.status));
}

export function decideRegressionCandidate(projectId: string, candidateId: string, raw: unknown, actor: Principal) {
  const principal = PrincipalSchema.parse(actor);
  if (principal.kind !== "human") throw new LedgerError(403, "human_review_required");
  const input = z.object({ decision: z.enum(["approved", "dismissed"]), note: z.string().max(4000).optional() }).parse(raw);
  const l = ledger();
  return l.db.transaction(() => {
    const row = l.db.prepare("SELECT json,status FROM regression_candidates WHERE id=? AND projectId=?").get(candidateId, projectId) as Row | undefined;
    if (!row) throw new LedgerError(404, "regression_candidate_not_found");
    const prior = fromRow(row);
    if (prior.status !== "pending") {
      if (prior.status === input.decision) return { candidate: prior, status: "unchanged" };
      throw new LedgerError(409, "regression_candidate_already_decided");
    }
    const at = new Date().toISOString();
    const next: RegressionCandidate = { ...prior, status: input.decision, decision: { by: principal.id, at, note: input.note ?? "" } };
    l.db.prepare("UPDATE regression_candidates SET status=?, json=? WHERE id=?").run(input.decision, canonicalJSON(next), candidateId);
    let entry: Record<string, unknown> | undefined;
    if (input.decision === "approved") {
      const snapshot = l.readRevision(prior.revisionId, projectId).content as Any;
      entry = {
        id: `regsuite-${randomUUID()}`, projectId, candidateId, kind: prior.kind,
        // defect 是一条要一直跑的用例；rejection 是给生成器回归的反例评测项。
        role: prior.kind === "defect" ? "regression-case" : "generator-negative-eval",
        runId: prior.runId, caseId: prior.caseId, sourceRevisionId: prior.sourceRevisionId, candidateRevisionId: prior.revisionId,
        title: prior.title, case: snapshot.case, evidence: prior.evidence, approvedBy: principal.id, approvedAt: at, note: input.note ?? "",
      };
      l.db.prepare("INSERT INTO regression_suite VALUES (?,?,?,?,?,?)").run(entry.id, projectId, candidateId, prior.kind, canonicalJSON(entry), at);
    }
    return { candidate: next, status: "recorded", suiteEntry: entry ?? null };
  })();
}

export function regressionSuite(projectId: string, kind?: CandidateKind) {
  const rows = ledger().db.prepare("SELECT json FROM regression_suite WHERE projectId=? ORDER BY addedAt").all(projectId) as Array<{ json: string }>;
  return rows.map((r) => JSON.parse(r.json) as Record<string, unknown>).filter((e) => !kind || e.kind === kind);
}
