import { ProjectRevisionLinks } from '@/components/ProjectRevisionLinks';
import { useEffect, useState } from "react";
import { TrendingUp, Wand2, Zap, Ban } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { NeedProject } from "@/components/NeedProject";
import { useT } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { Trends, TrendsBatch, CostReport } from "@/lib/types";

const pct = (n: number) => `${Math.round(n * 100)}%`;

function fmtMttr(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// KPI metric card — mirrors the RunReport MetricCard, with an optional tone + hint.
function KpiCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-xl bg-muted p-4">
      <div className="text-[0.8125rem] text-muted-foreground">{label}</div>
      <div className={cn("font-display text-2xl font-medium text-foreground", tone)}>{value}</div>
      {hint && <div className="mt-0.5 text-[0.6875rem] text-muted-foreground">{hint}</div>}
    </div>
  );
}


const ms = (n?: number) => (n == null ? "—" : n < 60000 ? `${Math.round(n / 1000)}s` : `${(n / 60000).toFixed(1)}m`);
const PHASES: Array<[string, string]> = [
  ["launchMs", "trends.cost.launch"], ["loginMs", "trends.cost.login"], ["settleMs", "trends.cost.settle"],
  ["stepsMs", "trends.cost.steps"], ["assertMs", "trends.cost.assert"], ["teardownMs", "trends.cost.teardown"],
];

/**
 * 成本块（07 T-21）：每条用例的账——`scripts/cost-report.mjs` 同一套聚合（`scripts/lib/cost-aggregate.mjs`），
 * 这里只是把它画出来。数字带来源：n 与 attribution 列告诉你这一行是几次运行、
 * 花费是记在 runner 上还是记在窗口上（并发时窗口数会把别的 runner 的账算进来）。
 */
