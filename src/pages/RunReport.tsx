import { useState } from "react";
import { Play } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Button, PriorityBadge, RunStatusPill } from "@/components/ui";
import { Drawer } from "@/components/overlay";
import { RunDetail, fmtDuration } from "@/components/RunDetail";
import { useT } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/cn";
import type { RunRecord } from "@/lib/types";

type Filter = "all" | "passed" | "failed";
type Origin = "all" | "suite" | "case" | "workflow";

function MetricCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl bg-muted p-4">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="font-display text-2xl font-medium text-foreground">
        {value}
      </div>
      {/* 分母改了就要说出来：悄悄缩小分母也是一种谎。 */}
      {note && <div className="mt-0.5 text-[11px] text-muted-foreground">{note}</div>}
    </div>
  );
}

/**
 * Who settled this run's verdict.
 *
 * `machine` only when a program decided every assertion it checked: one model-judged
 * assertion among ten makes the run's verdict model-judged, because that one is the weakest
 * link in it. A run with no recorded oracle says nothing rather than claiming either.
 */
function decidedBy(run: RunRecord): "machine" | "judge" | undefined {
  const checks = run.oracle ?? [];
  if (!checks.length) return undefined;
  return checks.every((c) => c.decidedBy === "machine") ? "machine" : "judge";
}

