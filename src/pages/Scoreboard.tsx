import { useStore } from '@/lib/store';
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
const b = (r: ScoreboardRow, k: string): unknown => (r.binding as Record<string, unknown> | undefined)?.[k] ?? r[k];
const num = (v: unknown): string => (typeof v === "number" ? (v <= 1 ? `${Math.round(v * 100)}%` : String(v)) : v && typeof v === "object" ? num((v as Record<string, unknown>).coverage ?? (v as Record<string, unknown>).score) : "—");

export function ScoreboardPage() {
  const t = useT();
  const projectId=useStore(s=>s.activeProjectId);
  const projectRuns=useProjectRuns(projectId);
  const [scope,setScope]=useState("project");
  const [allRows, setRows] = useState<ScoreboardRow[]>([]);
  const [caps, setCaps] = useState<string[]>([]);
  const [cap, setCap] = useState<string>("");
  const [penguinUrl,setPenguinUrl] = useState("http://127.0.0.1:7365");
  const [activeVersion,setActiveVersion] = useState<string>("—");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    api.getScoreboard(cap || undefined).then((r) => { setRows(r.entries); setCaps(r.capabilities); if(r.penguinUrl)setPenguinUrl(r.penguinUrl);if(r.activeVersion)setActiveVersion(`${r.activeVersion.version} · ${r.activeVersion.generation}`); }).catch((e) => setError(String(e.message ?? e)));
  }, [cap]);

  const rows=scope==='research'?allRows:allRows.filter(row=>projectRuns.runs.some(run=>run.id===row.runId));
  const groups = useMemo(() => {
    const m = new Map<string, number[]>();
    rows.forEach((r, i) => { const g = JSON.stringify([b(r,"goldHash"),b(r,"inputHash"),b(r,"runtime"),b(r,"model")]); m.set(g, [...(m.get(g) ?? []), i]); });
    return m;
  }, [rows]);
  const cols = ["capability", "runId", "runtime", "skillVersion", "model", "promptsDigest", "materialsHash", "inputHash", "goldHash", "coverage", "heldOut", "gate", "tokens", "n"];
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
        <a className="rounded border px-3 py-1" href={penguinUrl} target="_blank" rel="noreferrer">{t('scoreboard.openPenguin')}</a>
        <span className="text-xs text-muted-foreground"><code>{activeVersion}</code></span>
      </div>
      {error && <div className="px-4 text-sm text-destructive">{error}</div>}
      <div className="flex-1 overflow-auto px-4">
        {rows.length === 0 ? (
          <div className="py-8 text-sm text-muted-foreground">{t("scoreboard.empty")}</div>
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
      </div>
    </div>
  );
}