function CostBlock({ projectId, t }: { projectId: string; t: (k: string) => string }) {
  const [cost, setCost] = useState<CostReport | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let cancelled = false;
    api.getCost(projectId, 10).then((c) => !cancelled && setCost(c)).catch((e) => !cancelled && setErr(String(e.message ?? e)));
    return () => { cancelled = true; };
  }, [projectId]);
  if (err) return <div className="rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">{err}</div>;
  if (!cost) return null;
  const T = cost.totals;
  const phaseSum = PHASES.reduce((a, [k]) => a + (T.phases[k] ?? 0), 0);
  const fk = (c: CostReport["cases"][number]) =>
    (["infra", "locate", "assert", "unknown"] as const).filter((k) => c.failures[k]).map((k) => `${k} ${c.failures[k]}`).join(" ");
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-1 font-display text-sm font-medium">{t("trends.cost.title")}</h2>
      <ProjectRevisionLinks />
      <div className="mb-3 text-[0.6875rem] text-muted-foreground">
        {t("trends.cost.hint")} · runs {T.runs} · tokens {T.tokens} · {t("trends.cost.cacheHit")}{" "}
        {T.hits + T.misses ? pct(T.hits / (T.hits + T.misses)) : "—"} · {t("trends.cost.attribution")} runner {T.attribution.runner} / window {T.attribution.window}
        {T.phasedRuns > 0 && (
          <> · {PHASES.map(([k, key]) => `${t(key)} ${ms(T.phases[k])}（${phaseSum ? Math.round(((T.phases[k] ?? 0) / phaseSum) * 100) : 0}%）`).join(" · ")}</>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[0.75rem]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-3">{t("trends.cost.case")}</th><th className="py-1 pr-3">n</th><th className="py-1 pr-3">{t("trends.cost.pass")}</th>
              <th className="py-1 pr-3">{t("trends.cost.wall")}</th><th className="py-1 pr-3">{t("trends.cost.calls")}</th><th className="py-1 pr-3">tokens</th>
              <th className="py-1 pr-3">{t("trends.cost.cacheHit")}</th><th className="py-1 pr-3">{t("trends.cost.failures")}</th><th className="py-1 pr-3">{t("trends.cost.healed")}</th>
            </tr>
          </thead>
          <tbody>
            {cost.cases.map((c) => (
              <tr key={c.caseId} className="border-t border-border">
                <td className="py-1 pr-3">{c.title}</td>
                <td className="py-1 pr-3 font-mono">{c.n}</td>
                <td className={cn("py-1 pr-3 font-mono", c.passRate < 1 && "text-warn")}>{pct(c.passRate)}</td>
                <td className="py-1 pr-3 font-mono">{ms(c.wallMedian)}{c.wallSpread ? ` ${c.wallSpread}` : ""}</td>
                <td className="py-1 pr-3 font-mono">{c.modelCallsMedian ?? "—"}</td>
                <td className="py-1 pr-3 font-mono">{c.tokensMedian ?? "—"}</td>
                <td className="py-1 pr-3 font-mono">{c.cacheHitRate == null ? "—" : pct(c.cacheHitRate)}{c.stale ? ` ⚠${c.stale}` : ""}</td>
                <td className="py-1 pr-3 font-mono">{fk(c) || (c.unobservable ? `unobs ${c.unobservable}` : "—")}</td>
                <td className="py-1 pr-3 font-mono">{c.healedRuns || "—"}{c.degraded.total ? ` / ${t("trends.cost.degraded")} ${c.degraded.total}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Headline pass-rate trend: one bar per batch, 0–100%, colored by CI gate.
function PassRateChart({ batches }: { batches: TrendsBatch[] }) {
  const W = 720;
  const H = 220;
  const padL = 34;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const y = (v: number) => padT + plotH * (1 - v); // v in 0..1

  const n = batches.length;
  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.min(38, Math.max(6, slot * 0.6));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      className="overflow-visible"
      role="img"
      aria-label="Pass rate per suite run over time"
    >
      {/* y-guides at 0 / 50 / 100% */}
      {[0, 0.5, 1].map((g) => (
        <g key={g}>
          <line
            x1={padL}
            x2={W - padR}
            y1={y(g)}
            y2={y(g)}
            className="stroke-border"
            strokeWidth={1}
            strokeDasharray={g === 0 ? "0" : "3 3"}
          />
          <text
            x={padL - 6}
            y={y(g) + 3}
            textAnchor="end"
            className="fill-muted-foreground"
            style={{ fontSize: 10 }}
          >
            {Math.round(g * 100)}%
          </text>
        </g>
      ))}

      {batches.map((b, i) => {
        const cx = padL + slot * i + slot / 2;
        const bh = plotH * b.passRate;
        const pass = b.gate === "pass";
        return (
          <g key={b.id}>
            <rect
              x={cx - barW / 2}
              y={y(b.passRate)}
              width={barW}
              height={Math.max(1, bh)}
              rx={3}
              className={cn(pass ? "fill-ok" : "fill-bad")}
            >
              <title>
                {`${b.label}\n${fmtDate(b.startedAt)}\npass rate ${pct(
                  b.passRate,
                )} · ${b.passed} passed / ${b.failed} failed · gate ${b.gate}`}
              </title>
            </rect>
            <circle cx={cx} cy={y(b.passRate)} r={2.5} className="fill-background" />
          </g>
        );
      })}

      {/* x-axis baseline */}
      <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} className="stroke-border" strokeWidth={1} />
    </svg>
  );
}

// Tiny per-batch stacked bars: passed / failed / healed / quarantined.
function StackedBars({ batches }: { batches: TrendsBatch[] }) {
  const t = useT();
  const segs: Array<{
    key: keyof TrendsBatch;
    label: string;
    tkey: string;
    cls: string;
  }> = [
    { key: "passed", label: "passed", tkey: "trends.legendPassed", cls: "bg-ok" },
    { key: "failed", label: "failed", tkey: "trends.legendFailed", cls: "bg-bad" },
    { key: "healed", label: "healed", tkey: "trends.legendHealed", cls: "bg-chat" },
    {
      key: "quarantined",
      label: "quarantined",
      tkey: "trends.legendQuarantined",
      cls: "bg-muted-foreground",
    },
  ];

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-muted-foreground">
        {segs.map((s) => (
          <span key={s.label} className="flex items-center gap-1">
            <span className={cn("h-2 w-2 rounded-sm", s.cls)} />
            {t(s.tkey)}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <Wand2 className="h-3 w-3 text-chat" /> {t("trends.legendHeal")}
        </span>
        <span className="flex items-center gap-1">
          <Zap className="h-3 w-3 text-warn" /> {t("trends.legendFlaky")}
        </span>
        <span className="flex items-center gap-1">
          <Ban className="h-3 w-3 text-ink2" /> {t("trends.legendQuarantine")}
        </span>
      </div>
      <div className="space-y-1.5">
        {batches.map((b) => {
          const total = b.passed + b.failed + b.healed + b.quarantined || 1;
          return (
            <div key={b.id} className="flex items-center gap-2">
              <span className="w-28 shrink-0 truncate text-[0.6875rem] text-muted-foreground">{b.label}</span>
              <div className="flex h-3 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted">
                {segs.map((s) => {
                  const v = b[s.key] as number;
                  if (!v) return null;
                  return (
                    <div
                      key={s.label}
                      className={s.cls}
                      style={{ width: `${(v / total) * 100}%` }}
                      title={`${t(s.tkey)}: ${v}`}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TrendsPage() {
  const t = useT();
  const activeProjectId = useStore((s) => s.activeProjectId);

  const [trends, setTrends] = useState<Trends | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProjectId) {
      setTrends(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getTrends(activeProjectId)
      .then((t) => {
        if (!cancelled) setTrends(t);
      })
      .catch((e) => {
        if (!cancelled) {
          setTrends(null);
          setError(`Couldn't load trends: ${(e as Error).message}. Check the backend at localhost:5301.`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  const flakeOver = trends ? trends.kpis.flakeRate > 0.02 : false;

  return (
    <>
      <TopBar title={t("surface.trends")} />
      <div className="flex-1 overflow-auto p-4">
        {!activeProjectId ? (
          <NeedProject />
        ) : loading && !trends ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            {t("trends.loading")}
          </div>
        ) : error ? (
          <div className="rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">{error}</div>
        ) : !trends || trends.batches.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {t("trends.empty")}
          </div>
        ) : (
          <div className="space-y-4">
            {/* KPI cards */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
              <KpiCard label={t("trends.passRate")} value={pct(trends.kpis.passRate)} />
              <KpiCard
                label={t("trends.flakeRate")}
                value={pct(trends.kpis.flakeRate)}
                hint={t("trends.flakeTarget")}
                tone={flakeOver ? (trends.kpis.flakeRate > 0.05 ? "text-bad" : "text-warn") : undefined}
              />
              <KpiCard label={t("trends.mttr")} value={fmtMttr(trends.kpis.mttrMs)} />
              <KpiCard label={t("trends.coverage")} value={pct(trends.kpis.coverage)} />
              <KpiCard label={t("trends.selfHealRate")} value={pct(trends.kpis.healRate)} />
            </div>

            {/* Pass-rate trend (headline) */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h2 className="mb-3 flex items-center gap-1.5 font-display text-sm font-medium">
                <TrendingUp className="h-3.5 w-3.5" /> {t("trends.passRateOverTime")}
                <span className="ml-1 text-[0.6875rem] font-normal text-muted-foreground">
                  {trends.batches.length}{" "}
                  {trends.batches.length > 1 ? t("trends.suiteRuns") : t("trends.suiteRun")} ·{" "}
                  {t("trends.gateHint")}
                </span>
              </h2>
              <PassRateChart batches={trends.batches} />
            </div>

            {/* Stacked breakdown */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h2 className="mb-3 font-display text-sm font-medium">{t("trends.outcomeBreakdown")}</h2>
              <StackedBars batches={trends.batches} />
            </div>

            {/* 每条用例的账（07 T-21） */}
            <CostBlock projectId={activeProjectId} t={t} />
          </div>
        )}
      </div>
    </>
  );
}
