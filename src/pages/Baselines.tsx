import { NeedProject } from "@/components/NeedProject";
import { ErrorCard } from "@/components/ui";
import { useCallback, useEffect, useState } from "react";
import { Check, Eye, Gauge } from "lucide-react";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import { TopBar } from "@/components/TopBar";
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
      <div className="mb-1 font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </div>
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
  /** 性能预算：判回归时的第三个数。基线保「别更慢」，预算保「本来就不该这么慢」。 */
  const [perfBudget, setPerfBudget] = useState<Record<string, number>>({});
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string>("");
  /** 正在提交裁决的那一条。 */
  const [busy, setBusy] = useState("");

  const load = useCallback(() => {
    if (!activeProjectId) return;
    setError("");
    fetch(`${API}/api/projects/${activeProjectId}/pending-baselines`)
      .then((r) => r.json())
      .then((d: { visual?: PendingVisual[]; perf?: PendingPerf[]; perfBudget?: Record<string, number>; error?: string }) => {
        if (d.error) return setError(d.error);
        setVisual(d.visual ?? []);
        setPerf(d.perf ?? []);
        setPerfBudget(d.perfBudget ?? {});
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

  /**
   * 另外两个出口：判为回归 / 承认是环境噪声。
   *
   * 两个都**不动基线**——回归是说「产品错了，这条用例应该继续红」，
   * 噪声是说「这次的数字不算数」。此前只有「接受为新基线」一个按钮，
   * 于是一次真回归和一次改版走同一条路，而按下去之后回归就成了新的正确答案。
   */
  const judge = async (
    item: { caseId: string; runId: string; stepIdx?: number },
    kind: "visual" | "perf",
    verdict: "regression" | "noise",
  ) => {
    const note =
      verdict === "regression"
        ? (window.prompt(t("base.regressionAsk")) ?? "")
        : (window.prompt(t("base.noiseAsk")) ?? "");
    if (verdict === "regression" && !note.trim()) return;
    setBusy(item.caseId);
    setError("");
    try {
      const res = await fetch(`${API}/api/cases/${item.caseId}/baseline-verdict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          runId: item.runId,
          ...(item.stepIdx !== undefined ? { stepIdx: item.stepIdx } : {}),
          verdict,
          note,
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) return setError(body.error ?? `HTTP ${res.status}`);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
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

  if (!activeProjectId)
    return (
      <>
        <TopBar title={t("surface.baselines")} />
        <div className="p-4"><NeedProject /></div>
      </>
    );

  const pendingV = visual.filter((v) => !done[`v:${v.caseId}:${v.stepIdx}`]);
  const pendingP = perf.filter((p) => !done[`p:${p.caseId}`]);

  return (
    <>
      <TopBar title={t("surface.baselines")} hint={t("base.lede")} />
      <div className="flex-1 overflow-auto">
        {error && <ErrorCard className="m-3" reason={error} onRetry={() => void load()} />}

        {pendingV.length === 0 && pendingP.length === 0 ? (
          <div className="p-4 text-[0.8125rem] text-muted-foreground">{t("base.empty")}</div>
        ) : null}

        {pendingV.length > 0 && (
          <section className="px-4 py-3">
            <h3 className="flex items-center gap-1.5 font-display text-[0.8125rem] font-medium">
              <Eye className="h-4 w-4 text-primary" />
              {t("base.visual")}
              <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[0.6875rem] text-warn">
                {pendingV.length}
              </span>
            </h3>

            {pendingV.map((v) => {
              const key = `v:${v.caseId}:${v.stepIdx}`;
              return (
                <div key={key} className="mt-2 rounded-xl border border-border bg-card">
                  <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="text-[0.8125rem] font-medium">{v.caseTitle}</span>
                    <span className="font-mono text-[0.6875rem] text-muted-foreground">
                      step {v.stepIdx} · {v.runId}
                    </span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 font-mono text-[0.6875rem]",
                        v.mismatchPct >= 5 ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn",
                      )}
                    >
                      {v.mismatchPct}%
                    </span>
                    {v.first && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[0.6875rem]">{t("base.first")}</span>
                    )}
                    <button
                      onClick={() => setOpen(open === key ? "" : key)}
                      className="ml-auto cursor-pointer text-[0.75rem] text-muted-foreground hover:text-foreground"
                    >
                      {open === key ? t("base.hide") : t("base.compare")}
                    </button>
                    <button
                      onClick={() => void approveVisual(v)}
                      className="flex cursor-pointer items-center gap-1 rounded-md bg-primary px-2 py-1 text-[0.75rem] text-primary-foreground"
                    >
                      <Check className="h-3.5 w-3.5" />
                      {t("base.accept")}
                    </button>
                    {/* 第二个出口。界面的差异只有两种可能：改版或回归——
                        「环境噪声」不适用于一张截图，所以这一档这里没有。 */}
                    <button
                      disabled={busy === v.caseId}
                      onClick={() => void judge(v, "visual", "regression")}
                      title={t("base.regressionWhy")}
                      className="cursor-pointer rounded-md border border-bad px-2 py-1 text-[0.75rem] text-bad"
                    >
                      {t("base.regression")}
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
            <h3 className="flex items-center gap-1.5 font-display text-[0.8125rem] font-medium">
              <Gauge className="h-4 w-4 text-primary" />
              {t("base.perf")}
              <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[0.6875rem] text-warn">
                {pendingP.length}
              </span>
            </h3>

            {/* 预算是全局的，所以只印一次，不跟着每条用例重复。 */}
            {Object.keys(perfBudget).length > 0 && (
              <p className="mt-1 font-mono text-[0.6875rem] text-muted-foreground">
                {t("base.budgetLine")}{" "}
                {Object.entries(perfBudget)
                  .map(([k, v]) => `${k} ≤ ${v}`)
                  .join(" · ")}
              </p>
            )}
            {pendingP.map((p) => (
              <div key={p.caseId} className="mt-2 rounded-xl border border-border bg-card px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.8125rem] font-medium">{p.caseTitle}</span>
                  <span className="font-mono text-[0.6875rem] text-muted-foreground">{p.runId}</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    <button
                      onClick={() => void approvePerf(p)}
                      className="flex cursor-pointer items-center gap-1 rounded-md bg-primary px-2 py-1 text-[0.75rem] text-primary-foreground"
                    >
                      <Check className="h-3.5 w-3.5" />
                      {t("base.acceptPerf")}
                    </button>
                    <button
                      disabled={busy === p.caseId}
                      onClick={() => void judge(p, "perf", "regression")}
                      title={t("base.regressionWhy")}
                      className="cursor-pointer rounded-md border border-bad px-2 py-1 text-[0.75rem] text-bad"
                    >
                      {t("base.regression")}
                    </button>
                    {/* 第三个出口，只给性能：一次网络抖动会让数字变难看，
                        而那既不是回归，也不该被写成新的基线。 */}
                    <button
                      disabled={busy === p.caseId}
                      onClick={() => void judge(p, "perf", "noise")}
                      title={t("base.noiseWhy")}
                      className="cursor-pointer rounded-md border border-border px-2 py-1 text-[0.75rem] text-muted-foreground"
                    >
                      {t("base.noise")}
                    </button>
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-3">
                  {p.worse.map((w) => {
                    const cap = perfBudget[w.metric];
                    return (
                      <span key={w.metric} className="font-mono text-[0.75rem]">
                        <span className="text-muted-foreground">{w.metric}</span>{" "}
                        <span className="text-muted-foreground">{w.was}</span>
                        <span className="text-muted-foreground"> → </span>
                        <span className="text-bad">{w.now}</span>
                        {/*
                          第三个数：预算。少了它，「620 → 780」说不出该按哪个按钮——
                          780 还在 800 的预算里多半是抖动；预算若是 700，那就是真回归。
                        */}
                        {cap !== undefined && (
                          <span
                            className={cn("ml-1", w.now > cap ? "text-bad" : "text-muted-foreground")}
                            title={t("base.budgetWhy")}
                          >
                            {w.now > cap ? t("base.overBudget", { cap }) : t("base.inBudget", { cap })}
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        )}

        <p className="px-4 py-3 text-[0.75rem] leading-relaxed text-muted-foreground">{t("base.footnote")}</p>
      </div>
    </>
  );
}
