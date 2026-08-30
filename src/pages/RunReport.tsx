import { Fragment, useState } from "react";
import { Play } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Button, PriorityBadge as BoardPriorityBadge, RunStatusPill } from "@/components/ui";
import { RunDetail, fmtDuration } from "@/components/RunDetail";
import { ChevronDown, ChevronRight } from "lucide-react";
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

/**
 * 同一条用例的多次执行，收成一组。
 *
 * 「一行一次执行」这个存储决定是对的（见 graphs.ts 的注释：只留最后一次会抹掉修复循环
 * 本身要展示的东西）。但**展示**照抄存储就出了问题：修复循环重跑三轮的用例在这张表里
 * 是三行同名同状态的记录，读的人看不出哪一行是重试，只会以为这条用例失败了三次。
 *
 * 所以分组在这一层做：主行是最终结论，展开才看每一轮。
 * 排序按最近一次执行的时间——人找的是「刚才那条」，不是「最早那条」。
 */
interface RunGroup {
  caseId: string;
  caseTitle: string;
  attempts: RunRecord[];
  latest: RunRecord;
}

function groupByCase(runs: RunRecord[]): RunGroup[] {
  const byCase = new Map<string, RunRecord[]>();
  for (const r of runs) {
    // caseId 可能为空（早期的单跑记录），那就退回用 id 本身，让它自成一组——
    // 强行按标题合并会把两条同名但不同来源的执行混成一条历史。
    const key = r.caseId || r.id;
    byCase.set(key, [...(byCase.get(key) ?? []), r]);
  }
  const groups: RunGroup[] = [];
  for (const [caseId, list] of byCase) {
    const attempts = [...list].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    groups.push({ caseId, caseTitle: attempts[0]!.caseTitle, attempts, latest: attempts[0]! });
  }
  return groups.sort((a, b) => Date.parse(b.latest.startedAt) - Date.parse(a.latest.startedAt));
}

/**
 * 一行上的那几枚标签。主行与展开的每一轮共用——两处各写一遍，迟早只在一处修 bug。
 */
function RowChips({ r, t }: { r: RunRecord; t: (k: string, v?: Record<string, string | number>) => string }) {
  const by = decidedBy(r);
  return (
    <>
      {/* Who settled it. A pass a program checked and a pass a model judged from a
          screenshot are not the same kind of green, and the list is where that difference
          has to be visible — opening thirty runs to find out is how "all green" gets believed. */}
      {by && (
        <span
          title={t(`runs.decidedByWhy.${by}`)}
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[10.5px]",
            by === "machine"
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          {t(`runs.decidedBy.${by}`)}
        </span>
      )}
      {/* 环境失败不是产品缺陷。
          这是这套东西里最贵的一次区分（见 failure.ts）：一次模型不可达或浏览器崩掉
          造成的红，和一次断言没过造成的红，在这张表里必须分得开——否则「通过率 67%」
          会被当成产品坏了三处，而实际上产品一处都没坏。 */}
      {r.failKind === "infra" && (
        <span
          title={`${t("runs.infraWhy")}${r.failCode ? ` · ${r.failCode}` : ""}`}
          className="shrink-0 rounded bg-slate-500/15 px-1.5 py-0.5 text-[10.5px] text-slate-600 dark:text-slate-300"
        >
          {t("runs.infra")}
        </span>
      )}
      {/* A candidate's trial run is not an approved case's run. Saying so on the row is
          what keeps the two from being read as one history. */}
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
    </>
  );
}

/**
 * 优先级那一格。
 *
 * 工作流来源的执行记录里存的是 `graphs.ts` 写死的 "P2"，而那行代码旁边的注释写得很清楚：
 * 候选没有看板优先级，声称一个就是在编造事实。代码已经拒绝编造，界面不该替它编——
 * 所以这里显示「—」，并说明为什么。
 */
