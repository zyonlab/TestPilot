import {useEffect,useState} from 'react';
import {ExecutionControls} from './ExecutionControls';
import {useT} from '@/lib/prefs';
import {navigateProject} from '@/lib/projectContext';
import {workflowBase,workflowRequest,type WorkflowRun} from '@/lib/workflowRuns';
import {Button} from '@/components/ui';
const roles:Record<string,string>={source:'Explorer',modules:'Product architect',instructions:'Coordinator',stories:'Product analyst',cases:'Test designer',gate:'Deterministic validator',finalize:'Artifact validator',review:'Reviewer',g2:'Midscene compiler',execution:'Midscene executor'};
const skills:Record<string,string>={modules:'testpilot-run-c',stories:'testpilot-stories',cases:'testpilot-design',execution:'testpilot-run-c'};
type Knowledge={name:string;roles?:string[];text?:string};
export function NodeDetail({run,node,projectId,onRunDetails,refresh}:{run:WorkflowRun;node:string;projectId:string;onRunDetails:()=>void;refresh:()=>void}) {
 const t=useT(),event=run.nodes.find(n=>n.node===node),skill=skills[node];
 const [context,setContext]=useState<{files:{path:string;hash:string}[];knowledge:Knowledge[];error?:string}>({files:[],knowledge:[]});
 const instructions=run.revisions.find(r=>r.name==='validated/instructions'),knowledge=run.revisions.filter(r=>r.name.startsWith('knowledge/'));
 const contextKey=[instructions?.id,...knowledge.map(r=>r.id)].join(',');
 useEffect(()=>{const c=new AbortController();setContext({files:[],knowledge:[]});
  const refs=run.revisions.filter(r=>r.name==='validated/instructions'||r.name.startsWith('knowledge/'));
  void Promise.all(refs.map(r=>workflowRequest<{content:{files?:{path:string;hash:string}[]}&Knowledge}>(`${workflowBase(projectId)}/${run.id}/artifacts/${r.id}`,undefined,'GET',c.signal)))
   .then(rows=>{if(!c.signal.aborted)setContext({files:rows.flatMap(r=>r.content.files??[]),knowledge:rows.map(r=>r.content).filter(k=>!!k.roles)});})
   .catch(()=>{if(!c.signal.aborted)setContext({files:[],knowledge:[],error:t('workflow.artifactFailed')});});return()=>c.abort();
 },[projectId,run.id,contextKey,t]);
 const refs=run.revisions.filter(r=>r.name===`validated/${node}`||node==='source'&&(r.kind==='material'||r.name==='exploration/observations')||node==='g2'&&r.kind==='code'||node==='execution'&&r.kind==='execution');
 const usesExecutor=node==='execution'||node==='source'&&run.detail?.parameters?.sourceKind==='explore';
 const model=usesExecutor?run.binding?.models.executor.model:['modules','stories','cases','instructions'].includes(node)?run.binding?.models.planner.model??run.binding?.models.runtime:'—';
 const file=context.files.find(f=>f.path===`skills/${skill}/SKILL.md`),boundKnowledge=context.knowledge.filter(k=>k.roles?.includes(node));
 /**
  * 模块树的冻结：**这是产品里唯一一个必须由人按的按钮**。
  *
  * 服务端那条路由只收不带 Authorization 头的请求（`reviewerPrincipal`），所以机器没有这条路；
  * 在这之前它也没有别的路——我自己是用 curl 按的。一个只能由人做、却没有界面的动作，
  * 等于要求每个人都去查路由，那这道闸门迟早会被绕开。
  *
  * 状态不另外取：节点事件已经说了——`waiting_review` 是提议过等着人看，`done` 是冻结了。
  */
 const [freezing,setFreezing]=useState(''),proposed=node==='modules'&&event?.phase==='waiting_review';
 async function freeze(){setFreezing('busy');
  try{await workflowRequest(`${workflowBase(projectId)}/${run.id}/modules/freeze`,{});setFreezing('');refresh();}
  catch(e){setFreezing(e instanceof Error?e.message:'request_failed');}}
 return <section className="space-y-5"><h2 className="text-xl font-semibold">{t(node==='source'?`bench.source.${run.detail?.parameters?.sourceKind??'spec'}`:`workflow.stage.${node}`)}</h2>
  <dl className="grid grid-cols-2 gap-4 rounded-lg border border-border p-4 text-sm">
   <div><dt className="text-xs text-muted-foreground">Role</dt><dd className="mt-1">{roles[node]??node}</dd></div>
   <div><dt className="text-xs text-muted-foreground">{t('bench.reviewStatus')}</dt><dd className="mt-1">{t(`workflow.status.${event?.phase??'queued'}`)}</dd></div>
   <div><dt className="text-xs text-muted-foreground">{t(usesExecutor?'modelRoles.executor':'modelRoles.planner')}</dt><dd className="mt-1 break-words">{model??'—'}</dd></div>
   <div><dt className="text-xs text-muted-foreground">Skill</dt><dd className="mt-1 break-words">{skill??'—'}{file&&<small className="mt-1 block font-mono text-muted-foreground" title={file.hash}>SHA256 {file.hash.slice(0,12)}</small>}</dd></div>
  </dl>
  {event?.message&&<p role="status" className={`text-sm ${['failed','blocked','cancelled'].includes(event.phase)?'text-bad':'text-muted-foreground'}`}>{event.message}</p>}
  {(boundKnowledge.length>0||file)&&<details className="rounded border border-border p-3 text-sm"><summary className="cursor-pointer">{t('bench.knowledge')}</summary>{boundKnowledge.map(k=><details className="mt-3" key={k.name}><summary>{k.name}</summary><p className="mt-2 whitespace-pre-wrap text-xs">{k.text}</p></details>)}{file&&<p className="mt-3 break-all font-mono text-xs">{file.path}<br/>{file.hash}</p>}</details>}
  {context.error&&<p role="alert" className="text-sm text-bad">{context.error}</p>}
  <div><h3 className="mb-3 text-sm font-medium">{t('workflow.artifacts')}</h3>{refs.length?refs.map(r=><button key={r.id} className="mb-2 block w-full rounded border border-border p-3 text-left text-sm text-primary" onClick={()=>navigateProject('canvas',{projectId,runId:run.id,revisionId:r.id,nodeId:node})}>{r.name} · v{r.revision}</button>):<p className="text-sm text-muted-foreground">{t('bench.noNodeArtifact')}</p>}</div>
  {node==='modules'&&<section className="rounded-lg border border-border p-4 text-sm">
   <h3 className="font-medium">{t('bench.freezeModules')}</h3>
   <p className="mt-2 text-muted-foreground">{t(event?.phase==='done'?'bench.modulesFrozen':'bench.freezeModulesHint')}</p>
   {proposed&&<Button className="mt-3" variant="primary" disabled={freezing==='busy'} onClick={()=>void freeze()}>{t(freezing==='busy'?'workflow.starting':'bench.freezeModules')}</Button>}
   {freezing&&freezing!=='busy'&&<p role="alert" className="mt-2 text-bad">{freezing}</p>}
  </section>}
  <div className="flex gap-2">{['cases','gate','review'].includes(node)&&<Button onClick={()=>navigateProject('review',{projectId,runId:run.id,revisionId:''})}>{t('surface.review')}</Button>}<Button onClick={onRunDetails}>{t('bench.runDetails')}</Button></div>
  {['g2','execution'].includes(node)&&<ExecutionControls projectId={projectId} run={run} refresh={refresh}/>}
 </section>;
}
