import { Lifecycle } from "./Lifecycle";
import {useEffect,useState} from 'react';
import {API_BASE} from '@/lib/base';
import {useT} from '@/lib/prefs';

type Metrics={stableKills:number;expectedFaults:number;falseAlarms:number;healthy:number;unobservable:number;unstable:number;ms:number};
type Study={id:string;status:string;stage:string;error?:string;completedTrials?:number;startedAt:string;summary?:{decision:string;baseline:Metrics;candidate:Metrics;validation:{baseline:Metrics;candidate:Metrics}};cost?:{generationCalls:number;tokens:number;usd:null};integrity?:{digest:string};review?:{note:string;decision:string;actor:string};preregistered?:{baselineHash:string;candidateHash:string;datasetHash:string}};
export function EvidenceStudy({readOnly=false}:{readOnly?:boolean}){
 const t=useT(),[rows,setRows]=useState<Study[]>([]),[selected,setSelected]=useState(''),[error,setError]=useState(''),[loadError,setLoadError]=useState(''),[busy,setBusy]=useState(false),[note,setNote]=useState(''),[actor,setActor]=useState('local-operator');
 const refresh=async()=>{try{const r=await fetch(`${API_BASE}/api/evidence-studies`);if(!r.ok)throw new Error(`HTTP ${r.status}`);const data=await r.json();setRows(data.studies);setLoadError('');}catch(e){setLoadError((e as Error).message);}};
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>clearInterval(timer);},[]);
 const current=rows.find(r=>r.id===selected)??rows[0];
 const action=async(path:string,body:unknown)=>{setBusy(true);setError('');try{const r=await fetch(`${API_BASE}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error);setSelected(d.id);await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const link=(file:string)=>`${API_BASE}/api/evidence-studies/${current?.id}/files/${file}`;
 return <section className="space-y-4 rounded-lg border border-border bg-card p-5" aria-label={t('evidence.title')}>
  <div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-lg font-semibold">{t('evidence.title')}</h2><p className="mt-2 max-w-3xl text-sm text-muted-foreground">{t('evidence.scope')}</p></div>{!readOnly&&<button className="rounded border border-border px-4 py-2 text-sm disabled:opacity-50" disabled={busy||rows.some(r=>r.status==='running')} onClick={()=>void action('/api/evidence-studies',{})}>{t('evidence.start')}</button>}</div>
  {(error||loadError)&&<p role="alert" className="text-sm text-bad">{error||loadError}</p>}
  {!rows.length?<p className="text-sm text-muted-foreground">{t('evidence.empty')}</p>:<><label className="block text-sm">{t('evidence.history')}<select className="ml-3 max-w-full rounded border border-border bg-background p-2" value={current?.id} onChange={e=>setSelected(e.target.value)}>{rows.map(r=><option value={r.id} key={r.id}>{new Date(r.startedAt).toLocaleString()} · {r.status} · {r.id.slice(-6)}</option>)}</select></label>
  <Lifecycle steps={[
    {title:t('life.protocol'),done:!!current.preregistered},
    {title:t('life.execute'),done:current.completedTrials===144},
    {title:t('life.score'),done:!!current.summary&&!!current.integrity},
    {title:t('life.decision'),done:!!current.review},
  ]}/>
  <p role="status" className="text-sm">{current.status} · {current.review ? current.review.decision : current.stage} · {current.completedTrials??0}/144</p>
  {current.error&&<p className="break-words text-sm text-bad">{current.error}</p>}
  {current.summary&&<><p className="font-medium text-primary">{current.summary.decision==='bounded-improvement'?t('evidence.improved'):t('evidence.insufficient')}</p><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-border">{['arm','kills','falseAlarms','unobservable','unstable','time'].map(k=><th className="p-2" key={k}>{t(`evidence.${k}`)}</th>)}</tr></thead><tbody>{(['baseline','candidate'] as const).map(a=><tr className="border-b border-border" key={a}><th className="p-2">{t(`evidence.${a}`)}</th><td className="p-2">{current.summary![a].stableKills}/{current.summary![a].expectedFaults}</td><td className="p-2">{current.summary![a].falseAlarms}/{current.summary![a].healthy}</td><td className="p-2">{current.summary![a].unobservable}</td><td className="p-2">{current.summary![a].unstable}</td><td className="p-2">{(current.summary![a].ms/1000).toFixed(1)}s</td></tr>)}</tbody></table></div>
  <p className="text-sm">{t('evidence.validation')}: {current.summary.validation.baseline.stableKills}/{current.summary.validation.baseline.expectedFaults} → {current.summary.validation.candidate.stableKills}/{current.summary.validation.candidate.expectedFaults}</p>
  <p className="text-sm text-muted-foreground">{t('evidence.cost')}: {current.cost?.generationCalls} calls · {current.cost?.tokens} tokens · USD —</p></>}
  {current.preregistered&&<details><summary className="cursor-pointer text-sm">{t('evidence.binding')}</summary><pre className="mt-2 overflow-auto text-xs">{JSON.stringify(current.preregistered,null,2)}</pre></details>}
  <div className="flex flex-wrap gap-4 text-sm text-primary">{['preregistered.json','trials.json','injection-controls.json','frozen-dev.json','frozen-validation.json','seal.json'].map(f=><a key={f} href={link(f)} target="_blank" rel="noreferrer">{f}</a>)}</div>
  {current.review?<p className="rounded bg-muted p-3 text-sm">{t('evidence.reviewed')}: {current.review.decision} · {current.review.actor}<br/>{current.review.note}</p>:!readOnly&&current.status==='done'&&<div className="space-y-3 border-t border-border pt-4"><label className="block text-sm">{t('evidence.actor')}<select className="ml-3 rounded border border-border bg-background p-2" value={actor} onChange={e=>setActor(e.target.value)}><option value="local-operator">{t('evidence.operator')}</option><option value="user-delegated-agent-review">{t('evidence.delegated')}</option></select></label><label className="block text-sm">{t('evidence.reviewNote')}<textarea className="mt-2 block min-h-24 w-full rounded border border-border bg-background p-3" value={note} onChange={e=>setNote(e.target.value)}/></label><div className="flex gap-3">{(['accept-bounded','reject'] as const).map(decision=><button key={decision} disabled={busy||note.trim().length<30||(decision==='accept-bounded'&&(current.summary?.decision!=='bounded-improvement'||!current.integrity))} className="rounded border border-border px-4 py-2 text-sm disabled:opacity-40" onClick={()=>void action(`/api/evidence-studies/${current.id}/review`,{decision,note,actor})}>{t(decision==='accept-bounded'?'evidence.accept':'evidence.reject')}</button>)}</div></div>}
  <p className="text-xs leading-5 text-muted-foreground">{t('evidence.limit')}</p></>}
 </section>;
}
