import { useStore } from '@/lib/store';
import {EvidenceStudy} from '@/components/EvidenceStudy';
import { useProjectRuns } from '@/lib/useProjectRuns';
import { useEffect, useMemo, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { useT } from "@/lib/prefs";
import { api } from "@/lib/api";
import type { ScoreboardRow } from "@/lib/types";

/**
 * 记分板（07 T-18）：每行一个 binding。人看到的是「哪一版生成器、哪个模型、哪个运行时、在哪条谱系上得了几分」。
 * 不提供编辑——记分板由工具追加。正式配对由外部评估工具完成；此页只读展示。
 */
const b = (r: ScoreboardRow, k: string): unknown => {
  if (k === "heldOut") return r.heldOutCoverage ?? r.heldOut;
  if (k === "tokens") return (r.binding?.spend as {tokens?: number} | undefined)?.tokens ?? r.tokens;
  return r.binding?.[k] ?? r[k];
};
const num = (v: unknown): string => (typeof v === "number" ? (v <= 1 ? `${Math.round(v * 100)}%` : String(v)) : v && typeof v === "object" ? num((v as Record<string, unknown>).coverage ?? (v as Record<string, unknown>).score) : "—");

export function ScoreboardPage() {
  const t = useT();
  const projectId=useStore(s=>s.activeProjectId);
  const projectRuns=useProjectRuns(projectId);
  const [scope,setScope]=useState("project");
  const [allRows, setRows] = useState<ScoreboardRow[]>([]);
  const [caps, setCaps] = useState<string[]>([]);
  const [cap, setCap] = useState<string>("");
  const [error, setError] = useState("");
  const [loading,setLoading] = useState(true);
  const [revision,setRevision] = useState(0);
  const [diagnostics,setDiagnostics] = useState<Array<{id:string;status:string;error?:string;graphId:string;projectId?:string}>>([]);
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    api.getScoreboard(undefined, scope === 'research').then(r => {
      if (!active) return;
      setRows(r.entries); setCaps(r.capabilities); setDiagnostics(r.diagnostics ?? []);
      setCap(old => r.capabilities.includes(old) ? old : "");
    }).catch(e => { if (active) setError(String(e.message ?? e)); }).finally(()=>{if(active)setLoading(false);});
    return () => { active = false; };
  }, [scope, revision]);

  const visibleDiagnostics = diagnostics.filter(row=>scope==="research" || (!!projectId && row.projectId===projectId));
  const rows=allRows.filter(row=>(!cap || row.capability===cap) && (scope==='research' || (!!projectId && (row.projectId===projectId || projectRuns.runs.some(run=>run.id===row.runId)))));
  const groups = useMemo(() => {
    const m = new Map<string, number[]>();
    rows.forEach((r, i) => { const g = JSON.stringify([b(r,"goldHash"),b(r,"inputHash"),b(r,"materialsHash"),b(r,"runtime"),b(r,"model"),b(r,"skillVersion"),b(r,"promptsDigest")]); m.set(g, [...(m.get(g) ?? []), i]); });
    return m;
  }, [rows]);
  const cols = ["capability", "runId", "runtime", "skillVersion", "model", "promptsDigest", "materialsHash", "inputHash", "goldHash", "coverage", "heldOut", "gate", "tokens"];
  return (
    <div className="flex h-full flex-col">
      <TopBar title={t("surface.scoreboard")} hint={t("scoreboard.hint")} />
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
        <select aria-label={t('bench.evalScope')} className="rounded border border-border bg-background px-3 py-2" value={scope} onChange={e=>setScope(e.target.value)}><option value="project">{t('bench.currentProject')}</option><option value="research">{t('bench.researchHistory')}</option></select>
        <label>{t("scoreboard.capability")}
          <select className="ml-2 rounded border bg-background px-2 py-1" value={cap} onChange={(e) => { setCap(e.target.value); }}>
            <option value="">{t("scoreboard.all")}</option>
            {caps.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <span className="text-muted-foreground">{t("scoreboard.groups")}: {groups.size}</span>
        <button className="rounded border px-3 py-1" onClick={()=>setRevision(v=>v+1)}>{t("evaldesk.refresh")}</button>
      </div>
      {(error || (scope === "project" && projectRuns.error)) && <div role="alert" className="px-4 text-sm text-destructive">{error || projectRuns.error}</div>}<p className="px-4 py-3 text-sm text-muted-foreground">{t("scoreboard.sourceNote")}</p>
      <div className="flex-1 overflow-auto px-4">
        <div className="my-4"><EvidenceStudy readOnly /></div>
        {loading ? <p role="status" className="py-8">{t("evaldesk.loading")}</p> : rows.length === 0 ? (
          <div className="py-8 text-sm text-muted-foreground">{t(scope === "project" && !projectId ? "scoreboard.selectProject" : "scoreboard.empty")}</div>
        ) : (
          <table className="w-full text-[0.75rem]">
            <thead><tr className="text-left text-muted-foreground">{cols.map((c) => <th key={c} className="py-1 pr-3">{c}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => {
                return (
                  <tr key={i} className="border-t">
                    {cols.map((c) => {
                      const v = c === "model" ? (b(r, "model") as { model?: string } | undefined)?.model : c === "promptsDigest" ? (b(r, "promptsDigest") as { combined?: string } | undefined)?.combined?.slice(0, 8) : c === "coverage" || c === "heldOut" || c === "gate" ? num(b(r, c)) : b(r, c);
                      return <td key={c} className="py-1 pr-3 font-mono">{v === undefined || v === null ? "—" : String(v)}</td>;
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {<section className="my-6 border-t border-border pt-4"><h2 className="text-sm font-semibold">{t("scoreboard.diagnostics")}</h2><p className="my-2 text-xs text-muted-foreground">{t("scoreboard.diagnosticNote")}</p>{visibleDiagnostics.map(row=><a key={row.id} className="my-2 block rounded border border-border p-3 text-xs" href={`#/?open=evals&evalId=${encodeURIComponent(row.id)}`}>{row.id} · {row.graphId} · {row.status}{row.error ? ` · ${row.error}` : ""}</a>)}{!visibleDiagnostics.length && <p className="text-xs text-muted-foreground">{t("evaldesk.emptyRuns")}</p>}</section>}
      </div>
    </div>
  );
}
