import { validatePreparedBundle } from './preparation.js';
import { executionBlockers } from "@testpilot/harness-testing/casegen";
import {caseEntryUrl} from './caseEntry.js';
import {getProject} from './db.js';
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { canonicalJSON, PrincipalSchema, type Principal } from "@testpilot/harness-core/run-contracts";
import { TextCaseSchema, type TextCase } from "@testpilot/harness-testing/casegen";
import { parseCode, parseParams, runCodeGate, blockedCases, type CodeBundle } from "@testpilot/harness-testing";
import { runLedger } from "./runService.js";
import { registeredStageProducts, finalizeRun } from "./runStages.js";
import { LedgerError, contentHash } from "./runLedger.js";

const system = { kind: "system" as const, id: "review-projector" };
function ledger() {
  const ledger = runLedger(); ledger.db.exec(`
    CREATE TABLE IF NOT EXISTS reviewed_case_heads (runId TEXT NOT NULL, caseId TEXT NOT NULL, revisionId TEXT NOT NULL REFERENCES artifact_revisions(id), PRIMARY KEY(runId,caseId));
    CREATE TABLE IF NOT EXISTS case_approval_events (id TEXT PRIMARY KEY, runId TEXT NOT NULL, caseId TEXT NOT NULL, revisionId TEXT NOT NULL REFERENCES artifact_revisions(id), decision TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS case_approval_heads (runId TEXT NOT NULL, caseId TEXT NOT NULL, eventId TEXT NOT NULL REFERENCES case_approval_events(id), PRIMARY KEY(runId,caseId));
    CREATE TABLE IF NOT EXISTS decision_outbox (id TEXT PRIMARY KEY REFERENCES case_approval_events(id), runId TEXT NOT NULL, json TEXT NOT NULL, deliveredAt TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
  `); return ledger;
}
function human(actor: Principal) { const p = PrincipalSchema.parse(actor); if (p.kind !== "human") throw new LedgerError(403, "human_review_required"); return p; }
export function reviewRevisions(runId: string, projectId: string) {
  ledger().requireRun(runId, projectId);
  const state = registeredStageProducts(runId);
  if (!state.protected || !state.finalized) throw new LedgerError(409, "finalized_skill_run_required");
  const finalized = finalizeRun(runId, projectId) as { casesRevision?: string };
  return ledger().db.transaction(() => state.products.bundle.cases.map(kase => {
    const existing = ledger().db.prepare("SELECT revisionId FROM reviewed_case_heads WHERE runId=? AND caseId=?").get(runId, kase.id) as { revisionId: string } | undefined;
    const revision = existing ? ledger().readRevision(existing.revisionId, projectId).revision
      : ledger().putRevision({ runId, projectId, name: `review/case/${kase.id}`, kind: "cases", content: kase, sourceRefs: [finalized.casesRevision!] }, system);
    if (!existing) ledger().db.prepare("INSERT INTO reviewed_case_heads VALUES (?,?,?)").run(runId, kase.id, revision.id);
    const approval = approvalFor(runId, kase.id);
    return { caseId: kase.id, revision, content: ledger().readRevision(revision.id, projectId).content as TextCase,
      approval: approval?.revisionId === revision.id ? approval : null };
  }))();
}
function approvalFor(runId: string, caseId: string): Record<string, any> | undefined {
  const row = ledger().db.prepare("SELECT e.json FROM case_approval_heads h JOIN case_approval_events e ON e.id=h.eventId WHERE h.runId=? AND h.caseId=?").get(runId, caseId) as { json: string } | undefined;
  return row ? JSON.parse(row.json) : undefined;
}
export function reviseReviewedCase(runId: string, projectId: string, raw: unknown, actor: Principal) {
  const principal = human(actor);
  const input = z.object({ caseId: z.string(), expectedRevision: z.string(), content: TextCaseSchema }).parse(raw);
  return ledger().db.transaction(() => {
    const prior = reviewRevisions(runId, projectId).find(r => r.caseId === input.caseId);
    if (!prior || prior.revision.id !== input.expectedRevision) throw new LedgerError(409, "review_revision_conflict");
    if (input.content.id !== input.caseId || input.content.storyId !== prior.content.storyId) throw new LedgerError(409, "review_case_identity_frozen");
    if (input.content.readiness?.execution === 'ready') {
      const blockers=executionBlockers(input.content);
      if(blockers.length) throw new LedgerError(409, `execution_not_ready:${JSON.stringify(blockers)}`);
    }
    const revision = ledger().putRevision({ runId, projectId, name: prior.revision.name, kind: "cases", content: input.content,
      sourceRefs: prior.revision.sourceRefs, parentRevision: prior.revision.id }, principal);
    ledger().db.prepare("UPDATE reviewed_case_heads SET revisionId=? WHERE runId=? AND caseId=?").run(revision.id, runId, input.caseId);
    return { revision, approvalValid: approvalFor(runId, input.caseId)?.revisionId === revision.id };
  })();
}
export function decideRevisions(runId: string, projectId: string, raw: unknown, actor: Principal) {
  const principal = human(actor);
  const input = z.object({ items: z.array(z.object({ caseId: z.string(), revisionId: z.string(), decision: z.enum(["approved", "rejected"]) })).min(1), note: z.string().max(4000).optional() }).parse(raw);
  if (new Set(input.items.map(i => i.caseId)).size !== input.items.length) throw new LedgerError(400, "duplicate_review_case");
  // 驳回必须写理由。理由不是礼貌，是唯一能把「这条为什么不该生成」留给下一次的东西：
  // `proposeFromRejections` 只收带理由的驳回，理由短于 4 个字就当没写（regressionCandidates.ts）。
  // 没有这道拦截时，界面上一路点「拒绝所选版本」就能把反例悄悄丢光，宿主工具同理。
  if (input.items.some(i => i.decision === "rejected") && (input.note ?? "").trim().length < 4)
    throw new LedgerError(400, "rejection_requires_reason");
  return ledger().db.transaction(() => {
    const current = reviewRevisions(runId, projectId);
    return input.items.map(item => {
      const kase = current.find(c => c.caseId === item.caseId);
      if (!kase || kase.revision.id !== item.revisionId) return { ...item, status: "conflict" };
      const previous = approvalFor(runId, item.caseId);
      if (previous?.revisionId === item.revisionId && previous.decision === item.decision) return { ...previous, status: "unchanged" };
      const event = { id: `decision-${randomUUID()}`, runId, projectId, ...item, principal, note: input.note ?? "", at: new Date().toISOString() };
      ledger().db.prepare("INSERT INTO case_approval_events VALUES (?,?,?,?,?,?)").run(event.id, runId, item.caseId, item.revisionId, item.decision, canonicalJSON(event));
      ledger().db.prepare("INSERT INTO case_approval_heads VALUES (?,?,?) ON CONFLICT(runId,caseId) DO UPDATE SET eventId=excluded.eventId").run(runId, item.caseId, event.id);
      ledger().db.prepare("INSERT INTO decision_outbox (id,runId,json) VALUES (?,?,?)").run(event.id, runId, canonicalJSON(event));
      return { ...event, status: "recorded" };
    });
  })();
}
/** Dispatch is retried from persistent facts; adapters must merge decisions idempotently. */
export async function deliverDecisionOutbox(deliver: (event: Record<string, any>) => Promise<void> | void) {
  const rows = ledger().db.prepare("SELECT id,json FROM decision_outbox WHERE deliveredAt IS NULL ORDER BY rowid").all() as Array<{ id: string; json: string }>;
  let delivered = 0;
  for (const row of rows) {
    try { await deliver(JSON.parse(row.json)); ledger().db.prepare("UPDATE decision_outbox SET deliveredAt=?,attempts=attempts+1,error=NULL WHERE id=?").run(new Date().toISOString(), row.id); delivered++; }
    catch { ledger().db.prepare("UPDATE decision_outbox SET attempts=attempts+1,error='adapter_delivery_failed' WHERE id=?").run(row.id); }
  }
  return { delivered, pending: rows.length - delivered };
}
export function generateApprovedCode(runId: string, projectId: string, raw: unknown = {}) {
  const input = z.object({ revisionIds: z.array(z.string()).min(1).optional() }).parse(raw);
  return ledger().db.transaction(() => {
    const approved = reviewRevisions(runId, projectId).filter(c => c.approval?.decision === "approved");
    const selected = input.revisionIds ? input.revisionIds.map(id => { const c = approved.find(c => c.revision.id === id); if (!c) throw new LedgerError(409, "case_revision_not_approved"); return c; }) : approved;
    if (!selected.length || new Set(selected.map(c => c.caseId)).size !== selected.length) throw new LedgerError(409, "approved_cases_required");
    selected.sort((a, b) => a.caseId.localeCompare(b.caseId));
    const notReady = selected.map(c => ({ id: c.caseId, reasons: executionBlockers(c.content) })).filter(c => c.reasons.length);
    if (notReady.length) throw new LedgerError(409, `execution_not_ready:${JSON.stringify(notReady)}`);
    /**
     * **这次运行自己声明的地址优先于项目级的那个。**
     *
     * 2026-09-13 实测：项目的 `targetUrl` 是 `…/trade`，而这次运行是按 `…/trade/ETH` 建的
     * （`parameters.sourceUrl`），用例也全是照着 ETH 这一屏写的——`Positions (1)`、
     * `Current Position 0.0400 ETH` 都是那一屏上的东西。编译时却拿项目级地址当入口，
     * 于是 81 条里 **38 条不自己导航的用例**会在 `…/trade` 上开跑：那是另一个市场，
     * 一整批用例会红，而产品什么事都没有。
     *
     * 运行声明了就按运行的来；没声明才回落到项目。
     */
    const params = (ledger().getRun(runId, projectId).detail as { parameters?: { sourceUrl?: string; targetUrl?: string } } | undefined)?.parameters;
    const runBaseUrl = params?.sourceUrl ?? params?.targetUrl ?? getProject(projectId)!.targetUrl;
    const cases = selected.map(c => c.content);
    // Approved natural-language steps are already Midscene's action language. Compile them without a second model interpretation.
    const code = cases.map(c => {
      const source = [...c.steps.map(step => step.startsWith('waitFor:')?`await agent.aiWaitFor(${JSON.stringify(step.slice('waitFor:'.length).trim())}, { timeoutMs: 30000 });`:`await agent.aiAction(${JSON.stringify(step)});`), ...(!c.oracle ? [`await agent.aiAssert(${JSON.stringify(c.expected)});`] : [])].join("\n");
      return { caseId: c.id, title: c.title, entryUrl: caseEntryUrl(c.precondition, runBaseUrl), code: source, actions: parseCode(source).actions, uses: [], params: parseParams(source) };
    });
    const bundle: CodeBundle = { origin: runId, cases, code, fragments: [], failed: [] };
    const gate = runCodeGate(bundle, {}, id => cases.find(c => c.id === id)?.oracle);
    const blocked = [...blockedCases(gate)];
    const refs = selected.map(c => c.revision.id).sort();
    const approvalsHash = contentHash(canonicalJSON(selected.map(c => ({ revisionId: c.revision.id, eventId: c.approval!.id })).sort((a, b) => a.revisionId.localeCompare(b.revisionId))));
    /**
     * 名字里要带**编译器身份**，不只是批准的哈希。
     *
     * 2026-09-13：入口地址的取法改了（从项目级改成运行声明的），重跑 g2 直接
     * `revision_version_conflict`——名字只按批准取哈希，而内容取决于编译器，
     * 同一批批准换个编译器就是「同名不同内容」。更糟的是 `approvedExecutionBundle`
     * 会重编并要求 id 一致，于是编译逻辑一改，此前编好的产物**永远执行不了**。
     *
     * 把编译方式、入口策略与这次运行的基址一起写进名字：编译器变了就是**另一份产物**，
     * 冲突消失，而「你批准的代码不是现在这个编译器产出的代码」这件事仍然拦得住（见下面那条）。
     */
    // v2（2026-09-15）：前提里的完整同源地址、「已打开」与后半句也算入口声明（caseEntry.ts）。入口取法变了，编译器身份就得变。
    const compilation = "approved-midscene-actions-v2", entryPolicy = "explicit-page-precondition-v2";
    const compilerHash = contentHash(canonicalJSON({ compilation, entryPolicy, base: runBaseUrl })).slice(0, 12);
    const artifactName = `g2/v2/${approvalsHash}-${compilerHash}`;
    const artifact = ledger().putRevision({ runId, projectId, name: artifactName, kind: "code", content: { ...bundle, gate, approvedRevisions: refs, approvalsHash,
      intentHash: contentHash(canonicalJSON(cases.map(c => ({ id: c.id, expected: c.expected, oracle: c.oracle ?? null })))), entryPolicy, compilation, baseUrl: runBaseUrl }, sourceRefs: refs }, { kind: "system", id: "g2-compiler" });
    return { status: blocked.length ? "blocked" : "ready_to_execute", revision: artifact, blocked, gate };
  })();
}
export function approvedExecutionBundle(runId: string, projectId: string, revisionId: string) {
  const artifact = ledger().readRevision(revisionId, projectId);
  if (artifact.revision.runId !== runId || artifact.revision.kind !== "code") throw new LedgerError(409, "execution_revision_conflict");
  const content = artifact.content as CodeBundle & { approvedRevisions: string[]; approvalsHash: string };
  if ((content as any).compilation === 'host-prepared-v1') return validatePreparedBundle(runId,projectId,content);
  const fresh = generateApprovedCode(runId, projectId, { revisionIds: content.approvedRevisions });
  /**
   * 重编一次再比对：**要执行的必须是现在这个编译器产出的代码**。
   * 不一致有两种可能——批准变了，或者编译器/入口地址变了；名字里带了编译器身份之后
   * 后一种会落到另一个 artifact 上，所以这里报的就是它自己那句话。
   */
  if (fresh.status !== "ready_to_execute" || fresh.revision.id !== revisionId)
    throw new LedgerError(409, fresh.status !== "ready_to_execute" ? "execution_blocked_by_code_gate" : "execution_recompiles_differently");
  return content;
}
/** Read-only readiness projection; never regenerates code or changes approvals. */
export function compiledReadiness(runId: string, projectId: string) {
 const codeRevisions=ledger().listRevisions(projectId,runId).filter(r=>r.kind==='code');
 const selectedRevision=ledger().nodeStates(runId).find(n=>n.node==='g2'&&n.phase==='done')?.revisionId;
 const code=codeRevisions.find(r=>r.id===selectedRevision)??codeRevisions.at(-1);
 if(!code)return {codeRevision:null,ready:false,reason:'code_required'};
 const content=ledger().readRevision(code.id,projectId).content as {approvedRevisions?:string[];approvalsHash?:string;compilation?:string;gate?:unknown};
 if(content.compilation==='host-prepared-v1'){try{validatePreparedBundle(runId,projectId,content);return {codeRevision:code.id,revisionIds:content.approvedRevisions??[],ready:true,reason:null};}catch{return {codeRevision:code.id,revisionIds:content.approvedRevisions??[],ready:false,reason:'preparation_approval_changed'};}}
 const current=reviewRevisions(runId,projectId);const selected=(content.approvedRevisions??[]).map(id=>current.find(c=>c.revision.id===id&&c.approval?.decision==='approved'));
 const complete=selected.length>0&&selected.every(Boolean);
 const hash=complete?contentHash(canonicalJSON(selected.map(c=>({revisionId:c!.revision.id,eventId:c!.approval!.id})).sort((a,b)=>a.revisionId.localeCompare(b.revisionId)))):null;
 const ready=content.compilation==='approved-midscene-actions-v2'&&complete&&hash===content.approvalsHash&&blockedCases(content.gate as Parameters<typeof blockedCases>[0]).size===0;
 return {codeRevision:code.id,revisionIds:content.approvedRevisions??[],ready,reason:ready?null:'execution_approval_changed'};
}
