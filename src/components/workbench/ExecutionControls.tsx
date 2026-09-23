import {useEffect,useRef,useState} from 'react';
import {useT} from '@/lib/prefs';
import {workflowBase,workflowRequest,workflowRequestId,type WorkflowRun,type ReviewCase} from '@/lib/workflowRuns';
import {Button} from '@/components/ui';
import {navigateProject} from '@/lib/projectContext';

interface Compiled {codeRevision?:string;revisionIds?:string[];ready:boolean}
export function ExecutionControls({projectId,run,refresh,showArtifactLink=true}:{projectId:string;run:WorkflowRun;refresh:()=>void;showArtifactLink?:boolean}) {
  const t=useT(),base=`${workflowBase(projectId)}/${run.id}`;
  const [cases,setCases]=useState<ReviewCase[]>([]),[compiled,setCompiled]=useState<Compiled>({ready:false});
  const [selected,setSelected]=useState<string[]|null>(null),[mode,setMode]=useState<'retry'|'all'>('retry'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const intent=useRef<{key:string;code:string}>();
  useEffect(()=>{setSelected(null);intent.current=undefined;},[base]);
  useEffect(()=>{
    const c=new AbortController();
    void workflowRequest<{cases:ReviewCase[];compiled:Compiled}>(`${base}/review`,undefined,'GET',c.signal)
      .then(r=>{if(!c.signal.aborted){setCases(r.cases);setCompiled(r.compiled);}})
      .catch(e=>{if(!c.signal.aborted)setError(String(e.message));});
    return()=>c.abort();
  },[base,run]);
  const approved=cases.filter(c=>c.approval?.decision==='approved');
  const chosen=approved.filter(c=>selected===null||selected.includes(c.revision.id));
  const selectedIds=chosen.map(c=>c.revision.id).sort();
  const matches=JSON.stringify(selectedIds)===JSON.stringify([...(compiled.revisionIds??[])].sort());
  const code=run.revisions.find(r=>r.id===compiled.codeRevision);
  async function act(execute:boolean) {
    setBusy(true);setError('');
    try {
      if(execute&&(!matches||!compiled.ready||!code))return;
      if(execute&&intent.current?.code!==code!.id)intent.current={key:workflowRequestId(),code:code!.id};
      if(['failed','infra_error','budget_exhausted','interrupted','paused','cancelled'].includes(run.status))await workflowRequest(`${base}/resume`,{});
      const result=await workflowRequest<{status?:string}>(execute?`${base}/stages/execute`:`${base}/preparation/start`,execute
        ?{codeRevision:code!.id,idempotencyKey:intent.current!.key}
        :{revisionIds:selectedIds,mode});
      if(result.status&&['paused','cancelled','failed','interrupted'].includes(result.status))setError(t(`workflow.status.${result.status}`));
      if(execute)intent.current=undefined;
      refresh();
    } catch(e) {setError(String(e instanceof Error?e.message:e));}
    finally {setBusy(false);refresh();}
  }
  const running=['executing','running','registered','queued'].includes(run.status);
  return <div className="space-y-4 border-t border-border pt-4">
    <div className="text-sm space-y-1" role="status"><p>{t('bench.compilationScope')} · {approved.filter(c=>(compiled.revisionIds??[]).includes(c.revision.id)).length} / {approved.length}</p><p className="text-xs text-muted-foreground">{t('bench.compilationHint')}</p></div>
    <details className="rounded border border-border p-3">
      <summary className="cursor-pointer text-sm">{t('workbench.executionScope')} · {chosen.length}/{approved.length}</summary>
      <label className="my-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={chosen.length===approved.length&&approved.length>0} disabled={busy||running} onChange={e=>setSelected(e.target.checked?null:[])}/>{t('workbench.selectAll')}</label>
      <div className="max-h-64 space-y-2 overflow-auto">{approved.map(c=><label key={c.revision.id} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" disabled={busy||running} checked={selectedIds.includes(c.revision.id)} onChange={e=>setSelected(e.target.checked?[...selectedIds,c.revision.id]:selectedIds.filter(id=>id!==c.revision.id))}/><span>{c.caseId} · {c.content.title}</span></label>)}</div>
    </details>
    <label className="flex items-center gap-2 text-sm">{t('bench.preparationMode')}<select value={mode} disabled={busy||running} onChange={e=>setMode(e.target.value as 'retry'|'all')} className="rounded border border-border bg-background p-2"><option value="retry">{t('bench.retryUnverified')}</option><option value="all">{t('bench.reverifyAll')}</option></select></label>
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy||!chosen.length||running} onClick={()=>void act(false)}>{t('workflow.compile')}</Button>
      <Button variant="primary" disabled={busy||!code||!compiled.ready||!matches||running} onClick={()=>void act(true)}>{t('workflow.execute')}</Button>
    </div>
    {!matches&&chosen.length>0&&<p className="text-xs text-muted-foreground">{t('workbench.prepareScope')}</p>}
    {error&&<p role="alert" className="text-sm text-bad">{error}</p>}
    {showArtifactLink&&code&&<button className="text-sm text-primary underline" onClick={()=>navigateProject('artifacts',{projectId,runId:run.id,revisionId:code.id})}>{t('workflow.kind.code')} · v{code.revision}</button>}
  </div>;
}
