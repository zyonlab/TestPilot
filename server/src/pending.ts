import {
  getBaseline,
  listCases,
  listRunsByProject,
  perfBaselineUpdatedAt,
  type RunRecord,
} from "./db.js";

/**
 * 待审批基线：差异摆在那里，等一个人看过。
 *
 * 视觉与性能基线是这套系统里**唯一还需要人点头**的东西——门禁是打分的，复核队列管的是文本用例，
 * 而"这次界面变了 8.5% 是改版还是回归"没有程序能替人回答。批准入口一直长在执行详情里
 * （每条差异旁边），这没错；缺的是**一份清单**：没人会为了找出哪几条在等自己，去逐个点开三十次运行。
 *
 * 判定「还在等」的方式是时间戳比较，不是另立一张表：
 *   - 视觉：某条用例最近一次运行里某一步是 `diff`，而这一步的基线图在那次运行之后没有被更新过。
 *   - 性能：最近一次运行是 `regression`，而性能基线在那次运行之后没有被更新过。
 * 批准会写基线的 `updatedAt`，所以"批过了"这件事本来就记录在案，不需要再存一个"已读"标记——
 * 多一张表就多一处会和事实不一致的地方。
 *
 * 只看**每条用例最近一次**运行：三周前的一次差异如果后来跑绿了，它不是待办，是历史。
 */

export interface PendingVisual {
  kind: "visual";
  caseId: string;
  caseTitle: string;
  runId: string;
  at: string;
  stepIdx: number;
  mismatchPct: number;
  baselineRef?: string;
  currentRef?: string;
  diffRef?: string;
  /** True when there is no baseline at all yet — accepting it establishes the first one. */
  first: boolean;
}

export interface PendingPerf {
  kind: "perf";
  caseId: string;
  caseTitle: string;
  runId: string;
  at: string;
  metrics: Record<string, number>;
  baseline?: Record<string, number>;
  /** Only the metrics that actually regressed, so the row says what got worse. */
  worse: Array<{ metric: string; now: number; was: number }>;
}

interface VisualStep {
  stepIdx: number;
  status: string;
  mismatchPct?: number;
  baselineRef?: string;
  currentRef?: string;
  diffRef?: string;
}

interface PerfShape {
  status?: string;
  metrics?: Record<string, number>;
  baseline?: Record<string, number>;
}

const newest = (runs: RunRecord[]): Map<string, RunRecord> => {
  const byCase = new Map<string, RunRecord>();
  for (const r of runs) {
    const prev = byCase.get(r.caseId);
    if (!prev || r.startedAt > prev.startedAt) byCase.set(r.caseId, r);
  }
  return byCase;
};

export function pendingBaselines(projectId: string): {
  visual: PendingVisual[];
  perf: PendingPerf[];
} {
  const titles = new Map(listCases(projectId).map((c) => [c.id, c.title]));
  const latest = newest(listRunsByProject(projectId));
  const visual: PendingVisual[] = [];
  const perf: PendingPerf[] = [];

  for (const run of latest.values()) {
    const caseTitle = titles.get(run.caseId) ?? run.caseTitle;

    for (const step of (run.visual ?? []) as VisualStep[]) {
      // `new_baseline` means the run wrote the first image itself; there was nothing to
      // compare against, so there is no decision waiting.
      if (step.status !== "diff") continue;
      const bl = getBaseline(run.caseId, step.stepIdx);
      if (bl && bl.updatedAt > run.startedAt) continue; // approved since this run
      visual.push({
        kind: "visual",
        caseId: run.caseId,
        caseTitle,
        runId: run.id,
        at: run.startedAt,
        stepIdx: step.stepIdx,
        mismatchPct: step.mismatchPct ?? 0,
        baselineRef: step.baselineRef,
        currentRef: step.currentRef,
        diffRef: step.diffRef,
        first: !bl,
      });
    }

    const p = run.perf as PerfShape | undefined;
    if (p?.status === "regression") {
      const at = perfBaselineUpdatedAt(run.caseId);
      if (!at || at <= run.startedAt) {
        const metrics = p.metrics ?? {};
        const baseline = p.baseline ?? {};
        perf.push({
          kind: "perf",
          caseId: run.caseId,
          caseTitle,
          runId: run.id,
          at: run.startedAt,
          metrics,
          baseline: p.baseline,
          worse: Object.entries(metrics)
            .filter(([m, now]) => baseline[m] !== undefined && now > baseline[m])
            .map(([metric, now]) => ({ metric, now, was: baseline[metric] })),
        });
      }
    }
  }

  const byTime = (a: { at: string }, b: { at: string }) => (a.at < b.at ? 1 : -1);
  return { visual: visual.sort(byTime), perf: perf.sort(byTime) };
}
