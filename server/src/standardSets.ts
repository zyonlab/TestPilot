/**
 * 标准测试集（docs/v3/15 阶段 8，2026-09-28 用户解冻）。
 *
 * 自进化要一把不会自己动的尺子：改了执行器、换了模型、换了提示词，拿同一批用例量一遍，数字才能比。
 * 这里的尺子是「人批准过、准备验证过、正式执行真跑过」的用例：
 * - **自动起草**：从一个运行的正式执行里挑最近一次判定为通过的用例，连同它所在的执行包版本（codeRevision）记下；
 * - **只有人能冻结**：冻结后内容与哈希不再变，评估只认冻结的集（和 Gold 同一条红线）；
 * - **打分是确定的**：给定一次执行的结果，按集里的用例数通过、失败、没量到、基础设施失败——不调模型。
 *
 * 它不是 `benchmark/*` 的 Gold（那是「故事 → 期望用例」的生成质量尺子，本模块不读也不写它）。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJSON, PrincipalSchema, type Principal } from "@testpilot/harness-core/run-contracts";
import { runLedger } from "./runService.js";
import { contentHash, LedgerError } from "./runLedger.js";
import { listWorkflowExecutions } from "./workflowExecution.js";

export interface StandardItem { caseId: string; runId: string; codeRevision: string; title: string; lastPassedExecutionId: string; passes: number; fails: number }
export interface StandardSet {
  id: string; projectId: string; name: string; status: "draft" | "frozen"; items: StandardItem[]; itemsHash: string;
  createdAt: string; source: { runIds: string[] }; frozen?: { by: string; at: string; note: string };
}
export interface SetScore { setId: string; itemsHash: string; n: number; passed: number; failed: number; unobservable: number; infra: number; notRun: number; passRate: number; perCase: Array<{ caseId: string; status: string }> }

function ledger() {
  const l = runLedger();
  l.db.exec("CREATE TABLE IF NOT EXISTS standard_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL, createdAt TEXT NOT NULL)");
  return l;
}
type ExecRow = { id: string; codeRevision: string; status: string; resultRevision: string | null; startedAt: string };
type CaseResult = { caseId?: string; status?: string; infraError?: boolean; failure?: { attribution?: string } };

/** 一个运行里每条用例的执行历史（按时间），只数真跑过的。 */
function caseHistory(runId: string, projectId: string) {
  const l = ledger();
  const rows = (listWorkflowExecutions(runId, projectId) as ExecRow[]).filter((r) => r.resultRevision).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const history = new Map<string, Array<{ executionId: string; codeRevision: string; status: string; infra: boolean }>>();
  for (const row of rows) {
    const results = ((l.readRevision(row.resultRevision!, projectId).content as { results?: CaseResult[] }).results ?? []);
    for (const r of results) {
      if (!r.caseId || !r.status || r.status === "not_run") continue;
      const list = history.get(r.caseId) ?? history.set(r.caseId, []).get(r.caseId)!;
      list.push({ executionId: row.id, codeRevision: row.codeRevision, status: r.status, infra: r.infraError === true || r.failure?.attribution === "infra" });
    }
  }
  return history;
}

/** 从这些运行起草一份标准集：最近一次（非基础设施）判定为通过的用例。已有草稿就换掉，冻结的不动。 */
export function draftStandardSet(projectId: string, raw: unknown) {
  const input = z.object({ runIds: z.array(z.string().min(1)).min(1).max(20), name: z.string().trim().min(1).max(120).optional() }).parse(raw);
  const l = ledger(), items: StandardItem[] = [];
  for (const runId of input.runIds) {
    l.requireRun(runId, projectId);
    const review = l.listRevisions(projectId, runId).filter((r) => r.name.startsWith("review/case/"));
    const titleOf = (caseId: string) => { const rev = review.filter((r) => r.name === `review/case/${caseId}`).sort((a, b) => a.revision - b.revision).at(-1);
      return rev ? String((l.readRevision(rev.id, projectId).content as { title?: string }).title ?? caseId) : caseId; };
    for (const [caseId, runs] of caseHistory(runId, projectId)) {
      const decided = runs.filter((r) => !r.infra);
      const last = decided.at(-1);
      if (!last || last.status !== "passed") continue;
      items.push({ caseId, runId, codeRevision: last.codeRevision, title: titleOf(caseId), lastPassedExecutionId: last.executionId,
        passes: decided.filter((r) => r.status === "passed").length, fails: decided.filter((r) => r.status !== "passed").length });
    }
  }
  items.sort((a, b) => a.runId.localeCompare(b.runId) || a.caseId.localeCompare(b.caseId));
  const now = new Date().toISOString();
  const set: StandardSet = { id: `std-${randomUUID()}`, projectId, name: input.name ?? `标准集 ${now.slice(0, 10)}`, status: "draft", items,
    itemsHash: contentHash(canonicalJSON(items)), createdAt: now, source: { runIds: input.runIds } };
  l.db.transaction(() => {
    l.db.prepare("DELETE FROM standard_sets WHERE projectId=? AND status='draft'").run(projectId);
    l.db.prepare("INSERT INTO standard_sets VALUES (?,?,?,?,?)").run(set.id, projectId, "draft", canonicalJSON(set), now);
  })();
  return set;
}

