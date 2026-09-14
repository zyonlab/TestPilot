import { NodeDetail } from '@/components/workbench/NodeDetail';
import { useEffect, useState } from 'react';
import { ChevronRight, FileText, Play, Plus, X, Circle, CheckCircle2, AlertCircle } from 'lucide-react';
import { useStore } from '@/lib/store';
import { useT } from '@/lib/prefs';
import { useProjectRuns } from '@/lib/useProjectRuns';
import { navigateProject, readProjectContext } from '@/lib/projectContext';
import { workflowBase, workflowRequest, runOrigin, type Revision } from '@/lib/workflowRuns';
import { NeedProject } from '@/components/NeedProject';
import { Button } from '@/components/ui';
import { RunDetail } from '@/pages/WorkflowRuns';
import { NewRunForm } from '@/components/workbench/NewRunForm';
import { RevisionViewer } from '@/components/workbench/RevisionViewer';
/**
 * 画布上的节点。`modules` 排在 source 之后、stories 之前——服务端就是这个次序
 * （`workflowControls.ts`），而且它是**人要按一下的那个节点**：机检说不了「这棵树切得对不对」，
 * 冻结只能在这里做。画布上没有它的时候，那一步在产品里就等于不存在。
 */
const stages=['source','modules','stories','cases','gate','review','g2','execution'];
function nodeRevisions(stage:string,revisions:Revision[]) {return revisions.filter(r=>stage==='source'?r.kind==='material'||r.name==='exploration/observations':stage==='g2'?r.kind==='code':stage==='execution'?r.name.startsWith('execution/'):r.name===`validated/${stage}`);}
export function WorkflowBench(){const projectId=useStore(s=>s.activeProjectId);return projectId?<Bench key={projectId} projectId={projectId}/>:<NeedProject/>;}
function Bench({projectId}:{projectId:string}) {
  const t=useT(),{runs,loaded,error,refresh}=useProjectRuns(projectId),[ctx,setCtx]=useState(readProjectContext),[creating,setCreating]=useState(false),[details,setDetails]=useState(false),[busy,setBusy]=useState(false),[actionError,setActionError]=useState(''),[breakpoints,setBreakpoints]=useState<string[]>([]);
  useEffect(()=>{const change=()=>{setCtx(readProjectContext());setDetails(false);};window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  // 整屏抽屉要能用 Esc 关掉：盖满视口之后，没有可以点的空白处回到画布。
  useEffect(()=>{const onKey=(e:KeyboardEvent)=>{if(e.key!=='Escape')return;setDetails(false);navigateProject('canvas',{revisionId:'',nodeId:''});};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[]);
  const run=runs.find(r=>r.id===ctx.runId),revision=run?.revisions.find(r=>r.id===ctx.revisionId);
  useEffect(()=>{setBreakpoints([]);if(!run)return;const c=new AbortController();void workflowRequest<{breakpoints:string[]}>(`${workflowBase(projectId)}/${run.id}/controls`,undefined,'GET',c.signal).then(v=>{if(!c.signal.aborted)setBreakpoints(v.breakpoints);}).catch(()=>{});return()=>c.abort();},[projectId,run?.id,run?.status]);
  function choose(runId:string){setCreating(false);navigateProject('canvas',{projectId,runId,revisionId:'',nodeId:''});}
  async function action(path:string,body:unknown={}){if(!run)return;setBusy(true);setActionError('');try{await workflowRequest(`${workflowBase(projectId)}/${run.id}/${path}`,body);refresh();return true;}catch(e){setActionError(e instanceof Error?e.message:'request_failed');return false;}finally{setBusy(false);}}
  /**
   * 「继续运行」什么时候该出现。
   *
   * 2026-09-12 之前，一条停在「等人冻结模块树」的运行被服务端记成 `failed`，
   * 所以它顺理成章地出现在这张表里。状态改成说真话（`waiting_review`）之后，
   * 这个入口跟着消失了——人冻结完模块树，就再也没有地方点「继续」。
   *
   * 所以要分两种 `waiting_review`：**走完了 finalize、等人复核**的不该再继续；
   * **停在某个节点等人拍板**的（眼下只有模块树）恰恰就等着这一下。
   */
  const awaitingHuman=run&&run.status==='waiting_review'&&!run.nodes.some(n=>n.node==='finalize'&&n.phase==='done');
  const resumable=run&&(['paused','failed','cancelled','interrupted','budget_exhausted','infra_error'].includes(run.status)||awaitingHuman);
  return <main className="flex min-h-0 flex-1 flex-col" data-testid="workflow-bench"><header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-5"><h1 className="text-base font-semibold">{t('bench.title')}</h1><Button size="sm" onClick={()=>navigateProject('settings',{projectId})}>{t('nav.settings')}</Button></header>
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-5 py-3"><select aria-label={t('workflow.runList')} className="min-h-10 max-w-full rounded-md border border-border bg-background px-3 py-2 text-sm sm:w-96" value={run?.id??''} onChange={e=>choose(e.target.value)}><option value="">{t('bench.chooseRun')}</option>{runs.map(r=><option key={r.id} value={r.id}>{r.startedAt?new Date(r.startedAt).toLocaleString():r.id.slice(0,16)} · {t(`workflow.status.${r.status}`)} · {r.id.slice(-6)} · {runOrigin(r)}</option>)}</select>{run&&<span className="text-xs text-muted-foreground">{runOrigin(run)} · {t(`bench.source.${run.detail?.parameters?.sourceKind??'spec'}`)}</span>}<div className="ml-auto flex gap-2">{run&&<Button onClick={()=>setDetails(true)}>{t('bench.runDetails')}</Button>}<Button onClick={()=>{setCreating(true);setDetails(false);}}><Plus size={14}/>{t('workflow.new')}</Button>{resumable&&<Button variant="primary" disabled={busy} onClick={()=>void action('resume').then(ok=>{if(ok&&run?.nodes.some(n=>n.node==='finalize'))navigateProject('canvas',{nodeId:'execution',revisionId:''});})}><Play size={14}/>{t('workflow.resume')}</Button>}</div></div>
    {run&&<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-2 text-xs"><div className="flex items-center gap-4"><span className="flex items-center gap-1 text-ok"><CheckCircle2 size={13}/>{t('workflow.status.done')}</span><span className="flex items-center gap-1 text-bad"><AlertCircle size={13}/>{t('bench.stopped')}</span><span className="flex items-center gap-1 text-muted-foreground"><Circle size={13}/>{t('bench.untouched')}</span></div><span className="font-mono text-muted-foreground">{run.id} · {t(`workflow.status.${run.status}`)}</span></div>}
    {(error||actionError)&&<p role="alert" className="px-5 py-3 text-sm text-bad">{error||actionError}</p>}
    {creating?<div className="min-h-0 flex-1 overflow-auto"><NewRunForm projectId={projectId} onClose={()=>setCreating(false)} onCreated={id=>{choose(id);refresh();}}/></div>:!run?<div className="grid flex-1 place-content-center gap-4 px-6 text-center"><h2 className="text-xl font-medium">{!loaded?t('workflow.loading'):ctx.runId?t('workflow.runMissing'):t('bench.empty')}</h2><p className="text-sm text-muted-foreground">{t('bench.emptyHint')}</p><Button variant="primary" onClick={()=>setCreating(true)}>{t('workflow.new')}</Button></div>:<div className="relative flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-auto bg-[radial-gradient(hsl(var(--border))_1px,transparent_1px)] bg-[length:20px_20px] p-6"><div className="grid min-w-[1360px] grid-cols-8 items-start gap-6 py-8">{stages.map((stage,i)=>{const event=[...run.nodes].reverse().find(n=>n.node===stage);const arts=nodeRevisions(stage,run.revisions);const phase=stage==='source'?(event?.phase??(run.binding?.inputHash?'done':'queued')):event?.phase??'queued';const done=['done','completed','passed'].includes(phase)||(stage==='finalize'&&phase==='waiting_review');const stopped=['paused','blocked','failed','infra_error','waiting_review'].includes(phase)&&!done;const untouched=stage!=='review'&&!event&&!arts.length&&phase==='queued';return <div key={stage} className="relative min-w-0"><section className="w-full"><div className={`relative rounded-lg border border-l-4 bg-card p-4 shadow-sm ${done?'border-l-ok':stopped?'border-l-bad':'border-l-border'}`}><button aria-label={`${t('bench.breakpoint')} · ${t(stage==='source'?`bench.source.${run.detail?.parameters?.sourceKind??'spec'}`:`workflow.stage.${stage}`)}`} title={t(stage==='review'?'bench.manualReviewStop':untouched?'bench.breakpoint':'bench.breakpointDisabled')} aria-pressed={breakpoints.includes(stage)} disabled={!untouched||busy} onClick={()=>{const next=breakpoints.includes(stage)?breakpoints.filter(n=>n!==stage):[...breakpoints,stage];void action('controls',{breakpoints:next}).then(ok=>{if(ok)setBreakpoints(next);});}} className={`absolute right-3 top-3 h-4 w-4 rounded-full border-2 disabled:cursor-not-allowed ${breakpoints.includes(stage)?'border-bad bg-bad':'border-border'}`}/><button className="w-full pr-5 text-left" onClick={()=>{navigateProject('canvas',{nodeId:stage,revisionId:''});}}><h2 className="font-semibold">{t(stage==='source'?`bench.source.${run.detail?.parameters?.sourceKind??'spec'}`:`workflow.stage.${stage}`)}</h2><p className="mt-3 font-mono text-xs text-muted-foreground">{stage}</p><p className={`mt-2 text-xs ${done?'text-ok':stopped?'text-bad':'text-muted-foreground'}`}>{t(`workflow.status.${phase}`)}</p></button>{event?.message&&<p className={`mt-2 line-clamp-3 text-xs ${stopped?"text-bad":"text-muted-foreground"}`} title={event.message}>{event.message}</p>}</div>{arts.length>0&&<><div className="mx-auto h-8 w-px bg-border"/><div className="max-h-64 space-y-2 overflow-auto rounded-lg border border-border bg-card p-2">{[...arts].reverse().map(r=><button key={r.id} className="flex w-full items-start gap-2 rounded p-2 text-left text-sm hover:bg-accent" onClick={()=>navigateProject('canvas',{revisionId:r.id,nodeId:stage})}><FileText size={15} className="mt-0.5 shrink-0 text-primary"/><span className="min-w-0 break-words">{r.kind==='execution'?t('surface.runs'):r.kind==='code'?t('workflow.kind.code'):r.name.startsWith('validated/')?t(`workflow.stage.${stage}`):r.name}<small className="block text-muted-foreground">{['execution','code'].includes(r.kind)?new Date(r.createdAt).toLocaleTimeString():`v${r.revision}`}</small></span></button>)}</div></>}</section>{i<stages.length-1&&<div className="absolute -right-6 top-14 flex w-6 items-center"><div className="h-px flex-1 bg-border"/><ChevronRight size={14} className="text-muted-foreground"/></div>}</div>;})}</div></div>
      {/* 从 Flow 打开的抽屉**整屏**。
          原来是 `max-w-3xl`（768px）的右侧窄栏：里面放的是规格正文、用例表、执行报告，
          在 1440 以上的屏上这条窄栏让每条用例都要横向折行，而右边留着的画布此时没人在看。
          `fixed inset-0` 盖满视口，关闭按钮固定在右上，Esc 也能关。 */}
      {(details||revision||ctx.nodeId)&&<aside role="dialog" aria-modal="true" aria-label={t(revision?'workflow.artifactDetail':'bench.runDetails')} className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-card"><div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3"><span className="text-sm font-medium">{revision?t('workflow.artifactDetail'):t('bench.runDetails')}</span><Button aria-label={t('bench.close')} onClick={()=>{setDetails(false);navigateProject('canvas',{revisionId:'',nodeId:''});}}><X size={16}/></Button></div><div className="min-h-0 flex-1 overflow-auto p-5">{revision?<RevisionViewer key={revision.id} projectId={projectId} revision={revision} all={run.revisions} onSelect={r=>navigateProject('canvas',{revisionId:r.id})}/>:ctx.nodeId&&!details?<NodeDetail projectId={projectId} run={run} node={ctx.nodeId} refresh={refresh} onRunDetails={()=>setDetails(true)}/>:<RunDetail projectId={projectId} run={run} refresh={refresh}/>}</div></aside>}
    </div>}
  </main>;
}
