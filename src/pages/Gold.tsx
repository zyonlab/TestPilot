import { useEffect, useState } from "react";
import { Lifecycle } from "@/components/Lifecycle";
import { TopBar } from "@/components/TopBar";
import { useT } from "@/lib/prefs";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { API_BASE } from "@/lib/base";
import { cn } from "@/lib/cn";
import type { GoldFile, GoldItem, GoldState } from "@/lib/types";

/**
 * gold 生命周期（07 T-19）：草稿 → 复核 → 标留出 → 冻结。
 * 这一屏的每次写都记录本地操作来源（不验证个人身份）；冻结不可撤销——冻结即新谱系。
 * T-20 的 stale 标记也在这里显示（条目挂到路由/组件，代码一动就该复核）。
 */
export function GoldPage() {
  const t = useT();
  const projectId = useStore(s=>s.activeProjectId);
  const [draftText,setDraftText] = useState("");
  const createDraft = async () => {
    setBusy(true); setError("");
    try {
      const candidate = JSON.parse(draftText);
      const response = await fetch(`${API_BASE}/api/gold`, {method:"POST",headers:{"content-type":"application/json"},credentials:"include",body:JSON.stringify({capability:candidate.id,file:candidate,projectId})});
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setCap(data.state.capability); setDraftText(""); setRevision(v=>v+1);
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const [includeArchived, setIncludeArchived] = useState(false);
  const [caps, setCaps] = useState<string[]>([]);
  const [cap, setCap] = useState(() => new URLSearchParams(window.location.hash.split("?")[1]).get("capability") ?? "");
  const [state, setState] = useState<GoldState | null>(null);
  const [file, setFile] = useState<GoldFile | null>(null);
  const [invalidMatches, setInvalidMatches] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [msg, setMsg] = useState("");

  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    api.getScoreboard(undefined, includeArchived).then(async r => {
      const datasets = await Promise.all(r.capabilities.map(c=>api.getGold(c)));
      const available = datasets.filter(s=>s.projectId===projectId).map(s=>s.capability);
      if (!active) return;
      setCaps(available);
      setCap(current => available.includes(current) ? current : available[0] ?? "");
      if (!available.length) { setLoading(false); setState(null); setFile(null); }
    }).catch(e => { if (active) { setError(String(e.message ?? e)); setLoading(false); } });
    return () => { active = false; };
  }, [revision, includeArchived, projectId]);
  useEffect(() => {
    if (!cap) return;
    let active = true;
    setLoading(true); setState(null); setFile(null); setError(""); setMsg("");
    setConfirmed([]); setInvalidMatches([]);
    api.getGold(cap).then(s => { if (active) { setState(s); setFile(s.gold ?? s.draft); } })
      .catch(e => { if (active) setError(String(e.message ?? e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [cap, revision]);

  const frozen = !!state?.frozenHash;
  const tampered = !!state?.frozenHash && !!state.currentHash && state.frozenHash !== state.currentHash;
  const dirty = !!file && (JSON.stringify(file) !== JSON.stringify(state?.gold ?? state?.draft) || confirmed.length > 0);
  const locked = frozen || !!state?.archived || loading || busy;
  const reviewed = file?.items.filter(item => !!item.reviewReceipt && !item.stale).length ?? 0;
  const reviewReady = !!file?.items.length && file.reviewPolicy === 'individual-v1' && reviewed === file.items.length && !state?.reviewIssues?.length;
  const dev = file?.items.filter(item => item.split === 'dev').length ?? 0;
  const train = file?.items.filter(item => item.split === 'train').length ?? 0;
  const heldout = file?.items.filter(item => item.heldOut).length ?? 0;
  const usable = state?.projectId === projectId && dev > 0 && heldout > 0 && frozen && !tampered && !state?.archived && reviewReady && !dirty;
  const canFreeze = !!state?.gold && !locked && !dirty && !invalidMatches.length && (file?.reviewPolicy !== "individual-v1" || reviewReady) && !!file?.items.some(item => item.heldOut);
  const edit = (i: number, patch: Partial<GoldItem>) => { if (!file) return; setConfirmed(ids => ids.filter(id => id !== file.items[i].id)); setFile({ ...file, items: file.items.map((it, k) => (k === i ? { ...it, ...patch, reviewReceipt: undefined } : it)) }); };
  const remove = (i: number) => file && setFile({ ...file, items: file.items.filter((_, k) => k !== i) });
  const save = async (newLineage = false) => {
    if (!file || loading || busy || error) return;
    setBusy(true);
    try { const r = await api.saveGold(cap, file, newLineage, confirmed); setMsg(`${t("gold.saved")} ${r.saved.hash} · heldOut ${r.saved.heldOut}`); setState(r.state); setFile(r.state.gold ?? r.state.draft); setConfirmed([]); }
    catch (e) { setMsg(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };
  const freeze = async () => {
    if (!canFreeze || !window.confirm(t("gold.freezeConfirm"))) return;
    setBusy(true);
    try { const r = await api.freezeGold(cap); setMsg(`${t("gold.frozen")} ${r.frozen.hash}`); setState(r.state); }
    catch (e) { setMsg(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex h-full flex-col overflow-auto">
      <TopBar title={t("surface.gold")} hint={t("gold.hint")} />
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={includeArchived} disabled={busy} onChange={e=>setIncludeArchived(e.target.checked)} />{t("gold.archivedToggle")}</label>
        <select aria-label={t("gold.capability")} disabled={busy} className="rounded border bg-background px-2 py-1" value={cap} onChange={(e) => { setState(null); setFile(null); setLoading(true); setCap(e.target.value); }}>
          {caps.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {state && (
          <span className={cn("rounded px-2 py-0.5 text-xs", frozen ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900")}>
            {frozen ? `${t("gold.frozenBadge")} ${state.frozenHash}` : reviewReady ? t("gold.reviewedBadge") : state.gold ? t("life.saved") : t("gold.draftBadge")}
          </span>
        )}
        {tampered && <span className="text-xs text-destructive">{t("gold.tampered")}</span>}
        <button className="rounded border px-3 py-1 disabled:opacity-40" disabled={!file || locked || !!error || !!invalidMatches.length} onClick={() => void save(false)}>{t("gold.save")}</button>
        <button className="rounded border px-3 py-1 disabled:opacity-40" disabled={!canFreeze || !!error} onClick={() => void freeze()}>{t("gold.freeze")}</button>
        {frozen && !state?.archived && <button disabled={busy || loading} className="rounded border px-3 py-1" onClick={() => window.confirm(t("gold.newLineageConfirm")) && void save(true)}>{t("gold.newLineage")}</button>}
      </div>
      <div className="mx-4 my-4">{usable && <p role="status" className="mb-4 text-sm font-medium text-primary">{t("life.goldNext")}</p>}{loading ? <p role="status">{t("evaldesk.loading")}</p> : <Lifecycle steps={[
        {title:t("life.draft"),done:!!file?.items.length,detail:t("life.items",{n:file?.items.length??0})},
        {title:t("life.review"),done:reviewReady,detail:t("life.reviews",{n:reviewed,total:file?.items.length??0,pending:confirmed.length})},
        {title:t("life.split"),done:dev>0&&heldout>0,detail:t("life.splits",{train,dev,heldout})},
        {title:t("life.freeze"),done:frozen&&!tampered&&!dirty,detail:t("life.freezeHelp")},
        {title:t("life.use"),done:usable,detail:<>{t("life.useHelp")} {usable&&<a className="text-primary underline" href={`#/?open=evals&project=${encodeURIComponent(projectId)}&capability=${encodeURIComponent(cap)}`}>{t("nav.evals")}</a>}</>},
      ]}/>}<p className="mt-3 text-sm leading-6 text-muted-foreground">{t("life.relationship")}</p>{(tampered||dirty||state?.archived||file?.items.some(i=>i.stale))&&<p className="mt-2 text-sm text-warn">{t("life.attention")}</p>}</div>
      <details className="mx-4 my-2 rounded border border-border p-3"><summary className="cursor-pointer text-sm">{t("gold.createDraft")}</summary><p className="my-2 text-xs text-muted-foreground">{t("gold.createHelp")}</p><textarea aria-label={t("gold.draftJson")} className="w-full rounded border bg-background p-2 font-mono text-xs" rows={7} value={draftText} onChange={e=>setDraftText(e.target.value)} placeholder={'{"id":"my-ui-benchmark","items":[{"id":"G1","title":"...","match":{"anyOf":["..."]}}]}'}/><button className="mt-2 rounded border px-3 py-1 text-sm disabled:opacity-40" disabled={!projectId || !draftText.trim() || busy} onClick={()=>void createDraft()}>{t("gold.createDraft")}</button></details>
      <div className="mx-4 my-2 rounded border border-border bg-muted p-4 text-sm leading-6">
        <p>{t("gold.scopeNew")}</p>{state?.archived && <p className="mt-2 text-warn">{t("gold.archived")}: {state.archiveReason}</p>}
        <p className="mt-2">{t(frozen ? "gold.frozenHelp" : "gold.draftHelp")}</p>
        {file && !frozen && <ul className="mt-2 list-inside list-disc text-muted-foreground">
          {!state?.gold && <li>{t("gold.needSave")}</li>}
          {!file.items.some(item => item.heldOut) && <li>{t("gold.needHeldout")}</li>}
          {dirty && <li>{t("gold.unsaved")}</li>}
        </ul>}
        <a className="mt-2 inline-block text-primary underline" href="#/?open=evals">{t("nav.evals")}</a>
      </div>
      {error && <div role="alert" className="px-4 text-sm text-bad">{error} <button className="underline" onClick={() => setRevision(v => v + 1)}>{t("evaldesk.refresh")}</button></div>}
      {msg && <div role="status" className="px-4 text-sm">{msg}</div>}
      {state && (
        <div className="px-4 text-xs text-muted-foreground">
          <details><summary className="cursor-pointer">{t("life.criteria")}</summary><ul className="mt-2 list-inside list-disc">{state.checklist.map((c, i) => <li key={i}>{c}</li>)}</ul></details>
        </div>
      )}
      <div className="shrink-0 overflow-x-auto px-4 py-2">
        {loading ? <div role="status" className="py-8 text-sm text-muted-foreground">{t("evaldesk.loading")}</div> : !file ? (
          <div className="py-8 text-sm text-muted-foreground">{t("gold.empty")}</div>
        ) : (
          <table className="w-full text-[0.75rem]">
            <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-2">id</th><th className="py-1 pr-2">title</th><th className="py-1 pr-2">match</th><th className="py-1 pr-2">heldOut</th><th className="py-1 pr-2">anchors</th><th className="py-1 pr-2">stale</th><th /></tr></thead>
            <tbody>
              {file.items.map((it, i) => (
                <tr key={`${cap}:${it.id}`} className={cn("border-t align-top", it.stale && "bg-amber-50")}>
                  <td className="py-1 pr-2 font-mono">{it.id}</td>
                  <td className="py-1 pr-2"><input className="w-full rounded border bg-background px-1" disabled={locked} value={it.title} onChange={(e) => { edit(i, { title: e.target.value, reviewReceipt: undefined }); setConfirmed(ids => ids.filter(id => id !== it.id)); }} />
                    {file.reviewPolicy === 'individual-v1' && <div className="mt-2 space-y-1"><label className="block">Expected<textarea aria-label="Expected" className="w-full rounded border bg-background px-1" disabled={locked} value={it.expected ?? ''} onChange={e => edit(i,{expected:e.target.value})} /></label>
                    <label className="block">Rule family<input aria-label="Rule family" className="w-full rounded border bg-background px-1" disabled={locked} value={it.ruleFamily??''} onChange={e=>edit(i,{ruleFamily:e.target.value})}/></label>
                    <label className="block">Split<select aria-label="Split" disabled={locked} value={it.split??'train'} onChange={e=>edit(i,{split:e.target.value as GoldItem['split'],heldOut:e.target.value==='heldout'})}>{['train','dev','heldout'].map(v=><option key={v}>{v}</option>)}</select></label>
                    <label className="block">Sources<textarea aria-label="Sources" className="w-full rounded border bg-background px-1" disabled={locked} value={it.sourceRefs?.join('\n')??''} onChange={e=>edit(i,{sourceRefs:e.target.value.split('\n').filter(Boolean)})}/></label><label className="flex items-start gap-2"><input type="checkbox" disabled={locked} checked={locked ? !!it.reviewReceipt : confirmed.includes(it.id)} onChange={e => setConfirmed(ids => e.target.checked ? [...ids,it.id] : ids.filter(id => id !== it.id))} />{t('gold.confirmItem')}</label>{it.reviewReceipt && <p>{t('gold.itemReviewed')}: {it.reviewReceipt.reviewer} · {it.reviewReceipt.at}</p>}</div>}
                  </td>
                  <td className="py-1 pr-2 font-mono text-[0.6875rem]"><MatchEditor onValidity={valid=>setInvalidMatches(ids=>valid?ids.filter(id=>id!==it.id):[...new Set([...ids,it.id])])} value={it.match} disabled={locked} onChange={match=>edit(i,{match})} /></td>
                  <td className="py-1 pr-2"><input type="checkbox" disabled={locked} checked={!!it.heldOut} onChange={(e) => { edit(i, { heldOut: e.target.checked, ...(file.reviewPolicy ? { split: e.target.checked ? "heldout" : "dev", reviewReceipt: undefined } : {}) }); setConfirmed(ids => ids.filter(id => id !== it.id)); }} /></td>
                  <td className="py-1 pr-2 font-mono text-[0.6875rem]">{(it.anchors ?? []).join(", ") || "—"}</td>
                  <td className="py-1 pr-2">{it.stale ? t("gold.stale") : ""}</td>
                  <td className="py-1"><button className="text-destructive disabled:opacity-30" disabled={locked} onClick={() => remove(i)}>{t("gold.remove")}</button></td>
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
