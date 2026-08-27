import { useEffect } from "react";
import { Activity, Ban, Cpu, RotateCw, Square, Play } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { useProcs } from "@/lib/procs";
import { cn } from "@/lib/cn";
import type { ProcState, ProcStatus } from "@/lib/types";

const STATE_STYLE: Record<ProcState, string> = {
  alive: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  idle: "bg-muted text-muted-foreground",
  spawning: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  restarting: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  draining: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  exited: "bg-muted text-muted-foreground",
  crashed: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

function since(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="font-mono text-[13px] text-foreground">{value}</div>
    </div>
  );
}

function ProcessCard({ p }: { p: ProcStatus }) {
  const t = useT();
  const act = useProcs((s) => s.act);
  const logs = useProcs((s) => s.logs);
  const self = p.id === "gateway";
  const tail = logs.filter((l) => l.processId === p.id).slice(-6);
  // A heartbeat that stopped is the interesting signal: a hung process still has a pid.
  const beat = p.state === "alive" ? since(p.lastHeartbeat) : "—";

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <span className="font-display text-[15px] font-medium text-foreground">{p.id}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {p.kind}
            </span>
          </div>
          <div className="mt-1 truncate text-[12px] text-muted-foreground">
            {p.currentTask ? `${t("proc.task")}: ${p.currentTask}` : t("proc.idle")}
          </div>
        </div>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", STATE_STYLE[p.state])}>
          {t(`proc.state.${p.state}`)}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        <Stat label="PID" value={p.pid ? String(p.pid) : "—"} />
        <Stat label={t("proc.uptime")} value={since(p.startedAt)} />
        <Stat label={t("proc.heartbeat")} value={beat} />
        <Stat label={t("proc.restarts")} value={String(p.restarts)} />
        <Stat label={t("proc.memory")} value={p.rssMb ? `${p.rssMb} MB` : "—"} />
        <Stat label={t("proc.cpu")} value={p.cpuPct === undefined ? "—" : `${p.cpuPct}%`} />
        <Stat label={t("proc.calls")} value={String(p.spend.calls)} />
        {/* 03 §4 asks for the accumulated calls/tokens/spend. `spend.ms` is not part of it:
            the child sets it to its own uptime, so printing it beside the tokens read as a
            cost ("0 tok · 73720.6s") that no one is paying, and repeated 运行时长 two cells
            to the left. The dollars, which are the actual cost, were not shown at all. */}
        <Stat
          label={t("proc.cost")}
          value={`${p.spend.tokens} tok${p.spend.usd ? ` · $${p.spend.usd.toFixed(3)}` : ""}`}
        />
      </div>

      {(p.lastError || p.exitCode != null) && (
        <div className="mt-3 rounded-lg bg-muted px-3 py-2 text-[12px] text-muted-foreground">
          {p.exitCode != null && <span className="mr-2">exit {p.exitCode}</span>}
          {p.exitSignal && <span className="mr-2">{p.exitSignal}</span>}
          {p.lastError}
        </div>
      )}

      {tail.length > 0 && (
        <pre className="mt-3 max-h-28 overflow-auto rounded-lg bg-muted p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {tail.map((l) => `${l.text}`).join("\n")}
        </pre>
      )}

      {!self && (
        <div className="mt-3 flex gap-2">
          {/* Nothing to restart when it was never started — offer Start alone. */}
          {p.state !== "idle" && (
            <Button onClick={() => void act(p.id, "restart")}>
              <RotateCw className="h-3.5 w-3.5" />
              {t("proc.restart")}
            </Button>
          )}
          {p.state === "alive" || p.state === "spawning" ? (
            <>
              <Button onClick={() => void act(p.id, "stop")}>
                <Square className="h-3.5 w-3.5" />
                {t("proc.stop")}
              </Button>
              {p.id.startsWith("runner-") && p.currentTask !== "idle" && (
                <Button onClick={() => void act(p.id, "cancel-work")}>
                  <Ban className="h-3.5 w-3.5" />
                  {t("proc.cancelWork")}
                </Button>
              )}
            </>
          ) : (
            <Button onClick={() => void act(p.id, "start")}>
              <Play className="h-3.5 w-3.5" />
              {t("proc.start")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function ProcessesPage() {
  const t = useT();
  const { processes, ws, error, load, connect } = useProcs();

  useEffect(() => {
    void load();
    connect(); // the connection is shared and outlives this page
  }, [load, connect]);

  return (
    <>
      <TopBar />
      <div className="flex-1 overflow-auto p-4">
        <div className="mb-4">
          <h1 className="flex items-center gap-2 font-display text-lg font-medium text-foreground">
            <Activity
              className={cn("h-5 w-5", ws === "open" ? "text-emerald-500" : "text-amber-500")}
            />
            {t("nav.processes")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("proc.subtitle")}</p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {t(`proc.ws.${ws}`)}
            {error && <span className="text-rose-500"> · {error}</span>}
          </p>
        </div>
        {processes.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-[13px] text-muted-foreground">
            {t("proc.empty")}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {processes.map((p) => (
              <ProcessCard key={p.id} p={p} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
