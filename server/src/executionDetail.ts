import { readExecutionObservation, ExecutionAttemptSchema } from '@testpilot/harness-core/execution-observation';
/**
 * 一次执行的明细：每条用例的执行过程，连同它那条运行记录上的视觉基线、性能基线与 Midscene 报告。
 *
 * 执行产物（`execution/<id>`）里有步骤日志、截图路径、分段墙钟、判据结果；视觉与性能的比对、
 * 以及 Midscene 报告，落在 `runs` 表的那条运行记录上（`workflowRunRecord.ts`）。两边原来没有
 * 连起来：产物里不记运行记录的 id，运行记录上也没截报告。界面想把一条用例的「过程 · 视觉 ·
 * 性能 · 报告」放在一处，就得在这里对上。
 *
 * 对应规则：新执行的产物里直接带 `runRecordId`；老执行没有，按「板上用例 id + 运行 + 开始时间」
 * 找回来——板上用例 id 由批准的修订派生，和 `decisionDelivery` 同一个算法。
 */
import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { runLedger } from "./runService.js";
import { contentHash, LedgerError } from "./runLedger.js";
import { db, getRun, updateRunResults, ARTIFACT_DIR } from "./db.js";
import { midsceneDirFor } from "./procs.js";

type Any = any; // 执行与代码产物是各自的 schema，这里只读几个字段。

/**
 * 给老执行补截 Midscene 报告。
 *
 * 报告文件一条用例一个，**在第一次调模型时才创建**（纯导航、纯程序判据的用例可能没有）。
 * 文件名里的时间就是创建时间。只取创建时间落在 [这条开始, 下一条开始) 里的那个——
 * 不能像执行刚结束时那样取「最新的一个」，那时后面的用例还没跑，现在已经跑过了。
 */
export function findReportInWindow(dir: string, fromMs: number, toMs: number): string | undefined {
  if (!existsSync(dir)) return undefined;
  let best: { path: string; created: number } | undefined;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".html")) continue;
    const path = join(dir, name);
    let created: number;
    try {
      const st = statSync(path);
      created = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    } catch { continue; }
    if (created < fromMs || created >= toMs) continue;
    if (!best || created < best.created) best = { path, created };
  }
  return best?.path;
}

export function executionDetail(runId: string, projectId: string, executionId: string) {
  const ledger = runLedger();
  ledger.requireRun(runId, projectId);
  const row = ledger.db.prepare("SELECT id,status,codeRevision,resultRevision,startedAt FROM workflow_executions WHERE runId=? AND id=?")
    .get(runId, executionId) as { id: string; status: string; codeRevision: string; resultRevision: string | null; startedAt: string } | undefined;
  if (!row) throw new LedgerError(404, "execution_not_found");
  const artifact: Any = row.resultRevision ? ledger.readRevision(row.resultRevision, projectId).content : undefined;
  const code: Any = ledger.readRevision(row.codeRevision, projectId).content;

  // caseId → 这次执行编译自的那一版批准修订 → 板上用例 id
  const approved = new Map<string, { revisionId: string; content: Any }>();
  for (const ref of (code.approvedRevisions ?? []) as string[]) {
    const content = ledger.readRevision(ref, projectId).content as Any;
    if (content?.id) approved.set(content.id, { revisionId: ref, content });
  }
  const results: Any[] = (artifact?.results ?? []).filter((r: Any) => r?.caseId);
  const starts = results.map((r) => (typeof r.sinceMs === "number" ? r.sinceMs : Date.parse(r.startedAt ?? "")) || 0);

  const cases = results.map((r, i) => {
    const source = approved.get(r.caseId);
    const boardCaseId = source ? `tc-rev-${contentHash(source.revisionId).slice(0, 24)}` : null;
    let runRecordId: string | undefined = typeof r.runRecordId === "string" ? r.runRecordId : undefined;
    if (!runRecordId && boardCaseId && r.startedAt) {
      const hit = db.prepare("SELECT id FROM runs WHERE caseId=? AND wfRunId=? AND startedAt=? ORDER BY rowid DESC LIMIT 1")
        .get(boardCaseId, runId, r.startedAt) as { id: string } | undefined;
      runRecordId = hit?.id;
    }
    let record = runRecordId ? getRun(runRecordId) : undefined;

    // 老执行没截报告：按创建时间窗口补一次，截到了就落到运行记录上，下次不用再找。
    if (record && !record.reportPath && typeof r.sinceMs === "number" && typeof r.runnerId === "string") {
      const next = starts.slice(i + 1).find((s) => s > r.sinceMs);
      const until = next ?? r.sinceMs + (Number(r.durationMs) || 0) + 60_000;
      const found = findReportInWindow(resolve(midsceneDirFor(r.runnerId), "report"), r.sinceMs, until);
      if (found) {
        const dest = resolve(ARTIFACT_DIR, "reports", `${record.id}.html`);
        mkdirSync(resolve(ARTIFACT_DIR, "reports"), { recursive: true });
        copyFileSync(found, dest);
        updateRunResults(record.id, { reportPath: dest });
        record = getRun(record.id);
      }
    }

    const { logs, oracle, phases, perfMetrics, pngPaths, modelRequests, ...rest } = r;
    return {
      caseId: r.caseId as string,
      title: (source?.content?.title ?? r.caseId) as string,
      steps: (source?.content?.steps ?? []) as string[],
      postSteps: (source?.content?.postSteps ?? []) as string[],
      status: r.status as string,
      infraError: !!r.infraError,
      failure: r.failure ?? null,
      failureReason: r.failureReason ?? null,
      durationMs: r.durationMs ?? null,
      startedAt: r.startedAt ?? null,
      entryUrl: r.entryUrl ?? null,
      endedAt: r.endedAt ?? null,
      logs: (logs ?? []) as string[],
      oracle: (oracle ?? []) as unknown[],
      phases: phases ?? null,
      perfMetrics: perfMetrics ?? null,
      screenshots: ((pngPaths ?? []) as string[]).map((p) => p.split("/artifacts/")[1]).filter((p): p is string => !!p && /^exec\/[\w.-]+\.png$/.test(p)),
      observation: readExecutionObservation(r.observation),
      attempts: Array.isArray(r.attempts) ? r.attempts.flatMap((a:unknown)=>{const parsed=ExecutionAttemptSchema.safeParse(a);return parsed.success?[parsed.data]:[];}) : undefined,
      modelCalls: Array.isArray(modelRequests) && modelRequests.every(r=>typeof r.forwarded==='boolean') ? modelRequests.filter(r=>r.forwarded===true).length : null,
      boardCaseId,
      run: record ? {
        id: record.id,
        visual: record.visual ?? [],
        perf: record.perf ?? null,
        tokens: record.tokens ?? null,
        reportUrl: record.reportPath && existsSync(record.reportPath) ? `/api/runs/${record.id}/report` : null,
      } : null,
      extra: rest,
    };
  });
  return {
    execution: { id: row.id, status: row.status, codeRevision: row.codeRevision, resultRevision: row.resultRevision, startedAt: row.startedAt, finishedAt: artifact?.finishedAt ?? null, selection: artifact?.selection ?? null },
    cases,
  };
}