export function listStandardSets(projectId: string): StandardSet[] {
  return (ledger().db.prepare("SELECT json FROM standard_sets WHERE projectId=? ORDER BY createdAt DESC").all(projectId) as Array<{ json: string }>).map((r) => JSON.parse(r.json) as StandardSet);
}
export function readStandardSet(projectId: string, setId: string): StandardSet {
  const row = ledger().db.prepare("SELECT json FROM standard_sets WHERE id=? AND projectId=?").get(setId, projectId) as { json: string } | undefined;
  if (!row) throw new LedgerError(404, "standard_set_not_found");
  const set = JSON.parse(row.json) as StandardSet;
  if (set.status === "frozen" && contentHash(canonicalJSON(set.items)) !== set.itemsHash) throw new LedgerError(409, "standard_set_tampered");
  return set;
}

/** 冻结只能是人，可以顺手去掉几条（比如判定不稳的），但不能加。冻结后不再变。 */
export function freezeStandardSet(projectId: string, setId: string, raw: unknown, actor: Principal) {
  const principal = PrincipalSchema.parse(actor);
  if (principal.kind !== "human") throw new LedgerError(403, "human_review_required");
  const input = z.object({ itemsHash: z.string().min(1), exclude: z.array(z.string()).max(500).default([]), note: z.string().max(2000).optional(), name: z.string().trim().min(1).max(120).optional() }).parse(raw);
  const l = ledger();
  return l.db.transaction(() => {
    const set = readStandardSet(projectId, setId);
    if (set.status === "frozen") throw new LedgerError(409, "standard_set_already_frozen");
    // 冻结的是人看过的那一份：草稿在人看的时候被重新起草过，就拒绝。
    if (set.itemsHash !== input.itemsHash) throw new LedgerError(409, "standard_set_changed", "The draft was redrafted after you loaded it. Reload and review it again before freezing.");
    const drop = new Set(input.exclude);
    const items = set.items.filter((i) => !drop.has(`${i.runId}:${i.caseId}`) && !drop.has(i.caseId));
    if (!items.length) throw new LedgerError(400, "standard_set_empty");
    const at = new Date().toISOString();
    const frozen: StandardSet = { ...set, name: input.name ?? set.name, status: "frozen", items, itemsHash: contentHash(canonicalJSON(items)), frozen: { by: principal.id, at, note: input.note ?? "" } };
    l.db.prepare("UPDATE standard_sets SET status='frozen', json=? WHERE id=?").run(canonicalJSON(frozen), setId);
    return frozen;
  })();
}

/** 按冻结集给一批执行结果打分。集里的用例在这些执行里没出现，记「没跑」——不算通过也不从分母里拿掉。 */
export function scoreExecutions(projectId: string, setId: string, executionIds: string[]): SetScore {
  const set = readStandardSet(projectId, setId);
  if (set.status !== "frozen") throw new LedgerError(409, "standard_set_not_frozen");
  const l = ledger(), latest = new Map<string, CaseResult>();
  for (const id of executionIds) {
    const row = l.db.prepare("SELECT runId,resultRevision FROM workflow_executions WHERE id=? AND projectId=?").get(id, projectId) as { runId: string; resultRevision: string | null } | undefined;
    if (!row?.resultRevision) continue;
    for (const r of ((l.readRevision(row.resultRevision, projectId).content as { results?: CaseResult[] }).results ?? []))
      if (r.caseId && r.status && r.status !== "not_run") latest.set(`${row.runId}:${r.caseId}`, r);
  }
  const perCase = set.items.map((i) => { const r = latest.get(`${i.runId}:${i.caseId}`);
    return { caseId: i.caseId, status: !r ? "not_run" : r.infraError || r.failure?.attribution === "infra" ? "infra" : String(r.status) }; });
  const count = (s: string) => perCase.filter((c) => c.status === s).length;
  const passed = count("passed");
  return { setId, itemsHash: set.itemsHash, n: set.items.length, passed, failed: count("failed"), unobservable: count("unobservable"), infra: count("infra"), notRun: count("not_run"),
    passRate: set.items.length ? passed / set.items.length : 0, perCase };
}
