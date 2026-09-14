import { useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/base";
import {
  Rocket,
  Loader2,
  Wand2,
  ShieldCheck,
  ShieldX,
  Zap,
  Ban,
  Clock,
  ChevronRight,
  ChevronDown,
  HelpCircle,
  Square,
} from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { NeedProject } from "@/components/NeedProject";
import { Button, ErrorCard } from "@/components/ui";
import { Drawer } from "@/components/overlay";
import { RunDetail } from "@/components/RunDetail";
import { useT } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { Batch, BatchRun, RunRecord } from "@/lib/types";

type Filter = "P0" | "P1" | "P2" | "all";

interface QueueStatus {
  concurrency: number;
  active: number;
  waiting: number;
  totalQueued: number;
  totalDone: number;
  activeLabels: string[];
}

function GateBadge({ gate, big }: { gate: "pass" | "fail"; big?: boolean }) {
  const t = useT();
  const pass = gate === "pass";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md font-display font-medium",
        big ? "px-3 py-1.5 text-base" : "px-2 py-0.5 text-xs",
        pass ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad",
      )}
    >
      {pass ? (
        <ShieldCheck className={big ? "h-4 w-4" : "h-3.5 w-3.5"} />
      ) : (
        <ShieldX className={big ? "h-4 w-4" : "h-3.5 w-3.5"} />
      )}
      {pass ? t("suite.gatePass") : t("suite.gateFail")}
    </span>
  );
}

function StatusPill({ status }: { status: BatchRun["status"] }) {
  const t = useT();
  if (status === "passed")
    return (
      <span className="rounded px-1.5 py-0.5 text-[0.6875rem] font-medium bg-ok-soft text-ok">
        {t("suite.statPassed")}
      </span>
    );
  if (status === "failed")
    return (
      <span className="rounded px-1.5 py-0.5 text-[0.6875rem] font-medium bg-bad-soft text-bad">
        {t("suite.statFailed")}
      </span>
    );
  // 「没拿到判决」必须自己有一支，否则它会掉进下面那支变成「已隔离」——意思正好相反。
  if (status === "error")
    return (
      <span className="rounded px-1.5 py-0.5 text-[0.6875rem] font-medium bg-accent text-ink2">
        {t("suite.statErrored")}
      </span>
    );
  return (
    <span className="rounded px-1.5 py-0.5 text-[0.6875rem] font-medium bg-warn-soft text-warn">
      {t("suite.statQuarantined")}
    </span>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  tone,
  onClick,
  title,
}: {
  label: string;
  value: number;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: string;
  /** 可点的那一格：一个数字后面得有东西，否则它只是个数字。 */
  onClick?: () => void;
  title?: string;
}) {
  return (
    <div
      className={cn("rounded-xl bg-muted p-3", onClick && "cursor-pointer hover:brightness-95")}
      onClick={onClick}
      title={title}
    >
      <div className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
        {Icon && <Icon className={cn("h-3 w-3", tone)} />}
        {label}
      </div>
      <div className={cn("font-display text-xl font-medium", tone)}>{value}</div>
    </div>
  );
}

/**
 * 抖动的那几条，以及它们的隔离开关。
 *
 * 隔离是这一屏上唯一一个**会改变门禁结论**的人工动作：被隔离的用例照跑，
 * 但它的红不再拦门禁。所以：
 * ① 理由必填（服务端也拦，不只是界面提示）；
 * ② 每次开关都进台账——谁、什么时候、为什么、当时门禁是什么判决；
 * ③ 改完当场把这一批重判一次，把「本来是 fail，隔离之后是 pass」直接说出来，
 *    而不是让人下次跑完才发现门禁变绿了。
 */
