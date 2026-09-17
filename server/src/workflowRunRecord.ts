import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contentHash } from "./runLedger.js";
import { captureMidsceneReport, comparePerf, type PerfMetrics } from "@testpilot/harness-testing";
import { config, midsceneDirFor } from "./procs.js";
import { createRun, getCase, getPerfBaseline, upsertPerfBaseline, updateRunResults, ARTIFACT_DIR } from "./db.js";
import { processVisual } from "./visualBaseline.js";
import { reviewRevisions } from "./approvedRuns.js";

/**
 * 把工作流执行的每条结果落成一条**运行记录**，顺带走视觉与性能基线。
 *
 * 在此之前这条链路上一条运行记录都没有：`runs` 表只被旧的单用例路径写，于是
 * 界面上那页「运行 · 待审批基线」永远是空的——用户看到的「基线还是没有」就是它。
 * 执行明明每步都截了图（`pngPaths`），也量了分段墙钟，只是没人把它们接到基线上。
 *
 * **基线按板上用例的 id 立**，不是按文本用例 id：板 id 从批准的那个修订派生，
 * 所以用例改一版就是新的一条、不会继承上一版的截图基线——那正是我们要的，
 * 拿旧版的截图给改过的用例当基线，第一次跑就会红得莫名其妙。
 */
export function recordWorkflowCaseRun(input: {
  runId: string; projectId: string; executionId: string;
  visualThresholdPct?: number;
  result: { caseId: string; status: string; durationMs?: number; startedAt?: string; failureReason?: string;
    logs?: string[]; oracle?: unknown; infraError?: boolean; failure?: { code?: string; attribution?: string };
    pngPaths?: string[]; perfMetrics?: PerfMetrics; sinceMs?: number; runnerId?: string };
}): string | undefined {
  const { runId, projectId, executionId, result, visualThresholdPct } = input;
  if (!result.caseId || result.status === "not_run") return undefined;
  // 文本用例 id → 这次批准的修订 → 板上那条。板 id 的算法和 decisionDelivery 一致。
  const reviewed = reviewRevisions(runId, projectId).find((c) => c.caseId === result.caseId);
  if (!reviewed?.approval) return undefined;
  const boardId = `tc-rev-${contentHash(reviewed.revision.id).slice(0, 24)}`;
  const board = getCase(boardId);
  if (!board) return undefined;

  const metrics = result.perfMetrics ?? ({} as PerfMetrics);
  const perf = comparePerf(metrics, getPerfBaseline(boardId), config.perfBudget);
  if (perf.status === "new_baseline" && Object.keys(metrics).length > 0) upsertPerfBaseline(boardId, metrics);

  const run = createRun({
    caseId: boardId, caseTitle: board.title, projectId, priority: board.priority,
    status: result.status, durationMs: result.durationMs ?? 0, startedAt: result.startedAt ?? new Date().toISOString(),
    failureReason: result.failureReason, logs: result.logs ?? [], screenshots: [],
    oracle: result.oracle as never, perf, infraError: !!result.infraError,
    failCode: result.failure?.code, failKind: result.failure?.attribution as never,
    origin: "workflow", wfRunId: runId,
  } as never);

  // 截图在 runner 那边已经落盘，这里按路径读回来立/比基线。读不到的就跳过，不编一张空图。
  const buffers = (result.pngPaths ?? []).filter((p) => existsSync(p)).map((p) => readFileSync(p));
  const visual = buffers.length ? processVisual(boardId, `${executionId}-${run.id}`, buffers, visualThresholdPct) : [];
  /**
   * Midscene 报告：这条刚跑完，这个 runner 上还没有后来的运行，取窗口里最新的那份就是它。
   * 没调过模型的用例（纯导航、纯程序判据）不会有报告，那就不截——不拿上一条的顶替。
   */
  let reportPath: string | undefined;
  if (typeof result.sinceMs === "number" && result.runnerId) {
    const dir = midsceneDirFor(result.runnerId);
    if (existsSync(resolve(dir, "report")))
      reportPath = captureMidsceneReport({ midsceneDir: dir, sinceMs: result.sinceMs, untilMs: result.sinceMs + (result.durationMs ?? 0) + 1000,
        destPath: resolve(ARTIFACT_DIR, "reports", `${run.id}.html`) }).reportPath;
  }
  updateRunResults(run.id, { visual, perf, oracle: result.oracle as never, ...(reportPath ? { reportPath } : {}) });
  return run.id;
}
