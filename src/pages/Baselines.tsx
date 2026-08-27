import { useCallback, useEffect, useState } from "react";
import { Check, Eye, Gauge } from "lucide-react";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import { API_BASE } from "@/lib/base";
import { cn } from "@/lib/cn";

/**
 * 运行 · 待审批基线。
 *
 * 这是整套系统里唯一还需要人点头的地方：门禁是打分的，复核队列管的是文本用例，而
 * 「界面变了 8.5%，是改版还是回归」没有程序能替人回答。
 *
 * 批准入口本来就长在执行详情里（每条差异旁边），那没错——缺的是一份**清单**：
 * 没人会为了找出哪几条在等自己，去逐个点开三十次运行。所以这一节不搬运批准逻辑，
 * 它调的是同两个既有接口，只是把"谁在等"先答出来。
 *
 * 只看每条用例**最近一次**运行：三周前的一次差异如果后来跑绿了，那是历史，不是待办。
 */

interface PendingVisual {
  caseId: string;
  caseTitle: string;
  runId: string;
  at: string;
  stepIdx: number;
  mismatchPct: number;
  baselineRef?: string;
  currentRef?: string;
  diffRef?: string;
  first: boolean;
}

interface PendingPerf {
  caseId: string;
  caseTitle: string;
  runId: string;
  at: string;
  metrics: Record<string, number>;
  baseline?: Record<string, number>;
  worse: Array<{ metric: string; now: number; was: number }>;
}

const API = API_BASE;

function Shot({ label, ref_ }: { label: string; ref_?: string }) {
  if (!ref_) return null;
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <img
        src={`${API}/api/artifacts/${ref_}`}
        alt={label}
        className="max-h-52 w-full rounded border border-border object-contain"
      />
    </div>
  );
}

export function BaselinesPage() {
  const t = useT();
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [visual, setVisual] = useState<PendingVisual[]>([]);
  const [perf, setPerf] = useState<PendingPerf[]>([]);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string>("");

  const load = useCallback(() => {
    if (!activeProjectId) return;
    setError("");
    fetch(`${API}/api/projects/${activeProjectId}/pending-baselines`)
      .then((r) => r.json())
      .then((d: { visual?: PendingVisual[]; perf?: PendingPerf[]; error?: string }) => {
        if (d.error) return setError(d.error);
        setVisual(d.visual ?? []);
        setPerf(d.perf ?? []);
      })
      .catch((e) => setError((e as Error).message));
  }, [activeProjectId]);

  useEffect(load, [load]);

  // The same two endpoints the run detail calls. Approving here and approving there must be
  // one act, not two implementations that can drift apart.
  const approveVisual = async (v: PendingVisual) => {
    const key = `v:${v.caseId}:${v.stepIdx}`;
    try {
      const res = await fetch(`${API}/api/cases/${v.caseId}/baselines/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepIdx: v.stepIdx, ref: v.currentRef }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setDone((d) => ({ ...d, [key]: true }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const approvePerf = async (p: PendingPerf) => {
    const key = `p:${p.caseId}`;
    try {
      const res = await fetch(`${API}/api/cases/${p.caseId}/perf-baseline/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The endpoint takes the run, not the numbers: it re-reads the metrics from the run
        // itself, so a baseline can never be set from figures the client made up.
        body: JSON.stringify({ runId: p.runId }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setDone((d) => ({ ...d, [key]: true }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!activeProjectId) return <div className="p-4 text-sm text-muted-foreground">{t("assets.pickProject")}</div>;

  const pendingV = visual.filter((v) => !done[`v:${v.caseId}:${v.stepIdx}`]);
  const pendingP = perf.filter((p) => !done[`p:${p.caseId}`]);

  return (
    <div className="flex-1 overflow-auto">
      <p className="border-b border-border px-4 py-2 text-[12.5px] text-muted-foreground">{t("base.lede")}</p>
      {error && <div className="px-4 py-2 text-[12px] text-rose-500">{error}</div>}

      {pendingV.length === 0 && pendingP.length === 0 ? (
        <div className="p-4 text-[12.5px] text-muted-foreground">{t("base.empty")}</div>
      ) : null}

      {pendingV.length > 0 && (
        <section className="px-4 py-3">
          <h3 className="flex items-center gap-1.5 font-display text-[13px] font-medium">
            <Eye className="h-4 w-4 text-primary" />
            {t("base.visual")}
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10.5px] text-amber-700 dark:text-amber-400">
              {pendingV.length}
            </span>
          </h3>

          {pendingV.map((v) => {
            const key = `v:${v.caseId}:${v.stepIdx}`;
            return (
              <div key={key} className="mt-2 rounded-xl border border-border bg-card">
                <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="text-[13px] font-medium">{v.caseTitle}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    step {v.stepIdx} · {v.runId}
                  </span>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 font-mono text-[11px]",
                      v.mismatchPct >= 5
                        ? "bg-rose-500/15 text-rose-700 dark:text-rose-400"
                        : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                    )}
                  >
                    {v.mismatchPct}%
                  </span>
                  {v.first && <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px]">{t("base.first")}</span>}
                  <button
                    onClick={() => setOpen(open === key ? "" : key)}
                    className="ml-auto cursor-pointer text-[12px] text-muted-foreground hover:text-foreground"
                  >
                    {open === key ? t("base.hide") : t("base.compare")}
                  </button>
                  <button
                    onClick={() => void approveVisual(v)}
                    className="flex cursor-pointer items-center gap-1 rounded-md bg-primary px-2 py-1 text-[12px] text-primary-foreground"
                  >
                    <Check className="h-3.5 w-3.5" />
                    {t("base.accept")}
                  </button>
                </div>
                {open === key && (
                  <div className="flex gap-2 border-t border-border p-3">
                    <Shot label={t("base.baseline")} ref_={v.baselineRef} />
                    <Shot label={t("base.current")} ref_={v.currentRef} />
                    <Shot label={t("base.diff")} ref_={v.diffRef} />
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {pendingP.length > 0 && (
        <section className="px-4 py-3">
          <h3 className="flex items-center gap-1.5 font-display text-[13px] font-medium">
            <Gauge className="h-4 w-4 text-primary" />
            {t("base.perf")}
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10.5px] text-amber-700 dark:text-amber-400">
              {pendingP.length}
            </span>
          </h3>

          {pendingP.map((p) => (
            <div key={p.caseId} className="mt-2 rounded-xl border border-border bg-card px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-medium">{p.caseTitle}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{p.runId}</span>
                <button
                  onClick={() => void approvePerf(p)}
                  className="ml-auto flex cursor-pointer items-center gap-1 rounded-md bg-primary px-2 py-1 text-[12px] text-primary-foreground"
                >
                  <Check className="h-3.5 w-3.5" />
                  {t("base.acceptPerf")}
                </button>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-3">
                {p.worse.map((w) => (
                  <span key={w.metric} className="font-mono text-[11.5px]">
                    <span className="text-muted-foreground">{w.metric}</span>{" "}
                    <span className="text-muted-foreground">{w.was}</span>
                    <span className="text-muted-foreground"> → </span>
                    <span className="text-rose-600 dark:text-rose-400">{w.now}</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      <p className="px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">{t("base.footnote")}</p>
    </div>
  );
}
