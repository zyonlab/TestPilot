import { canonicalJSON, type Principal } from "@testpilot/harness-core/run-contracts";
import { contentHash, LedgerError } from "./runLedger.js";
import { runLedger } from "./runService.js";
import { deliverDecisionOutbox, reviewRevisions } from "./approvedRuns.js";
import { createCase, db, getCase, updateCase } from "./db.js";
import { getRuntime } from "./runtimes.js";
import type { TextCase } from "@testpilot/harness-testing/casegen";

function bindings() { db.exec("CREATE TABLE IF NOT EXISTS case_revision_bindings (caseId TEXT PRIMARY KEY, runId TEXT NOT NULL, projectId TEXT NOT NULL, revisionId TEXT NOT NULL); CREATE TABLE IF NOT EXISTS case_action_repairs (caseId TEXT PRIMARY KEY, revisionId TEXT NOT NULL)"); }
export function boardBinding(id: string) { bindings(); return db.prepare("SELECT runId,projectId,revisionId FROM case_revision_bindings WHERE caseId=?").get(id) as { runId: string; projectId: string; revisionId: string } | undefined; }
function actions(kase: { steps: Array<{ text: string }>; postSteps: Array<{ text: string }>; code?: string }) { return { steps: kase.steps.map(s => s.text), postSteps: kase.postSteps.map(s => s.text), code: kase.code || null }; }
export function recordBoardActionRepair(before: NonNullable<ReturnType<typeof getCase>>, patch: Record<string, unknown>, actor: Principal) {
  assertBoardApproval(before);
  const link = boardBinding(before.id)!;
  const after = { ...before, ...patch };
  const previous = db.prepare("SELECT revisionId FROM case_action_repairs WHERE caseId=?").get(before.id) as { revisionId: string } | undefined;
  const revision = runLedger().putRevision({ runId: link.runId, projectId: link.projectId, name: `action-repair/${before.id}`, kind: "code",
    content: { approvedRevision: link.revisionId, ...actions(after) }, sourceRefs: [link.revisionId], parentRevision: previous?.revisionId ?? null }, actor);
  db.prepare("INSERT INTO case_action_repairs VALUES (?,?) ON CONFLICT(caseId) DO UPDATE SET revisionId=excluded.revisionId").run(before.id, revision.id);
}
export async function flushDecisionDelivery() {
  return deliverDecisionOutbox(event => {
    const current = reviewRevisions(event.runId, event.projectId).find(c => c.caseId === event.caseId);
    // A superseded decision has nothing left to deliver. Never let an old retry replace a new decision.
    if (!current?.approval || current.approval.id !== event.id) return;
    const boardId = `tc-rev-${contentHash(event.revisionId).slice(0, 24)}`;
    bindings();
    db.transaction(() => {
      if (event.decision === "approved") {
        const c = current.content;
        if (!getCase(boardId)) createCase({ id: boardId, projectId: event.projectId, title: c.title, expected: c.expected,
          precondition: c.precondition.join("; "), steps: c.steps.map((text, i) => ({ order: i + 1, text })),
          postSteps: c.postSteps.map((text, i) => ({ order: i + 1, text })), oracle: c.oracle, tier: c.tier, priority: c.priority ?? "P1",
          storyId: c.storyId, designMethod: c.designMethod, covers: c.covers, acRefs: c.acRefs, sourceRunId: event.runId });
        else updateCase(boardId, { quarantined: false });
        db.prepare("INSERT OR IGNORE INTO case_revision_bindings VALUES (?,?,?,?)").run(boardId, event.runId, event.projectId, event.revisionId);
      } else if (getCase(boardId)) updateCase(boardId, { quarantined: true });
    })();
    const run = runLedger().getRun(event.runId, event.projectId);
    const detail = run.detail as { runtime?: string; penguin?: { workspace?: string } };
    if (detail.penguin?.workspace) getRuntime(detail.runtime ?? run.binding?.models.runtime).writeDecisions(detail.penguin.workspace, event.runId,
      [{ caseId: event.caseId, decision: event.decision, by: event.principal.id, at: event.at, reason: event.note }]);
  });
}
/**
 * 板上那些**绑在已被取代的修订上**的用例。
 *
 * 板 id 是从 revision 派生的（`tc-rev-<hash>`），所以同一条用例改一版就多一条板项，
 * 而旧的那条没有任何机制退休。2026-09-11 实测：一条 run 复核完之后板上 193 条，
 * 其中 **26 条是同一条用例的旧修订**，两条都不隔离、都会被导出——
 * 交出去的工程里同一条用例有两个 spec，其中一个跑的是已经被改掉的步骤。
 * 这正是「重复集成无重复文件」要拦的事。
 *
 * 判据不新增状态：`reviewed_case_heads` 里那条 (runId, caseId) 的当前头版才算数，
 * 绑在别的修订上的板项就是旧的。读侧过滤，自我修正——再改一版，上一版自动变旧。
 */
