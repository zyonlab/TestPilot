import { z } from "zod";
import { compareExecutions, describeComparison, type ExecutionSnapshot, type CaseVerdict } from "@testpilot/harness-testing/exec";
import { runLedger } from "./runService.js";
import { LedgerError } from "./runLedger.js";

/**
 * 工作流执行的**基线**与对比。
 *
 * 此前这条链路上没有任何「和上次比」的东西：`baselines` 表是给旧 runs 路径的逐步截图用的，
 * 工作流执行一行都不写进去。于是一次执行只能自己看自己——「35 条通过 29」这个数字
 * 说不出「哪几条变好了、哪几条坏了」。
 *
 * 这里**不做截图基线**。被测对象是一张价格每秒都在跳的实时交易页，逐步截图基线在它上面
 * 每次都会红，那种基线一周之内就会被人关掉。这里的基线是**判决集**：哪几条通过。
 */
export interface ExecutionBaselineRow { runId: string; projectId: string; executionId: string; note: string; by: string; at: string }

function table() {
  const l = runLedger();
  l.db.exec(`CREATE TABLE IF NOT EXISTS execution_baselines (
    runId TEXT PRIMARY KEY, projectId TEXT NOT NULL, executionId TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', by TEXT NOT NULL, at TEXT NOT NULL)`);
  return l;
}

/** 一次执行的判决集。读的是执行落下的那份 artifact，不重算。 */
export function executionSnapshot(runId: string, projectId: string, executionId: string): ExecutionSnapshot {
  const l = runLedger();
  const rev = l.listRevisions(projectId, runId).filter((r) => r.name === `execution/${executionId}`).sort((a, b) => a.revision - b.revision).at(-1);
  if (!rev) throw new LedgerError(404, "execution_result_missing");
  const content = l.readRevision(rev.id, projectId).content as {
    executionId: string; codeRevision?: string; startedAt?: string;
    results: Array<{ caseId?: string; status?: string; failure?: { code?: string } }>;
  };
  return {
    executionId: content.executionId, codeRevision: content.codeRevision, at: content.startedAt,
    results: content.results.filter((r) => r.caseId).map((r) => ({
      caseId: r.caseId!, status: (r.status ?? "failed") as CaseVerdict, ...(r.failure?.code ? { failureCode: r.failure.code } : {}),
    })),
  };
}

/** 这条 run 上按时间排好的全部执行 id。 */
export function executionIds(runId: string, projectId: string): string[] {
  return (runLedger().db.prepare("SELECT id FROM workflow_executions WHERE runId=? AND projectId=? ORDER BY startedAt").all(runId, projectId) as Array<{ id: string }>).map((r) => r.id);
}

export function setExecutionBaseline(runId: string, projectId: string, raw: unknown, by: string): ExecutionBaselineRow {
  const { executionId, note } = z.object({ executionId: z.string().min(1), note: z.string().max(2000).default("") }).parse(raw);
  executionSnapshot(runId, projectId, executionId); // 不存在就 404，别留一个指向空气的基线
  const row: ExecutionBaselineRow = { runId, projectId, executionId, note, by, at: new Date().toISOString() };
  table().db.prepare(`INSERT INTO execution_baselines VALUES (?,?,?,?,?,?)
    ON CONFLICT(runId) DO UPDATE SET executionId=excluded.executionId, note=excluded.note, by=excluded.by, at=excluded.at`)
    .run(row.runId, row.projectId, row.executionId, row.note, row.by, row.at);
  return row;
}

export const executionBaseline = (runId: string, projectId: string): ExecutionBaselineRow | undefined =>
  table().db.prepare("SELECT * FROM execution_baselines WHERE runId=? AND projectId=?").get(runId, projectId) as ExecutionBaselineRow | undefined;

/**
 * 把某次执行和基线比。
 *
 * 基线与当前之间的那些次执行也一起交给比较函数——**抖动只有靠中间那几次才看得出来**，
 * 而这个被测对象上抖动正是失败的主要成分（docs/v3/history/23 §12.5：连跑两轮都是 29/35，
 * 失败的却是不同的六条）。
 */
export function compareToBaseline(runId: string, projectId: string, raw: unknown) {
  const { executionId } = z.object({ executionId: z.string().min(1).optional() }).parse(raw ?? {});
  const base = executionBaseline(runId, projectId);
  if (!base) throw new LedgerError(409, "execution_baseline_missing");
  const all = executionIds(runId, projectId);
  const current = executionId ?? all.at(-1);
  if (!current) throw new LedgerError(404, "execution_missing");
  const bi = all.indexOf(base.executionId), ci = all.indexOf(current);
  const between = bi >= 0 && ci > bi ? all.slice(bi + 1, ci).map((id) => executionSnapshot(runId, projectId, id)) : [];
  const out = compareExecutions(executionSnapshot(runId, projectId, base.executionId), executionSnapshot(runId, projectId, current), between);
  return { baseline: base, current, between: between.length, ...out, headline: describeComparison(out.summary) };
}
