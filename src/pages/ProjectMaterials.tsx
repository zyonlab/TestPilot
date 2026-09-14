import {runOrigin} from '@/lib/workflowRuns';
import { useState } from 'react';
import { useStore } from '@/lib/store';
import { useT } from '@/lib/prefs';
import { NeedProject } from '@/components/NeedProject';
import { TopBar } from '@/components/TopBar';
import { Button } from '@/components/ui';
import { RevisionViewer } from '@/components/workbench/RevisionViewer';
import { readProjectContext,navigateProject } from '@/lib/projectContext';
import { useProjectRuns } from '@/lib/useProjectRuns';
export function ProjectMaterials({focusRun,revisionId}:{focusRun?:string;revisionId?:string}) {
  const projectId=useStore(s=>s.activeProjectId);
  return projectId?<Materials key={projectId} projectId={projectId} focusRun={focusRun} revisionId={revisionId}/>:<NeedProject/>;
}
function Materials({projectId,focusRun,revisionId}:{projectId:string;focusRun?:string;revisionId?:string}) {
  const t=useT(),{runs,error,loaded,refresh}=useProjectRuns(projectId),[kind,setKind]=useState('');
  const requested=focusRun??readProjectContext().runId, run=requested?runs.find(r=>r.id===requested):undefined;
  const revisions=run?run.revisions:runs.flatMap(r=>r.revisions);
  const selected=revisions.find(r=>r.id===(revisionId??readProjectContext().revisionId));
  return <div className="flex min-h-0 flex-1 flex-col"><TopBar title={t('surface.artifacts')} actions={<Button onClick={refresh}>{t('workflow.refresh')}</Button>}/><div className="min-h-0 flex-1 overflow-auto p-5">
    <div className="mb-5 flex flex-wrap items-center gap-3"><select aria-label={t('workflow.runList')} className="max-w-full rounded border border-border bg-card px-3 py-2 text-sm" value={requested} onChange={e=>navigateProject('artifacts',{projectId,runId:e.target.value,revisionId:''})}><option value="">{t('bench.allRuns')}</option>{runs.map(r=><option key={r.id} value={r.id}>{r.id} · {t(`workflow.status.${r.status}`)} · {runOrigin(r)}</option>)}</select><select aria-label={t('workflow.type')} className="rounded border border-border bg-card px-3 py-2 text-sm" value={kind} onChange={e=>setKind(e.target.value)}><option value="">{t('workflow.allTypes')}</option>{[...new Set(revisions.map(r=>r.kind))].map(k=><option key={k} value={k}>{t(`workflow.kind.${k}`)}</option>)}</select></div>
    {error&&<p role="alert" className="mb-4 text-bad">{t('workflow.connectionError')} · {error}</p>}
    {!loaded?<p role="status">{t('workflow.loading')}</p>:requested&&!run?<p role="alert">{t('workflow.runMissing')}</p>:<div className="grid items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]"><aside className="max-h-[70vh] overflow-auto rounded-lg border border-border">{revisions.filter(r=>!kind||r.kind===kind).map(r=><button key={r.id} aria-current={r.id===selected?.id} onClick={()=>navigateProject('artifacts',{projectId,runId:r.runId,revisionId:r.id})} className={`block w-full border-b border-border px-4 py-3 text-left text-sm hover:bg-muted ${r.id===selected?.id?'bg-primary-soft text-primary':''}`}><span className="block break-words">{r.name}</span><span className="mt-1 block truncate font-mono text-xs text-muted-foreground">v{r.revision} · {r.runId}</span></button>)}{!revisions.length&&<p className="p-5 text-sm text-muted-foreground">{t('art.emptyRun')}</p>}</aside><div className="min-w-0">{selected?<RevisionViewer key={selected.id} projectId={projectId} revision={selected} all={runs.flatMap(r=>r.revisions)} onSelect={r=>navigateProject('artifacts',{projectId,runId:r.runId,revisionId:r.id})}/>:<p className="py-6 text-sm text-muted-foreground">{revisionId?t('workflow.artifactFailed'):t('bench.pickArtifact')}</p>}</div></div>}
  </div></div>;
}