export function supersededBoardCases(projectId: string): Set<string> {
  bindings();
  const rows = db.prepare("SELECT caseId,runId,revisionId FROM case_revision_bindings WHERE projectId=?").all(projectId) as Array<{ caseId: string; runId: string; revisionId: string }>;
  const stale = new Set<string>();
  for (const r of rows) {
    const head = runLedger().db.prepare("SELECT revisionId FROM reviewed_case_heads WHERE runId=? AND revisionId=?").get(r.runId, r.revisionId) as { revisionId: string } | undefined;
    if (!head) stale.add(r.caseId);
  }
  return stale;
}

/** The runnable board is a projection; an approval remains bound to the immutable source. */
export function assertBoardApproval(kase: NonNullable<ReturnType<typeof getCase>>, overrides?: { expected?: unknown }) {
  bindings();
  const link = boardBinding(kase.id);
  if (!link) {
    if (kase.sourceRunId && runLedger().registration(kase.sourceRunId)?.binding.models.mode === "skill") throw new LedgerError(409, "case_approval_binding_missing");
    return;
  }
  const current = reviewRevisions(link.runId, link.projectId).find(c => c.revision.id === link.revisionId);
  if (!current || current.approval?.decision !== "approved") throw new LedgerError(409, "case_approval_no_longer_valid");
  const intent = (c: Pick<TextCase, "expected" | "oracle">) => ({ expected: c.expected, oracle: c.oracle ?? null });
  if (canonicalJSON(intent(current.content)) !== canonicalJSON(intent({ expected: kase.expected ?? "", oracle: kase.oracle })) ||
    (overrides?.expected !== undefined && overrides.expected !== current.content.expected)) throw new LedgerError(409, "approved_case_content_changed");
  const repair = db.prepare("SELECT revisionId FROM case_action_repairs WHERE caseId=?").get(kase.id) as { revisionId: string } | undefined;
  const expectedActions = repair ? runLedger().readRevision(repair.revisionId, link.projectId).content : { approvedRevision: link.revisionId, steps: current.content.steps, postSteps: current.content.postSteps, code: null };
  if (canonicalJSON(expectedActions) !== canonicalJSON({ approvedRevision: link.revisionId, ...actions(kase) })) throw new LedgerError(409, "approved_actions_changed_without_revision");
}


/** Export assertions from the approved immutable revision, not the legacy board columns. */
export function exportApprovedCases(cases: Array<NonNullable<ReturnType<typeof getCase>>>) {
  return cases.map(kase => {
    const link = boardBinding(kase.id);
    if (!link) return kase;
    assertBoardApproval(kase);
    const current = reviewRevisions(link.runId, link.projectId).find(c => c.revision.id === link.revisionId)!;
    return { ...kase, assertions: current.content.assertions, lifecycle:current.content.lifecycle };
  });
}
