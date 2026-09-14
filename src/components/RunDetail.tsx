import { useState } from "react";
import {
  AlertTriangle,
  Image,
  Clock,
  ExternalLink,
  Check,
  X,
  Eye,
  Gauge,
  CheckSquare,
  Wand2,
} from "lucide-react";
import { PriorityBadge, RunStatusPill } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import type { RunRecord, VisualDiff } from "@/lib/types";
import { API_BASE } from "@/lib/base";

const API = API_BASE;

export function fmtDuration(ms: number): string {
  return (Math.round(ms / 100) / 10).toFixed(1) + "s";
}

// Functional oracle: the explicit assertions verified for this run (pass/fail).
function OracleSection({ run }: { run: RunRecord }) {
  const t = useT();
  const oracle = run.oracle ?? [];
  if (!oracle.length) return null;
  const failed = oracle.filter((o) => o.status === "fail").length;
  return (
    <div className="mt-4">
      <h3 className="flex items-center gap-1.5 font-display text-xs font-medium text-foreground">
        <CheckSquare className="h-3.5 w-3.5" /> {t("runs.functionalOracle")}
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[0.6875rem] font-medium",
            failed ? "bg-bad-soft text-bad" : "bg-ok-soft text-ok",
          )}
        >
          {failed ? `${failed} ${t("runs.failedCount")}` : t("status.passed")}
        </span>
      </h3>
      <div className="mt-1.5 space-y-1">
        {oracle.map((o, i) => (
          <div
            key={i}
            className={cn(
              "flex items-start gap-1.5 rounded-md p-2 text-xs",
              o.status === "pass" ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad",
            )}
          >
            {o.status === "pass" ? (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span>
              {o.assertion}
              {o.detail ? ` — ${o.detail}` : ""}
              {/*"Passed" means two different things depending on who decided, and a
                  report that hides which one cannot be argued with. */}
              {o.decidedBy && (
                <span className="ml-1.5 rounded bg-accent px-1 py-0.5 font-mono text-[0.6875rem] ">
                  {t(`runs.decidedBy.${o.decidedBy}`)}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Performance baseline: per-metric current vs baseline with % delta; regressions flagged.
const PERF_LABELS: Record<string, string> = {
  ttfbMs: "TTFB",
  fcpMs: "FCP",
  domContentLoadedMs: "DCL",
  loadMs: "Load",
};
function PerfSection({ run }: { run: RunRecord }) {
  const t = useT();
  const perf = run.perf;
  if (!perf || !perf.verdicts?.length) return null;
  return (
    <div className="mt-4">
      <h3 className="flex items-center gap-1.5 font-display text-xs font-medium text-foreground">
        <Gauge className="h-3.5 w-3.5" /> {t("runs.performance")}
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[0.6875rem] font-medium",
            perf.status === "regression"
              ? "bg-bad-soft text-bad"
              : perf.status === "new_baseline"
                ? "bg-muted text-muted-foreground"
                : "bg-ok-soft text-ok",
          )}
        >
          {perf.status === "regression"
            ? t("runs.regression")
            : perf.status === "new_baseline"
              ? t("runs.baselineSet")
              : t("runs.withinBudget")}
        </span>
      </h3>
      <table className="mt-1.5 w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left font-normal">{t("runs.metricMetric")}</th>
            <th className="text-right font-normal">{t("runs.metricCurrent")}</th>
            <th className="text-right font-normal">{t("runs.metricBaseline")}</th>
            <th className="text-right font-normal">Δ</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {perf.verdicts.map((v) => (
            <tr key={v.metric} className={cn(v.status === "regression" && "text-bad")}>
              <td className="py-0.5 font-sans">{PERF_LABELS[v.metric] ?? v.metric}</td>
              <td className="py-0.5 text-right">{v.current}ms</td>
              <td className="py-0.5 text-right text-muted-foreground">
                {typeof v.baseline === "number" ? `${v.baseline}ms` : "—"}
              </td>
              <td className="py-0.5 text-right">
                {typeof v.deltaPct === "number" ? `${v.deltaPct > 0 ? "+" : ""}${v.deltaPct}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {perf.status === "new_baseline" && (
        <p className="mt-1 text-xs text-muted-foreground">{t("runs.perfNewBaseline")}</p>
      )}
    </div>
  );
}

// Visual-baseline results for a run: per-step baseline|current|diff with mismatch %, and an
//"Approve" that promotes the current image to the new baseline (accept the change).
function VisualSection({ run }: { run: RunRecord }) {
  const t = useT();
  const [approved, setApproved] = useState<Record<number, boolean>>({});
  const visual = run.visual ?? [];
  if (!visual.length) return null;
  const changed = visual.filter((v) => v.status === "diff");
  const newBaselines = visual.filter((v) => v.status === "new_baseline").length;

  const approve = async (v: VisualDiff) => {
    try {
      await fetch(`${API}/api/cases/${run.caseId}/baselines/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepIdx: v.stepIdx, ref: v.currentRef }),
      });
      setApproved((a) => ({ ...a, [v.stepIdx]: true }));
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="mt-4">
      <h3 className="flex items-center gap-1.5 font-display text-xs font-medium text-foreground">
        <Eye className="h-3.5 w-3.5" /> {t("runs.visualBaseline")}
        {changed.length > 0 ? (
          <span className="rounded bg-bad-soft px-1.5 py-0.5 text-[0.6875rem] font-medium text-bad">
            {changed.length} {changed.length > 1 ? t("runs.visualRegressions") : t("runs.visualRegression")}
          </span>
        ) : newBaselines > 0 ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
            {newBaselines} {newBaselines > 1 ? t("runs.baselinesEstablished") : t("runs.baselineEstablished")}
          </span>
        ) : (
          <span className="rounded bg-ok-soft px-1.5 py-0.5 text-[0.6875rem] font-medium text-ok">
            {t("runs.allMatch")}
          </span>
        )}
      </h3>

      {changed.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {newBaselines > 0 ? t("runs.visualFirstRun") : t("runs.noVisualDiff")}
        </p>
      ) : (
        <div className="mt-1.5 space-y-3">
          {changed.map((v) => (
            <div key={v.stepIdx} className="rounded-md border border-border p-2">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-bad">
                  {t("runs.step")} {v.stepIdx + 1} · {v.mismatchPct.toFixed(2)}% {t("runs.stepChanged")}
                </span>
                {approved[v.stepIdx] ? (
                  <span className="flex items-center gap-1 text-xs text-ok">
                    <Check className="h-3.5 w-3.5" /> {t("runs.baselineUpdated")}
                  </span>
                ) : (
                  <button
                    onClick={() => approve(v)}
                    className="cursor-pointer rounded border border-border px-2 py-0.5 text-xs hover:bg-muted"
                  >
                    {t("runs.approveAsBaseline")}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { label: "baseline", tkey: "runs.metricBaseline", ref: v.baselineRef },
                  { label: "current", tkey: "runs.metricCurrent", ref: v.currentRef },
                  { label: "diff", tkey: "runs.diff", ref: v.diffRef },
                ].map((col) => (
                  <div key={col.label}>
                    {col.ref ? (
                      <img
                        src={`${API}/api/artifacts/${col.ref}`}
                        alt={col.label}
                        className={cn(
                          "aspect-video w-full rounded border object-cover object-top",
                          col.label === "diff" ? "border-bad" : "border-border",
                        )}
                      />
                    ) : (
                      <div className="aspect-video rounded bg-muted" />
                    )}
                    <span className="text-[0.6875rem] text-muted-foreground">{t(col.tkey)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The full run-detail content (previously an inline right column). Relocated
// unchanged into the Drawer body. Exported so both the Runs page and the Suite
// drill-down render the identical detail UI.
/**
 * 一张截图怎么变成一个能加载的地址。
 *
 * 两种来源并存，而且会长期并存：看板上的单跑把截图存成 data URI（历史如此），
 * 工作流里的执行存的是 `exec/<execId>-<i>.png` 这样的相对路径——存路径是对的，
 * data URI 会让 testpilot.db 从 192K 涨到几十 MB。所以这里按形状分辨，
 * 而不是给存储加一个「类型」字段：形状本身已经说清楚了。
 */
const shotSrc = (ref: string): string =>
  ref.startsWith("data:") || ref.startsWith("http") ? ref : `${API_BASE}/api/artifacts/${ref}`;

/**
 * 归因标签之后的那一步。
 *
 * 三档归因早就算好了、行上标了、详情里也标了，**可标签之后是死路**：三个去处
 * 在这里一个入口都没有，人得自己记住 caseId、关掉抽屉、切到看板再把那一条找回来。
 *
 * 三档各有各的下一步，而且**故意不一样**：
 * - infra：没有判决，什么都别改，重跑就是了。这条路上不放任何能改用例文本的入口——
 *   一次环境抖动引出一次「顺手把断言改松」，是这套东西最容易坏掉的方式。
 * - locate（含 EXEC_PLAN）：是措辞问题。EXEC_PLAN 尤其吃亏——它是「用例写成了目标
 *   而不是动作」造成的失败，最该做的就是回去改那一句，而界面上它此前只是一枚灰码。
 * - assert：这是**判决**。重跑只会得到同一个判决，该看的是断言与实际的差。
 */
function NextStep({ run }: { run: RunRecord }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const kind = run.failKind;
  const go = (field: string) => {
    window.location.hash = `#/?open=cases&case=${encodeURIComponent(run.caseId)}&field=${field}`;
  };

  if (kind === "infra")
    return (
      <div className="mt-2 flex items-center gap-2 text-xs">
        <button
          className="cursor-pointer rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          disabled={busy}
          title={t("runs.nextInfraWhy")}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await fetch(`${API}/api/cases/${run.caseId}/run`, { method: "POST" });
              setNote(res.ok ? t("runs.nextInfraSent") : t("runs.nextInfraFailed"));
            } catch {
              setNote(t("runs.nextInfraFailed"));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("runs.nextInfra")}
        </button>
        <span className="text-muted-foreground">{note || t("runs.nextInfraWhy")}</span>
      </div>
    );

  return (
    <div className="mt-2 flex items-center gap-2 text-xs">
      <button
        className="cursor-pointer rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
        onClick={() => go(kind === "assert" ? "oracle" : "steps")}
        title={kind === "assert" ? t("runs.nextAssertWhy") : t("runs.nextLocateWhy")}
      >
        {kind === "assert" ? t("runs.nextAssert") : t("runs.nextLocate")}
      </button>
      <span className="text-muted-foreground">
        {kind === "assert" ? t("runs.nextAssertWhy") : t("runs.nextLocateWhy")}
      </span>
    </div>
  );
}

export function RunDetail({ run }: { run: RunRecord }) {
  const t = useT();
  return (
    <div className="p-4">
      <div className="flex items-center gap-2">
        {/* 候选没有看板优先级，存的那个 P2 是 graphs.ts 的占位。列表上说「—」，
            详情里再说一遍 P2，等于让人在两处看到两个互相矛盾的说法。 */}
        {(run.origin ?? "case") === "workflow" ? (
          <span
            title={t("artifact.noPriorityWhy")}
            className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
          >
            —
          </span>
        ) : (
          <PriorityBadge priority={run.priority} />
        )}
        <RunStatusPill status={run.status} />
        {run.healed && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium bg-chat-soft text-chat">
            <Wand2 className="h-3 w-3" /> {t("runs.selfHealed")}
            {typeof run.attempts === "number" ? ` (${run.attempts} ${t("runs.attempts")})` : ""}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          <span className="font-mono">{fmtDuration(run.durationMs)}</span>
        </span>
        <span>· {new Date(run.startedAt).toLocaleTimeString()}</span>
        {typeof run.tokens === "number" && (
          <span>
            · {run.tokens.toLocaleString()} {t("runs.tokens")}
          </span>
        )}
      </div>

      {run.reportPath && (
        <a
          href={`${API}/api/runs/${run.id}/report`}
          target="_blank"
          rel="noreferrer"
          className="mt-3 flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t("runs.openReport")}
        </a>
      )}

      <OracleSection run={run} />
      <PerfSection run={run} />
      <VisualSection run={run} />

      {run.failureReason && (
        // An infra failure is coloured differently on purpose: it means"no verdict", not
        //"the product is broken", and treating the two alike is how a report loses trust.
        <div
          className={cn(
            "mt-3 flex items-start gap-1.5 rounded-md p-2.5 text-xs",
            run.failKind === "infra" ? "bg-warn-soft text-warn" : "bg-bad-soft text-bad",
          )}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {run.failKind && (
              <span className="mr-1.5 rounded bg-accent px-1 py-0.5 font-mono text-[0.6875rem] ">
                {run.failCode ?? run.failKind}
              </span>
            )}
            {run.failKind === "infra" && <span className="mr-1">{t("runs.infraFailure")}</span>}
            {run.failureReason}
          </span>
        </div>
      )}

      {run.failKind && run.caseId && <NextStep run={run} />}

      {/*
        空的时候说清楚为什么空，而不是画几个占位框。
        此前这里在 `screenshots` 为空时回落成 `[null,null,null,null]`，画出四个灰块标着
        「步骤 1..4」——读的人会以为图还在加载，事实是**这里永远不会有图**：
        `ExecOutcome` 里就没有截图字段，`graphs.ts` 只能写死一个空数组。
        一个画着假占位的空态，比一句诚实的「没有」更伤人：它让人等一件不会发生的事。
      */}
      {run.logs.length > 0 && (
        <div className="mt-4">
          <h3 className="font-display text-xs font-medium text-foreground">{t("runs.stepsLogs")}</h3>
          <div className="mt-1.5 space-y-0.5">
            {run.logs.map((line, i) => (
              <div key={i} className="font-mono text-xs text-muted-foreground">
                {line}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4">
        <h3 className="flex items-center gap-1.5 font-display text-xs font-medium text-foreground">
          <Image className="h-3.5 w-3.5" /> {t("runs.screenshots")}
        </h3>
        {run.screenshots && run.screenshots.length > 0 ? (
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            {run.screenshots.map((shot, i) => (
              <div key={i}>
                <img
                  src={shotSrc(shot)}
                  alt={`${t("runs.step")} ${i + 1}`}
                  className="aspect-video w-full rounded-md border border-border object-cover"
                />
                <span className="text-xs text-muted-foreground">
                  {t("runs.step")} {i + 1}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-1.5 rounded-md border border-dashed border-border p-2.5 text-xs text-muted-foreground">
            {(run.origin ?? "case") === "workflow" ? t("runs.noShotsWorkflow") : t("runs.noShots")}
          </p>
        )}
      </div>
    </div>
  );
}