function PriorityBadge({ run }: { run: RunRecord }) {
  const t = useT();
  if ((run.origin ?? "case") === "workflow")
    return (
      <span
        title={t("artifact.noPriorityWhy")}
        className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      >
        —
      </span>
    );
  return <BoardPriorityBadge priority={run.priority} />;
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
  const [q, setQ] = useState("");

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = runs.filter((r) => {
    if (filter !== "all" && r.status !== filter) return false;
    if (origin !== "all" && (r.origin ?? "case") !== origin) return false;
    if (!words.length) return true;
    // 失败原因一起搜：查一类失败（「找不到元素」）比查一条用例名更常见。
    const hay = `${r.caseTitle} ${r.caseId} ${r.failureReason ?? ""} ${r.failCode ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const groups = groupByCase(filtered);

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

  const detailOpen = drawerOpen && !!selectedRunId;
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
              <input
                className="w-56 rounded-md border border-border bg-card px-2 py-1 text-[12px]"
                placeholder={t("runs.searchPlaceholder")}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
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

            {/*
              列表与详情并排，而不是详情再叠一层抽屉。
              画布 → 执行记录抽屉 → 失败详情抽屉是三层，两个关闭按钮，没有面包屑，
              背后那层还能滚——而复核失败时人要做的事恰恰是**来回比对十几条**，
              每比一条开关一次抽屉。并排之后，点下一条就换右边，左边不动。
              窄屏没有并排的余地，那时右边顶掉左边，并给一个「返回列表」。
            */}
            <div className="flex gap-3">
            <div className={cn(
              "min-w-0 overflow-hidden rounded-xl border border-border bg-card",
              detailOpen ? "hidden flex-1 lg:block" : "flex-1",
            )}>
              {groups.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  {t("runs.noRunsMatch")}
                </p>
              ) : (
                groups.map((g) => {
                  const open = expanded.has(g.caseId);
                  return (
                    <Fragment key={g.caseId}>
                      <div
                        className={cn(
                          "flex w-full items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0 hover:bg-muted/60",
                          g.latest.id === selected?.id && drawerOpen && "bg-muted",
                        )}
                      >
                        {/* 一组多轮时才给展开钮：只跑过一次的用例不该长出一个点了没反应的三角。 */}
                        {g.attempts.length > 1 ? (
                          <button
                            onClick={() =>
                              setExpanded((s) => {
                                const n = new Set(s);
                                n.has(g.caseId) ? n.delete(g.caseId) : n.add(g.caseId);
                                return n;
                              })
                            }
                            title={t("runs.attemptsWhy")}
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                          >
                            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </button>
                        ) : (
                          <span className="w-3.5 shrink-0" />
                        )}
                        <button
                          onClick={() => {
                            setSelectedRunId(g.latest.id);
                            setDrawerOpen(true);
                          }}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
                        >
                          <RunStatusPill status={g.latest.status} />
                          <PriorityBadge run={g.latest} />
                          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{g.caseTitle}</span>
                          <RowChips r={g.latest} t={t} />
                          {g.attempts.length > 1 && (
                            <span
                              title={t("runs.attemptsWhy")}
                              className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10.5px] text-amber-700 dark:text-amber-400"
                            >
                              {t("runs.attemptsN", { n: g.attempts.length })}
                            </span>
                          )}
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">
                            {fmtDuration(g.latest.durationMs)}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {new Date(g.latest.startedAt).toLocaleTimeString()}
                          </span>
                        </button>
                      </div>
                      {open &&
                        g.attempts.map((r, i) => (
                          <button
                            key={r.id}
                            onClick={() => {
                              setSelectedRunId(r.id);
                              setDrawerOpen(true);
                            }}
                            className={cn(
                              "flex w-full cursor-pointer items-center gap-3 border-b border-border bg-muted/30 py-2 pl-10 pr-3 text-left last:border-b-0 hover:bg-muted/60",
                              r.id === selected?.id && drawerOpen && "bg-muted",
                            )}
                          >
                            <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">
                              {t("runs.roundN", { n: g.attempts.length - i })}
                            </span>
                            <RunStatusPill status={r.status} />
                            <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                              {r.failureReason ?? ""}
                            </span>
                            <RowChips r={r} t={t} />
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                              {fmtDuration(r.durationMs)}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {new Date(r.startedAt).toLocaleTimeString()}
                            </span>
                          </button>
                        ))}
                    </Fragment>
                  );
                })
              )}
            </div>

            {detailOpen && selected && (
              <div className="min-w-0 flex-1 overflow-auto rounded-xl border border-border bg-card lg:max-w-[46%]">
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card px-3 py-2">
                  <button
                    onClick={() => setDrawerOpen(false)}
                    className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11.5px] text-muted-foreground hover:bg-muted"
                  >
                    ← {t("runs.backToList")}
                  </button>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{selected.caseTitle}</span>
                </div>
                <div className="p-3">
                  <RunDetail run={selected} />
                </div>
              </div>
            )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
