import {useEffect,useState} from 'react';
import {useT} from '@/lib/prefs';
import {API_BASE} from '@/lib/base';
import {useProjectRuns} from '@/lib/useProjectRuns';
import {comparisonNodes,type ArtifactComparison,type ComparisonReview,type ComparisonMode,type ComparisonNode,type ComparisonVerdict} from '@/lib/artifactComparison';
import {workflowBase,type Revision} from '@/lib/workflowRuns';
import {RevisionContent} from './RevisionViewer';
import {Button} from '@/components/ui';

const requestedComparison=()=>typeof window==='undefined'?'':new URLSearchParams(window.location.hash.split('?')[1]).get('comparison')??'';
type Saved={revision:Revision;comparison:ArtifactComparison;reviews:{revision:Revision;review:ComparisonReview}[]};
async function request<T>(path:string,signal?:AbortSignal,body?:unknown):Promise<T>{
  const response=await fetch(`${API_BASE}/api/${path}`,{signal,credentials:'include',...(body!==undefined?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  const data=await response.json();if(!response.ok)throw new Error(data.error??'request_failed');return data;
}
const inputClass='min-w-0 w-full rounded border border-border bg-background p-2 text-sm';
function ArtifactPane({projectId,revisions,label}:{projectId:string;revisions:Revision[];label:string}){
  const t=useT(),[id,setId]=useState(''),[value,setValue]=useState<{id:string;content:unknown;error?:string}|null>(null);
  const selected=revisions.find(r=>r.id===id)??revisions[0];
  useEffect(()=>{if(!selected)return;const c=new AbortController();setValue(null);void request<{content:unknown}>(`${workflowBase(projectId)}/${selected.runId}/artifacts/${selected.id}`,c.signal).then(r=>{if(!c.signal.aborted)setValue({id:selected.id,content:r.content});}).catch(e=>{if(!c.signal.aborted)setValue({id:selected.id,content:null,error:e.message});});return()=>c.abort();},[projectId,selected?.id]);
  return <section className="min-w-0 space-y-3 rounded border border-border p-3"><h4 className="font-medium">{label}</h4>
    {!selected?<p className="text-sm text-muted-foreground">{t('compare.noOutput')}</p>:<>
      <select aria-label={label} className={inputClass} value={selected.id} onChange={e=>setId(e.target.value)}>{revisions.map(r=><option key={r.id} value={r.id}>{r.name} · v{r.revision}</option>)}</select>
      <p className="break-all font-mono text-xs text-muted-foreground">{selected.id}</p>
      <a className="text-sm text-primary underline" href={`#/?open=canvas&project=${encodeURIComponent(projectId)}&run=${encodeURIComponent(selected.runId)}&artifact=${encodeURIComponent(selected.id)}`}>{t('compare.openArtifact')}</a>
      <div className="max-h-[36rem] overflow-auto break-words">{value?.id!==selected.id?<p>{t('compare.loading')}</p>:value.error?<p role="alert" className="text-bad">{value.error}</p>:<RevisionContent kind={selected.kind} content={value.content}/>}</div>
    </>}
  </section>;
}
export function ComparisonSummary({value}:{value:ArtifactComparison}){
  const t=useT();return <div className="space-y-3">
    <p className="text-sm font-medium">{t(`compare.mode.${value.mode}`)} · {t(`compare.node.${value.node}`)}</p>
    <div className="grid gap-3 md:grid-cols-2">{(['a','b'] as const).map(arm=><div key={arm} className="min-w-0 rounded border border-border p-3"><p className="text-sm font-medium">{t(`compare.${arm}`)}</p><a className="break-all font-mono text-xs text-primary underline" href={`#/?open=canvas&project=${encodeURIComponent(value.projectId)}&run=${encodeURIComponent(value[arm].runId)}`}>{value[arm].runId}</a></div>)}</div>
    <p className="rounded border border-warn/30 bg-warn-soft p-3 text-sm">{t('compare.boundary')}</p>
    <div className="overflow-x-auto"><table className="w-full text-left text-xs"><caption className="mb-2 text-left font-medium">{t('compare.versions')}</caption><thead><tr>{['field','a','b','status'].map(k=><th key={k} className="p-2">{t(`compare.${k}`)}</th>)}</tr></thead><tbody>{value.differences.map(d=><tr key={d.field} className="border-t border-border"><th className="p-2">{d.field.startsWith('inputs.')?`${t('compare.inputs')} · ${t(`compare.node.${d.field.slice(7)}`)}`:t(`compare.field.${d.field}`)}</th><td className="max-w-36 break-all p-2" title={d.a??''}>{d.a?.slice(0,16)??t('compare.unknown')}</td><td className="max-w-36 break-all p-2" title={d.b??''}>{d.b?.slice(0,16)??t('compare.unknown')}</td><td className="p-2">{t(`compare.status.${d.status}`)}</td></tr>)}</tbody></table></div>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="mb-2 text-left font-medium">{t('compare.global')}</caption><thead><tr><th>{t('compare.node')}</th><th>A</th><th>B</th></tr></thead><tbody>{comparisonNodes.map(n=><tr key={n} className="border-t border-border"><th className="p-2">{t(`compare.node.${n}`)}</th>{[value.a,value.b].map((a,i)=><td className="p-2" key={i}>{a.nodes[n].outputs.length?`${a.nodes[n].outputs.length} ${t('compare.artifacts')}`:t('compare.noOutput')}</td>)}</tr>)}</tbody></table></div>
  </div>;
}
function ComparisonWorkbench({projectId}:{projectId:string}){
  const t=useT(),runs=useProjectRuns(projectId);
  const [a,setA]=useState(''),[b,setB]=useState(''),[mode,setMode]=useState<ComparisonMode>('pipeline'),[node,setNode]=useState<ComparisonNode|'all'>('all');
  const [history,setHistory]=useState<Revision[]>([]),[id,setId]=useState(requestedComparison),[saved,setSaved]=useState<Saved|null>(null),[version,setVersion]=useState(0);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[view,setView]=useState<ComparisonNode>('source'),[input,setInput]=useState(false);
  const [reviewGlobal,setReviewGlobal]=useState(false),[dimension,setDimension]=useState<ComparisonReview['dimension']>('overall'),[verdict,setVerdict]=useState<ComparisonVerdict>('incomparable'),[note,setNote]=useState(''),[evidence,setEvidence]=useState<string[]>([]);
  const base=`projects/${encodeURIComponent(projectId)}/artifact-comparisons`;
  useEffect(()=>{const c=new AbortController();void request<{comparisons:Revision[]}>(base,c.signal).then(r=>{setHistory(r.comparisons);}).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[base,version]);
  useEffect(()=>{setSaved(null);setEvidence([]);setNote('');setReviewGlobal(false);if(!id)return;const c=new AbortController();void request<Saved>(`${base}/${id}`,c.signal).then(r=>{if(!c.signal.aborted){setSaved(r);if(r.comparison.node!=='all')setView(r.comparison.node);}}).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[base,id,version]);
  const create=async()=>{setBusy(true);setError('');try{const r=await request<{revision:Revision}>(base,undefined,{a:{runId:a},b:{runId:b},mode,node});setId(r.revision.id);setVersion(v=>v+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const review=async()=>{if(!saved)return;setBusy(true);setError('');try{await request(`${base}/${saved.revision.id}/reviews`,undefined,{node:reviewGlobal?'all':view,dimension,verdict,note,evidence});setVersion(v=>v+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const refs=saved?[...new Map([saved.comparison.a,saved.comparison.b].flatMap(arm=>(reviewGlobal?comparisonNodes:[view]).flatMap(n=>[...arm.nodes[n].inputs,...arm.nodes[n].outputs])).map(r=>[r.id,r])).values()]:[];
  return <div className="space-y-5 pt-4">
    <p className="text-sm text-muted-foreground">{t('compare.description')}</p>
    <div className="grid gap-3 md:grid-cols-2">{(['a','b'] as const).map(arm=><label className="min-w-0 space-y-1 text-sm" key={arm}>{t(`compare.${arm}`)}<select aria-label={t(`compare.${arm}`)} className={inputClass} value={arm==='a'?a:b} onChange={e=>(arm==='a'?setA:setB)(e.target.value)}><option value="">{t('compare.selectRun')}</option>{runs.runs.map(r=><option key={r.id} value={r.id}>{r.id} · {r.status}</option>)}</select></label>)}
      <label className="space-y-1 text-sm">{t('compare.mode')}<select aria-label={t('compare.mode')} className={inputClass} value={mode} onChange={e=>setMode(e.target.value as ComparisonMode)}>{(['pipeline','node-version','input-version'] as const).map(m=><option key={m} value={m}>{t(`compare.mode.${m}`)}</option>)}</select></label>
      <label className="space-y-1 text-sm">{t('compare.scope')}<select aria-label={t('compare.scope')} className={inputClass} value={node} onChange={e=>setNode(e.target.value as typeof node)}>{['all',...comparisonNodes].map(n=><option key={n} value={n}>{t(`compare.node.${n}`)}</option>)}</select></label>
    </div>
    <p className="text-sm text-muted-foreground">{t(`compare.modeHint.${mode}`)}</p>
    <Button disabled={busy||!a||!b||a===b} onClick={()=>void create()}>{t('compare.create')}</Button>
    {(error||runs.error)&&<p role="alert" className="break-words text-sm text-bad">{error||runs.error}</p>}
    <label className="block space-y-1 text-sm">{t('compare.history')}<select aria-label={t('compare.history')} className={inputClass} value={id} onChange={e=>{setId(e.target.value);setError('');}}><option value="">{t('compare.selectComparison')}</option>{history.map(r=><option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString()} · {r.id}</option>)}</select></label>
    {id&&!saved&&<p>{t('compare.loading')}</p>}
    {saved&&<>
      <ComparisonSummary value={saved.comparison}/>
      <div className="flex flex-wrap items-end gap-3"><label className="text-sm">{t('compare.node')}<select aria-label={t('compare.node')} className={inputClass} value={view} onChange={e=>{setView(e.target.value as ComparisonNode);setEvidence([]);setNote('');}}>{(saved.comparison.node==='all'?comparisonNodes:[saved.comparison.node]).map(n=><option key={n} value={n}>{t(`compare.node.${n}`)}</option>)}</select></label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={input} onChange={e=>setInput(e.target.checked)}/>{t('compare.showInputs')}</label></div>
      <div className="grid gap-4 xl:grid-cols-2">{(['a','b'] as const).map(arm=><ArtifactPane key={`${saved.revision.id}-${arm}-${view}-${input}`} projectId={projectId} revisions={saved.comparison[arm].nodes[view][input?'inputs':'outputs']} label={`${arm.toUpperCase()} · ${t(input?'compare.inputs':'compare.outputs')}`} />)}</div>
      <fieldset className="space-y-3 rounded border border-border p-4"><legend className="px-2 text-sm font-medium">{t('compare.review')}</legend><p className="text-sm text-muted-foreground">{t('compare.reviewBoundary')}</p>{saved.comparison.node==='all'&&<label className="flex gap-2 text-sm"><input type="checkbox" checked={reviewGlobal} onChange={e=>{setReviewGlobal(e.target.checked);setEvidence([]);}}/>{t('compare.reviewGlobal')}</label>}
        <div className="grid gap-3 md:grid-cols-2"><label className="text-sm">{t('compare.dimension')}<select aria-label={t('compare.dimension')} className={inputClass} value={dimension} onChange={e=>setDimension(e.target.value as typeof dimension)}>{['overall','coverage','correctness','evidence','usability','noise'].map(d=><option key={d} value={d}>{t(`compare.dimension.${d}`)}</option>)}</select></label><label className="text-sm">{t('compare.verdict')}<select aria-label={t('compare.verdict')} className={inputClass} value={verdict} onChange={e=>setVerdict(e.target.value as ComparisonVerdict)}>{['a-better','same','b-better','incomparable'].map(v=><option key={v} value={v}>{t(`compare.verdict.${v}`)}</option>)}</select></label></div>
        <label className="block text-sm">{t('compare.reason')}<textarea className={inputClass} rows={3} value={note} onChange={e=>setNote(e.target.value)} maxLength={4000}/></label>
        <p className="text-sm">{t('compare.evidence')}</p><div className="max-h-48 space-y-2 overflow-auto">{refs.map(r=><label key={r.id} className="flex items-start gap-2 break-all text-xs"><input type="checkbox" checked={evidence.includes(r.id)} onChange={e=>setEvidence(old=>e.target.checked?[...old,r.id]:old.filter(v=>v!==r.id))}/><span>{r.name} · v{r.revision} · {r.id}</span></label>)}</div>
        <Button disabled={busy||note.trim().length<10||!evidence.length} onClick={()=>void review()}>{t('compare.saveReview')}</Button>
      </fieldset>
      <section className="space-y-3"><h3 className="font-medium">{t('compare.reviews')}</h3>{!saved.reviews.length?<p className="text-sm text-muted-foreground">{t('compare.noReviews')}</p>:saved.reviews.map(({revision,review:r})=><article key={revision.id} className="rounded border border-border p-3 text-sm"><p className="font-medium">{t(`compare.node.${r.node}`)} · {t(`compare.dimension.${r.dimension}`)} · {t(`compare.verdict.${r.verdict}`)}</p><p className="mt-2 whitespace-pre-wrap break-words">{r.note}</p><p className="mt-2 text-xs text-muted-foreground">{r.actor.id} · {new Date(r.at).toLocaleString()}</p><p className="mt-2 break-all font-mono text-xs">{r.evidence.join(' · ')}</p></article>)}</section>
    </>}
  </div>;
}
export function ArtifactComparisons({projectId}:{projectId:string}){
  const t=useT(),[open,setOpen]=useState(()=>!!requestedComparison());
  return <details open={open} className="rounded-lg border border-border bg-card p-4" onToggle={e=>setOpen(e.currentTarget.open)}><summary className="cursor-pointer text-base font-semibold">{t('compare.title')}</summary>{open&&<ComparisonWorkbench key={projectId} projectId={projectId}/>}</details>;
}