export function RunReportPage() {
  const t = useT();
  const runs = useStore((s) => s.runs);
  const runAllP0 = useStore((s) => s.runAllP0);

  const [filter, setFilter] = useState<Filter>("all");
  /**
   * Which kind of execution to count.
   *
   * The page lists workflow executions too — a case exercised only by the repair loop
   * used to leave no trace here at all, and an empty page reads as "never ran". But a
   * candidate's trial run and an approved case's run are not the same event, so they are
   * separable rather than merged.
   */
  const [origin, setOrigin] = useState<Origin>("all");
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(
    runs[0]?.id,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  const filtered = runs.filter(
    (r) =>
      (filter === "all" || r.status === filter) &&
      (origin === "all" || (r.origin ?? "case") === origin),
  );

  // Computed over what is actually shown, so the number always answers a question the
  // reader can state: "the pass rate of these rows". Averaged over a mixed set it would
  // silently blend approved cases with candidates that were still being repaired.
  const total = filtered.length;
  /**
   * 通过率不把环境失败算进分母。
   *
   * 一次模型不可达或浏览器崩掉，说明不了产品的任何事。把它算进去，通过率量的就变成
   * 「这台机器今天顺不顺」，而那个数字下降时人会去查产品——查一个没有问题的地方。
   * 被排除掉的条数单独显示，因为悄悄缩小分母也是一种谎。
   */
  const infra = filtered.filter((r) => r.failKind === "infra").length;
  const judged = filtered.filter((r) => r.failKind !== "infra");
  const passed = judged.filter((r) => r.status === "passed").length;
  const passRate = judged.length > 0 ? `${Math.round((passed / judged.length) * 100)}%` : "—";

  const p0Runs = judged.filter((r) => r.priority === "P0");
  const p0Passed = p0Runs.filter((r) => r.status === "passed").length;
  const p0PassRate =
    p0Runs.length > 0
      ? `${Math.round((p0Passed / p0Runs.length) * 100)}%`
      : "—";

  const avgDuration =
    total > 0
      ? fmtDuration(filtered.reduce((sum, r) => sum + r.durationMs, 0) / total)
      : "—";

  const selected: RunRecord | undefined =
    filtered.find((r) => r.id === selectedRunId) ??
    runs.find((r) => r.id === selectedRunId);

  const filters: Array<{ key: Filter; label: string }> = [
    { key: "all", label: t("common.all") },
    { key: "passed", label: t("status.passed") },
    { key: "failed", label: t("status.failed") },
  ];

  const counts: Record<Exclude<Origin, "all">, number> = {
    suite: runs.filter((r) => r.origin === "suite").length,
    case: runs.filter((r) => (r.origin ?? "case") === "case").length,
    workflow: runs.filter((r) => r.origin === "workflow").length,
  };
  const origins: Array<{ key: Origin; label: string }> = [
    { key: "all", label: t("runs.originAll") },
    { key: "suite", label: t("runs.origin.suite") },
    { key: "case", label: t("runs.origin.case") },
    { key: "workflow", label: t("runs.origin.workflow") },
  ];

  return (
    <>
      <TopBar
        actions={
          <Button variant="success" onClick={runAllP0}>
            <Play className="h-3.5 w-3.5" /> {t("topbar.runAllP0")}
          </Button>
        }
      />
      <div className="flex-1 overflow-auto p-4">
        {runs.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <h2 className="font-display text-sm font-medium text-foreground">
              {t("runs.noRunsYet")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("runs.noRunsHelp")}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary metrics */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <MetricCard label={t("runs.totalRuns")} value={String(total)} />
              <MetricCard
                label={t("runs.passRate")}
                value={passRate}
                note={infra ? t("runs.infraExcluded").replace("{n}", String(infra)) : undefined}
              />
              <MetricCard label={t("runs.p0PassRate")} value={p0PassRate} />
              <MetricCard label={t("runs.avgDuration")} value={avgDuration} />
            </div>

            {/* Filter row */}
            <div className="flex flex-wrap items-center gap-2">
              {filters.map((f) => (
                <Button
                  key={f.key}
                  variant={filter === f.key ? "primary" : "outline"}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </Button>
              ))}
              <span className="mx-1 h-5 w-px bg-border" />
              {origins.map((o) => (
                <button
                  key={o.key}
                  onClick={() => setOrigin(o.key)}
                  title={o.key === "all" ? undefined : t(`runs.originWhy.${o.key}`)}
                  className={cn(
                    "cursor-pointer rounded-full border px-2.5 py-0.5 text-[11.5px]",
                    origin === o.key
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted",
                  )}
                >
                  {o.label}
                  {o.key !== "all" && ` · ${counts[o.key]}`}
                </button>
              ))}
            </div>

            {/* Run list — full width; clicking a run opens the detail Drawer. */}
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {filtered.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  {t("runs.noRunsMatch")}
                </p>
              ) : (
                filtered.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => {
                      setSelectedRunId(r.id);
                      setDrawerOpen(true);
                    }}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-muted/60",
                      r.id === selected?.id && drawerOpen && "bg-muted",
                    )}
                  >
                    <RunStatusPill status={r.status} />
                    <PriorityBadge priority={r.priority} />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {r.caseTitle}
                    </span>
                    {/* Who settled it. A pass a program checked and a pass a model judged
                        from a screenshot are not the same kind of green, and the list is
                        where that difference has to be visible — opening thirty runs to
                        find out is how "all green" gets believed. */}
                    {decidedBy(r) && (
                      <span
                        title={t(`runs.decidedByWhy.${decidedBy(r)}`)}
                        className={cn(
                          "shrink-0 rounded px-1.5 py-0.5 text-[10.5px]",
                          decidedBy(r) === "machine"
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {t(`runs.decidedBy.${decidedBy(r)}`)}
                      </span>
                    )}
                    {/* 环境失败不是产品缺陷。
                        这是这套东西里最贵的一次区分（见 failure.ts）：一次模型不可达或
                        浏览器崩掉造成的红，和一次断言没过造成的红，在这张表里必须分得开——
                        否则「通过率 67%」会被当成产品坏了三处，而实际上产品一处都没坏。 */}
                    {r.failKind === "infra" && (
                      <span
                        title={`${t("runs.infraWhy")}${r.failCode ? ` · ${r.failCode}` : ""}`}
                        className="shrink-0 rounded bg-slate-500/15 px-1.5 py-0.5 text-[10.5px] text-slate-600 dark:text-slate-300"
                      >
                        {t("runs.infra")}
                      </span>
                    )}
                    {/* A candidate's trial run is not an approved case's run. Saying so on
                        the row is what keeps the two from being read as one history. */}
                    {(r.origin ?? "case") === "workflow" && (
                      <span
                        title={`${t("runs.originWhy.workflow")}${r.wfRunId ? ` · ${r.wfRunId}` : ""}`}
                        className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10.5px] text-sky-700 dark:text-sky-400"
                      >
                        {t("runs.origin.workflow")}
                      </span>
                    )}
                    {r.attempts && r.attempts > 1 && (
                      <span
                        title={t("runs.retriedWhy")}
                        className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10.5px] text-amber-700 dark:text-amber-400"
                      >
                        ×{r.attempts}
                      </span>
                    )}
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {fmtDuration(r.durationMs)}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {new Date(r.startedAt).toLocaleTimeString()}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <Drawer
        open={drawerOpen && !!selected}
        onClose={() => setDrawerOpen(false)}
        title={selected?.caseTitle}
      >
        {selected && <RunDetail run={selected} />}
      </Drawer>
    </>
  );
}