function FlakyPanel({ batch, items }: { batch: Batch; items: BatchRun[] }) {
  const t = useT();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [log, setLog] = useState<
    Array<{
      id: string;
      caseId: string;
      on: boolean;
      reason: string;
      by: string;
      at: string;
      gateAtTime?: string;
    }>
  >([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [quarantined, setQuarantined] = useState<Record<string, boolean>>(
    Object.fromEntries(items.map((i) => [i.caseId, i.status === "quarantined"])),
  );

  const projectId = useStore((s) => s.activeProjectId);

  useEffect(() => {
    if (!projectId) return;
    void fetch(`${API_BASE}/api/projects/${projectId}/quarantine-log`)
      .then((r) => r.json())
      .then((d: { entries?: typeof log }) => setLog(d.entries ?? []))
      .catch(() => setLog([]));
  }, [projectId]);

  /**
   * 隔离之后这一批会是什么判决。
   *
   * 门禁的规则在服务端：failed 或 errored 大于零就是 fail，隔离的不算。
   * 这里按同一条规则算一遍，好让人在按下之前就看见判决会不会变——
   * 一个「按下去之后才知道门禁变绿了」的开关，正是这套东西最容易被绕过的地方。
   */
  const verdictAfter = (() => {
    const failed = items.filter((i) => i.status === "failed" && !quarantined[i.caseId]).length;
    const errored = items.filter((i) => i.status === "error").length;
    return failed > 0 || errored > 0 ? "fail" : "pass";
  })();

  const toggle = async (caseId: string, on: boolean) => {
    const reason = (reasons[caseId] ?? "").trim();
    if (!reason) return setError(t("suite.quarantineNeedsReason"));
    setBusy(caseId);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/cases/${caseId}/quarantine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ on, reason }),
      });
      const body = (await res.json()) as { error?: string; entry?: (typeof log)[number] };
      if (!res.ok) return setError(body.error ?? `HTTP ${res.status}`);
      setQuarantined((q) => ({ ...q, [caseId]: on }));
      setReasons((r) => ({ ...r, [caseId]: "" }));
      if (body.entry) setLog((l) => [body.entry!, ...l]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const flaky = items.filter((i) => i.status === "failed" || i.status === "quarantined" || i.healed);

  return (
    <div className="mt-3 rounded-xl border border-warn bg-warn-soft p-3">
      <div className="flex flex-wrap items-center gap-2 text-[0.75rem]">
        <span className="font-medium">{t("suite.flakyTitle", { n: flaky.length })}</span>
        {/* 判决会不会变，摆在按下去之前。 */}
        <span className="text-muted-foreground">
          {t("suite.verdictNow")}: <span className="font-mono">{batch.gate}</span> →{" "}
          <span className={cn("font-mono", verdictAfter === "pass" ? "text-ok" : "text-bad")}>
            {verdictAfter}
          </span>
        </span>
      </div>

      <div className="mt-2 space-y-2">
        {flaky.map((i) => (
          <div key={i.caseId} className="rounded-lg border border-border bg-card p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{i.caseTitle}</span>
              <StatusPill status={i.status} />
              {quarantined[i.caseId] && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
                  {t("suite.statQuarantined")}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-[0.1875rem] text-[0.75rem]"
                placeholder={t("suite.quarantineReason")}
                value={reasons[i.caseId] ?? ""}
                onChange={(e) => setReasons((r) => ({ ...r, [i.caseId]: e.target.value }))}
              />
              <Button
                disabled={busy === i.caseId}
                onClick={() => void toggle(i.caseId, !quarantined[i.caseId])}
                title={t("suite.quarantineWhy")}
              >
                {quarantined[i.caseId] ? t("suite.unquarantine") : t("suite.quarantine")}
              </Button>
            </div>
          </div>
        ))}
        {flaky.length === 0 && <p className="text-[0.75rem] text-muted-foreground">{t("suite.flakyNone")}</p>}
      </div>

      {error && <ErrorCard className="mt-2" reason={error} />}

      {/* 台账。它只增不删——「这条为什么被隔离过」必须永远查得出来。 */}
      {log.length > 0 && (
        <div className="mt-3 border-t border-border pt-2">
          <div className="text-[0.6875rem] text-muted-foreground">{t("suite.quarantineLog")}</div>
          <div className="mt-1 max-h-40 space-y-0.5 overflow-auto font-mono text-[0.6875rem] text-muted-foreground">
            {log.map((e) => (
              <div key={e.id}>
                {new Date(e.at).toLocaleString()} · {e.by} · {e.on ? t("suite.quarantined") : t("suite.released")} ·{" "}
                {e.gateAtTime ? t("suite.gateAtTime", { v: e.gateAtTime }) : ""}
                {e.reason}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Per-case results for a batch. Rows that produced a run (have a runId) are
// clickable — click/Enter/Space opens that run's full detail in a Drawer.
// Rows without a runId (e.g. an"error" that never produced a run) render plain.
function BatchItems({ items, onOpenRun }: { items: BatchRun[]; onOpenRun: (item: BatchRun) => void }) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <tbody>
          {items.map((it) => {
            const clickable = !!it.runId;
            return (
              <tr
                key={it.caseId}
                onClick={clickable ? () => onOpenRun(it) : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onOpenRun(it);
                        }
                      }
                    : undefined
                }
                tabIndex={clickable ? 0 : undefined}
                role={clickable ? "button" : undefined}
                className={cn(
                  "border-b border-border last:border-b-0",
                  clickable
                    ? "cursor-pointer hover:bg-muted/60 focus:bg-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    : "",
                )}
              >
                <td className="px-3 py-2">
                  <span className="font-medium">{it.caseTitle}</span>
                  {!clickable && (
                    <span className="ml-2 text-[0.6875rem] text-muted-foreground">{t("suite.noRunDetail")}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <StatusPill status={it.status} />
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                  {it.attempts > 1 ? `×${it.attempts}` : ""}
                </td>
                <td className="px-3 py-2 text-right">
                  {it.healed && (
                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem] font-medium bg-chat-soft text-chat">
                      <Wand2 className="h-3 w-3" /> {t("suite.healed")}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ResultSummary({
  batch,
  items,
  onOpenRun,
}: {
  batch: Batch;
  items: BatchRun[];
  onOpenRun: (item: BatchRun) => void;
}) {
  const t = useT();
  const [flakyOpen, setFlakyOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-3">
        <GateBadge gate={batch.gate} big />
        <span className="min-w-0 flex-1 truncate font-display text-sm font-medium">{batch.label}</span>
        {batch.status === "running" && (
          <span className="flex items-center gap-1 text-xs text-primary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("suite.running")}
          </span>
        )}
      </div>

      {/* 七格，不是六格：把「没拿到判决」从「失败」里分出来。见 types.ts 的 Batch.errored。 */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
        <Stat label={t("suite.statTotal")} value={batch.total} />
        <Stat label={t("suite.statPassed")} value={batch.passed} tone="text-ok" />
        <Stat label={t("suite.statFailed")} value={batch.failed} tone="text-bad" />
        <Stat label={t("suite.statErrored")} value={batch.errored ?? 0} icon={HelpCircle} tone="text-ink2" />
        <Stat label={t("suite.statHealed")} value={batch.healed} icon={Wand2} tone="text-chat" />
        <Stat
          label={t("suite.statFlaky")}
          value={batch.flaky}
          icon={Zap}
          tone="text-warn"
          onClick={() => setFlakyOpen((v) => !v)}
          title={t("suite.flakyWhy")}
        />
        <Stat
          label={t("suite.statQuarantined")}
          value={batch.quarantined}
          icon={Ban}
          tone="text-muted-foreground"
        />
      </div>

      {/* 抖动那一格点开就是这几条，每条带一个隔离开关。
          隔离是**唯一一个会改变门禁结论的人工动作**——所以理由必填，动作进台账。 */}
      {flakyOpen && <FlakyPanel batch={batch} items={items} />}

      {items.length > 0 && (
        <div className="mt-4">
          <BatchItems items={items} onOpenRun={onOpenRun} />
        </div>
      )}
    </div>
  );
}

export function SuitePage() {
  const t = useT();
  const activeProjectId = useStore((s) => s.activeProjectId);
  const backendUp = useStore((s) => s.backendUp);

  const [filter, setFilter] = useState<Filter>("P0");
  const [retries, setRetries] = useState(1);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [result, setResult] = useState<{
    batch: Batch;
    items: BatchRun[];
  } | null>(null);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  /**
   * 跑套件的那个 POST 要等**整批跑完**才返回，所以按下「开始」之后前端手里
   * 没有 batchId，也就没法停它。轮询的时候顺手把 running 的那一批捞出来，
   * 停止按钮就有了下手的地方。
   */
  const [liveBatchId, setLiveBatchId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);

  // Run-detail drawer (shared by result + recent-suite drill-down).
  const [runDrawer, setRunDrawer] = useState<{
    title: string;
    loading: boolean;
    run?: RunRecord;
    error?: boolean;
  } | null>(null);

  // Recent suites: which batch is expanded, and its lazily-fetched items.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [batchItems, setBatchItems] = useState<Record<string, BatchRun[]>>({});

  const pollRef = useRef<number | null>(null);

  const openRun = async (item: BatchRun) => {
    if (!item.runId) return;
    setRunDrawer({ title: item.caseTitle, loading: true });
    try {
      const { run } = await api.getRun(item.runId);
      setRunDrawer({ title: item.caseTitle, loading: false, run });
    } catch {
      setRunDrawer({ title: item.caseTitle, loading: false, error: true });
    }
  };

  const toggleBatch = async (batchId: string) => {
    if (expanded === batchId) {
      setExpanded(null);
      return;
    }
    setExpanded(batchId);
    if (!batchItems[batchId]) {
      try {
        const { items } = await api.getBatch(batchId);
        setBatchItems((m) => ({ ...m, [batchId]: items }));
      } catch {
        setBatchItems((m) => ({ ...m, [batchId]: [] }));
      }
    }
  };

  const loadBatches = async () => {
    if (!activeProjectId) return;
    try {
      const { batches } = await api.getBatches(activeProjectId);
      setBatches(batches);
    } catch {
      /* backend offline */
    }
  };

  useEffect(() => {
    setResult(null);
    void loadBatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  // Poll the queue while a suite is running to show live progress.
  useEffect(() => {
    if (!running) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setQueue(null);
      setLiveBatchId(null);
      setStopping(false);
      return;
    }
    const tick = async () => {
      try {
        setQueue(await api.getQueue());
        if (activeProjectId) {
          const { batches: bs } = await api.getBatches(activeProjectId);
          setLiveBatchId(bs.find((b) => b.status === "running")?.id ?? null);
        }
      } catch {
        /* ignore transient errors while running */
      }
    };
    void tick();
    pollRef.current = window.setInterval(() => void tick(), 1500);
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const stopSuite = async () => {
    if (!liveBatchId || stopping) return;
    setStopping(true);
    try {
      await api.cancelBatch(liveBatchId);
    } catch (e) {
      setError(t("suite.stopFailed", { why: (e as Error).message }));
      setStopping(false);
    }
  };

  const runSuite = async () => {
    if (!activeProjectId || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.runSuite(activeProjectId, filter, retries);
      setResult({ batch: res.batch, items: res.items });
      await loadBatches();
    } catch (e) {
      setError(`Suite run failed: ${(e as Error).message}. Check the backend is running at localhost:5301.`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <TopBar
        title={t("surface.batches")}
        actions={
          <div className="flex items-center gap-2">
            {running && liveBatchId && (
              <Button variant="outline" onClick={stopSuite} disabled={stopping}>
                <Square className="h-3.5 w-3.5" />
                {stopping ? t("suite.stopping") : t("suite.stop")}
              </Button>
            )}
            <Button variant="success" onClick={runSuite} disabled={running || !activeProjectId}>
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Rocket className="h-3.5 w-3.5" />
              )}
              {running ? t("suite.runningSuite") : t("topbar.runSuite")}
            </Button>
          </div>
        }
      />

      <div className="flex-1 overflow-auto p-4">
        {!activeProjectId ? (
          <NeedProject />
        ) : (
          <div className="space-y-4">
            {/* Control row */}
            <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-3">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t("suite.filter")}
                <select
                  aria-label="Suite filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as Filter)}
                  disabled={running}
                  className="cursor-pointer rounded border border-input bg-background px-2 py-[0.1875rem] text-[0.8125rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <option value="P0">{t("suite.p0Only")}</option>
                  <option value="P1">{t("suite.p1Only")}</option>
                  <option value="P2">{t("suite.p2Only")}</option>
                  <option value="all">{t("suite.allPriorities")}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t("suite.retries")}
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={retries}
                  disabled={running}
                  onChange={(e) => setRetries(Math.max(0, Number(e.target.value) || 0))}
                  className="w-20 rounded border border-input bg-background px-2 py-[0.1875rem] text-[0.8125rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                />
              </label>
              <Button
                variant="success"
                onClick={runSuite}
                disabled={running || !activeProjectId}
                className="mb-0.5"
              >
                {running ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Rocket className="h-3.5 w-3.5" />
                )}
                {running ? t("suite.runningSuite") : t("topbar.runSuite")}
              </Button>

              {/* Live queue status while running */}
              {running && (
                <div className="ml-auto flex items-center gap-3 rounded-lg bg-muted px-3 py-2 text-xs">
                  <span className="flex items-center gap-1 text-primary">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {queue ? `${queue.active} ${t("suite.nRunning")}` : t("suite.starting")}
                  </span>
                  {queue && (
                    <>
                      <span className="text-muted-foreground">
                        {queue.waiting} {t("suite.nQueued")}
                      </span>
                      <span className="text-muted-foreground">
                        {t("suite.concurrency")} {queue.concurrency}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>

            {!backendUp && (
              <div className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
                {t("suite.backendOffline")}
              </div>
            )}
            {error && <ErrorCard reason={error} onRetry={() => void loadBatches()} />}

            {/* Result summary */}
            {result && <ResultSummary batch={result.batch} items={result.items} onOpenRun={openRun} />}

            {/* Recent suites */}
            <div>
              <h2 className="mb-2 flex items-center gap-1.5 font-display text-sm font-medium">
                <Clock className="h-3.5 w-3.5" /> {t("suite.recentSuites")}
              </h2>
              {batches.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  {t("suite.noSuiteRuns")}
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  {batches.map((b) => {
                    const isOpen = expanded === b.id;
                    const items = batchItems[b.id];
                    return (
                      <div key={b.id} className="border-b border-border last:border-b-0">
                        <button
                          type="button"
                          onClick={() => void toggleBatch(b.id)}
                          aria-expanded={isOpen}
                          className={cn(
                            "flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left text-sm hover:bg-muted/60",
                            "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          )}
                        >
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <GateBadge gate={b.gate} />
                          <span className="min-w-0 flex-1 truncate font-medium">{b.label}</span>
                          <span className="text-xs text-ok">
                            {b.passed} {t("suite.nPassed")}
                          </span>
                          <span className="text-xs text-bad">
                            {b.failed} {t("suite.nFailed")}
                          </span>
                          {b.healed > 0 && (
                            <span className="flex items-center gap-1 text-xs text-chat">
                              <Wand2 className="h-3 w-3" />
                              {b.healed} {t("suite.nHealed")}
                            </span>
                          )}
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {new Date(b.startedAt).toLocaleString()}
                          </span>
                        </button>
                        {isOpen && (
                          <div className="px-3 pb-3">
                            {items === undefined ? (
                              <p className="py-2 text-xs text-muted-foreground">{t("common.loading")}</p>
                            ) : items.length === 0 ? (
                              <p className="py-2 text-xs text-muted-foreground">{t("suite.noRunDetail")}</p>
                            ) : (
                              <BatchItems items={items} onOpenRun={openRun} />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <Drawer open={!!runDrawer} onClose={() => setRunDrawer(null)} title={runDrawer?.title}>
        {runDrawer?.loading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("common.loading")}
          </div>
        ) : runDrawer?.error ? (
          <p className="p-4 text-sm text-muted-foreground">{t("suite.runDetailUnavailable")}</p>
        ) : runDrawer?.run ? (
          <RunDetail run={runDrawer.run} />
        ) : null}
      </Drawer>
    </>
  );
}
