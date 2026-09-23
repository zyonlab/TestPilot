import {nodeStatusKey} from './nodeStatus';
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useT } from '@/lib/prefs';
import type { WorkflowRun } from '@/lib/workflowRuns';
import { NodeProgress, useNodeProgress } from './NodeProgress';
import { progressNode } from './progressNode';

/** A non-modal bottom drawer keeps the graph available while watching live events. */
export function WorkflowProgressDock({projectId,run}:{projectId:string;run:WorkflowRun}) {
 const t=useT(),[open,setOpen]=useState(false),[selected,setSelected]=useState(''),id=useId(),toggle=useRef<HTMLButtonElement>(null),panel=useRef<HTMLElement>(null);
 const node=selected||progressNode(run),{data,error}=useNodeProgress(projectId,run.id,node);
 const counts=data?.progress?.summary,event=data?.node??[...run.nodes].reverse().find(n=>n.node===node),phase=event?.phase;
 const label=(n:string)=>t(n==='source'?`bench.source.${run.detail?.parameters?.sourceKind??'spec'}`:`workflow.stage.${n}`);
 const failed=['failed','cancelled','blocked'].includes(phase??''),color=failed?'text-bad':phase==='done'?'text-ok':'text-primary';
 const close=()=>{setOpen(false);toggle.current?.focus();};
 useEffect(()=>{if(!open)return;panel.current?.focus();const handle=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!e.defaultPrevented&&!document.querySelector('[aria-modal="true"]')){e.preventDefault();setOpen(false);toggle.current?.focus();}};window.addEventListener('keydown',handle);return()=>window.removeEventListener('keydown',handle);},[open]);
 return <section aria-label={t('bench.liveProgress')} className="relative z-20 h-9 shrink-0 border-t border-border bg-card">
  {open&&<section id={id} ref={panel} role="dialog" aria-modal="false" tabIndex={-1} aria-label={t('bench.liveLogs')} className="absolute inset-x-0 bottom-full flex h-[min(48vh,26rem)] min-h-0 flex-col border-t border-border bg-card shadow-xl outline-none">
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-2">
      <h2 className="shrink-0 text-xs font-medium">{t('bench.liveLogs')}</h2>
      <select aria-label={t('bench.logNode')} value={selected} onChange={e=>setSelected(e.target.value)} className="min-w-0 max-w-full rounded border border-border bg-background px-2 py-1 text-sm">
        <option value="">{t('bench.followNode')} · {label(progressNode(run))}</option>
        {run.nodes.map(n=><option key={n.node} value={n.node}>{label(n.node)} · {t(nodeStatusKey(n.phase))}</option>)}
      </select>
      <span className="text-xs text-muted-foreground">{t('bench.liveRefresh')}</span>
      <button type="button" aria-label={t('bench.closeLogs')} onClick={close} className="ml-auto rounded p-2 hover:bg-muted"><X size={16}/></button>
    </header>
    <div className="min-h-0 flex-1 overflow-auto px-4 pb-4"><NodeProgress compact data={data} error={error} node={node}/></div>
  </section>}
  <button ref={toggle} type="button" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(v=>!v)} className="flex h-full w-full items-center gap-3 px-4 text-left hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
    <span className="shrink-0 text-xs font-medium">{label(node)}</span><span className={`text-xs ${color}`}>{t(nodeStatusKey(phase))}</span>
    <span className="flex min-w-0 flex-1 items-center gap-3">
      {counts&&counts.total>0?<><progress aria-label={t('bench.nodeProgress')} value={counts.done} max={counts.total} className="h-2 min-w-16 flex-1 accent-primary"/><span className="whitespace-nowrap text-xs tabular-nums">{counts.done} / {counts.total}{counts.verified!==undefined?` · ${t('bench.unit.verified')} ${counts.verified} (${t('bench.historicalVerified')} ${counts.historicalVerified??0})`:''}</span><span className="truncate text-xs">{event?.message}</span></>:<span className="truncate text-xs text-muted-foreground">{error||(!data?t('workflow.loading'):event?.message||t('bench.noUnitMetric'))}</span>}
    </span>
    <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-primary">{t(open?'bench.closeLogs':'bench.openLogs')}{open?<ChevronDown size={16}/>:<ChevronUp size={16}/>}</span>
  </button>
 </section>;
}
