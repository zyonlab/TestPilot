import { useEffect, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { useT } from "@/lib/prefs";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { GoldFile, GoldItem, GoldState } from "@/lib/types";

/**
 * gold 生命周期（07 T-19）：草稿 → 复核 → 标留出 → 冻结。
 * 这一屏的每次写都记录本地操作来源（不验证个人身份）；冻结不可撤销——冻结即新谱系。
 * T-20 的 stale 标记也在这里显示（条目挂到路由/组件，代码一动就该复核）。
 */
export function GoldPage() {
  const t = useT();
  const [caps, setCaps] = useState<string[]>([]);
  const [cap, setCap] = useState("");
  const [state, setState] = useState<GoldState | null>(null);
  const [file, setFile] = useState<GoldFile | null>(null);
  const [invalidMatches, setInvalidMatches] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [msg, setMsg] = useState("");

  useEffect(() => { api.getScoreboard().then((r) => { setCaps(r.capabilities); if (!cap && r.capabilities[0]) setCap(r.capabilities[0]); }).catch(() => {}); }, []);
  const load = (c: string) => api.getGold(c).then((s) => { setState(s); setFile(s.gold ?? s.draft); setConfirmed([]); setInvalidMatches([]); setMsg(""); }).catch((e) => setMsg(String(e.message ?? e)));
  useEffect(() => { if (cap) void load(cap); }, [cap]);

  const frozen = !!state?.frozenHash;
  const tampered = !!state?.frozenHash && !!state.currentHash && state.frozenHash !== state.currentHash;
  const edit = (i: number, patch: Partial<GoldItem>) => { if (!file) return; setConfirmed(ids => ids.filter(id => id !== file.items[i].id)); setFile({ ...file, items: file.items.map((it, k) => (k === i ? { ...it, ...patch, reviewReceipt: undefined } : it)) }); };
  const remove = (i: number) => file && setFile({ ...file, items: file.items.filter((_, k) => k !== i) });
  const save = async (newLineage = false) => {
    if (!file) return;
    try { const r = await api.saveGold(cap, file, newLineage, confirmed); setMsg(`${t("gold.saved")} ${r.saved.hash} · heldOut ${r.saved.heldOut}`); setState(r.state); setFile(r.state.gold ?? r.state.draft); setConfirmed([]); }
    catch (e) { setMsg(String((e as Error).message ?? e)); }
  };
  const freeze = async () => {
    if (!window.confirm(t("gold.freezeConfirm"))) return;
    try { const r = await api.freezeGold(cap); setMsg(`${t("gold.frozen")} ${r.frozen.hash}`); setState(r.state); }
    catch (e) { setMsg(String((e as Error).message ?? e)); }
  };

  return (
    <div className="flex h-full flex-col">
      <TopBar title={t("surface.gold")} hint={t("gold.hint")} />
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
        <select className="rounded border bg-background px-2 py-1" value={cap} onChange={(e) => setCap(e.target.value)}>
          {caps.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {state && (
          <span className={cn("rounded px-2 py-0.5 text-xs", frozen ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900")}>
            {frozen ? `${t("gold.frozenBadge")} ${state.frozenHash}` : state.gold ? t("gold.reviewedBadge") : t("gold.draftBadge")}
          </span>
        )}
        {tampered && <span className="text-xs text-destructive">{t("gold.tampered")}</span>}
        <button className="rounded border px-3 py-1 disabled:opacity-40" disabled={!file || frozen || !!invalidMatches.length} onClick={() => void save(false)}>{t("gold.save")}</button>
        <button className="rounded border px-3 py-1 disabled:opacity-40" disabled={!state?.gold || frozen || !!invalidMatches.length} onClick={() => void freeze()}>{t("gold.freeze")}</button>
        {frozen && <button className="rounded border px-3 py-1" onClick={() => window.confirm(t("gold.newLineageConfirm")) && void save(true)}>{t("gold.newLineage")}</button>}
      </div>
      {msg && <div className="px-4 text-sm">{msg}</div>}
      {state && (
        <div className="px-4 text-xs text-muted-foreground">
          {t("gold.checklist")}: {state.checklist.map((c, i) => <span key={i} className="mr-3">☐ {c}</span>)}
        </div>
      )}
      <div className="flex-1 overflow-auto px-4 py-2">
        {!file ? (
          <div className="py-8 text-sm text-muted-foreground">{t("gold.empty")}</div>
        ) : (
          <table className="w-full text-[0.75rem]">
            <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2">id</th><th className="py-1 pr-2">title</th><th className="py-1 pr-2">match</th><th className="py-1 pr-2">heldOut</th><th className="py-1 pr-2">anchors</th><th className="py-1 pr-2">stale</th><th /></tr></thead>
            <tbody>
              {file.items.map((it, i) => (
                <tr key={it.id} className={cn("border-t align-top", it.stale && "bg-amber-50")}>
                  <td className="py-1 pr-2 font-mono">{it.id}</td>
                  <td className="py-1 pr-2"><input className="w-full rounded border bg-background px-1" disabled={frozen} value={it.title} onChange={(e) => { edit(i, { title: e.target.value, reviewReceipt: undefined }); setConfirmed(ids => ids.filter(id => id !== it.id)); }} />
                    {file.reviewPolicy === 'individual-v1' && <div className="mt-2 space-y-1"><label className="block">Expected<textarea aria-label="Expected" className="w-full rounded border bg-background px-1" disabled={frozen} value={it.expected ?? ''} onChange={e => edit(i,{expected:e.target.value})} /></label>
                    <label className="block">Rule family<input aria-label="Rule family" className="w-full rounded border bg-background px-1" disabled={frozen} value={it.ruleFamily??''} onChange={e=>edit(i,{ruleFamily:e.target.value})}/></label>
                    <label className="block">Split<select aria-label="Split" disabled={frozen} value={it.split??'train'} onChange={e=>edit(i,{split:e.target.value as GoldItem['split'],heldOut:e.target.value==='heldout'})}>{['train','dev','heldout'].map(v=><option key={v}>{v}</option>)}</select></label>
                    <label className="block">Sources<textarea aria-label="Sources" className="w-full rounded border bg-background px-1" disabled={frozen} value={it.sourceRefs?.join('\n')??''} onChange={e=>edit(i,{sourceRefs:e.target.value.split('\n').filter(Boolean)})}/></label><label className="flex items-start gap-2"><input type="checkbox" disabled={frozen} checked={confirmed.includes(it.id)} onChange={e => setConfirmed(ids => e.target.checked ? [...ids,it.id] : ids.filter(id => id !== it.id))} />{t('gold.confirmItem')}</label>{it.reviewReceipt && <p>{t('gold.itemReviewed')}: {it.reviewReceipt.reviewer} · {it.reviewReceipt.at}</p>}</div>}
                  </td>
                  <td className="py-1 pr-2 font-mono text-[0.6875rem]"><MatchEditor onValidity={valid=>setInvalidMatches(ids=>valid?ids.filter(id=>id!==it.id):[...new Set([...ids,it.id])])} value={it.match} disabled={frozen} onChange={match=>edit(i,{match})} /></td>
                  <td className="py-1 pr-2"><input type="checkbox" disabled={frozen} checked={!!it.heldOut} onChange={(e) => { edit(i, { heldOut: e.target.checked, ...(file.reviewPolicy ? { split: e.target.checked ? "heldout" : "dev", reviewReceipt: undefined } : {}) }); setConfirmed(ids => ids.filter(id => id !== it.id)); }} /></td>
                  <td className="py-1 pr-2 font-mono text-[0.6875rem]">{(it.anchors ?? []).join(", ") || "—"}</td>
                  <td className="py-1 pr-2">{it.stale ? t("gold.stale") : ""}</td>
                  <td className="py-1"><button className="text-destructive disabled:opacity-30" disabled={frozen} onClick={() => remove(i)}>{t("gold.remove")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function MatchEditor({value,disabled,onChange,onValidity}:{onValidity:(valid:boolean)=>void;value:Record<string,unknown>;disabled:boolean;onChange:(v:Record<string,unknown>)=>void}) {
 const [text,setText]=useState(JSON.stringify(value,null,2));const [error,setError]=useState('');
 useEffect(()=>{setText(JSON.stringify(value,null,2));setError('');},[value]);
 return <><textarea aria-label="Match JSON" className="min-w-48 rounded border bg-background p-1" rows={5} value={text} disabled={disabled} onChange={e=>{setText(e.target.value);setError('');onValidity(false);}} onBlur={()=>{try{const parsed=JSON.parse(text);if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw new Error('Expected a JSON object');onChange(parsed);onValidity(true);setError('');}catch{onValidity(false);setError('Invalid JSON: changes were not applied');}}}/>{error&&<p role="alert" className="text-destructive">{error}</p>}</>;
}
