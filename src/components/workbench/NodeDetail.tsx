import {nodeStatusKey} from './nodeStatus';
import { nodeKnowledge } from './nodeKnowledge';
import { Drawer } from '@/components/overlay';
import { Markdown } from '@/components/Markdown';
import { NodeArtifacts } from './NodeArtifacts';
import {useEffect,useState} from 'react';
import {ExecutionControls} from './ExecutionControls';
import {useT} from '@/lib/prefs';
import {navigateProject} from '@/lib/projectContext';
import {workflowBase,workflowRequest,workflowRequestId,type WorkflowRun} from '@/lib/workflowRuns';
import {Button} from '@/components/ui';
const roles:Record<string,string>={source:'Explorer',modules:'Product architect',instructions:'Coordinator',stories:'Product analyst',cases:'Test designer',gate:'Deterministic validator',finalize:'Artifact validator',review:'Reviewer',g2:'Host planner + Midscene executor',execution:'Midscene executor'};
const skills:Record<string,string>={modules:'testpilot-run-c',stories:'testpilot-stories',cases:'testpilot-design',execution:'testpilot-run-c'};
type InstructionFile={path:string;hash:string;text?:string};
type Knowledge={name:string;roles?:string[];text?:string};
export function NodeDetail({run,node,projectId,onRunDetails,refresh}:{run:WorkflowRun;node:string;projectId:string;onRunDetails:()=>void;refresh:()=>void}) {
 const t=useT(),event=run.nodes.find(n=>n.node===node),skill=skills[node];
 const [context,setContext]=useState<{files:InstructionFile[];knowledge:Knowledge[];used:string[];sources:Record<string,string[]>;recorded:boolean;error?:string}>({files:[],knowledge:[],used:[],sources:{},recorded:false});
 const instructions=run.revisions.find(r=>r.name==='validated/instructions'),knowledge=run.revisions.filter(r=>r.name.startsWith('knowledge/'));
 const manifests=run.revisions.filter(r=>r.name==='context/'+node||r.name.startsWith('context/'+node+'/'));
 const contextKey=[node,event?.phase,instructions?.id,...run.revisions.map(r=>r.id)].join(',');
 useEffect(()=>{const c=new AbortController();setContext({files:[],knowledge:[],used:[],sources:{},recorded:false});
  const refs=[...(instructions?[instructions]:[]),...manifests,...knowledge];
  void Promise.all(refs.map(r=>workflowRequest<{content:{files?:InstructionFile[];knowledge?:Array<{revision:string}>}&Knowledge}>(`${workflowBase(projectId)}/${run.id}/artifacts/${r.id}`,undefined,'GET',c.signal)))
   .then(rows=>{if(!c.signal.aborted){
     const inputs=nodeKnowledge(node,run.revisions,rows.map((row,i)=>({revision:refs[i]!,content:row.content})),!!event);
     setContext({files:rows.flatMap(r=>r.content.files??[]),knowledge:[],used:inputs.map(r=>r.id),sources:Object.fromEntries(inputs.map(r=>[r.id,r.sources])),recorded:manifests.length>0||inputs.length>0});
   }})
   .catch(()=>{if(!c.signal.aborted)setContext({files:[],knowledge:[],used:[],sources:{},recorded:false,error:t('workflow.artifactFailed')});});return()=>c.abort();
 },[projectId,run.id,contextKey,t]);
 const refs=run.revisions.filter(r=>r.name===`validated/${node}`||(!run.revisions.some(v=>v.name===`validated/${node}`)&&r.name.startsWith(`units/${node}/`))||node==='source'&&(r.kind==='material'||r.name==='exploration/observations')||node==='g2'&&(r.kind==='code'||r.name.startsWith('preparation/'))||node==='execution'&&r.kind==='execution');
 const usesExecutor=node==='execution'||node==='source'&&run.detail?.parameters?.sourceKind==='explore';
 const model=usesExecutor?run.binding?.models.executor.model:['modules','stories','cases','instructions','g2'].includes(node)?run.binding?.models.planner.model??run.binding?.models.runtime:'—';
 const [documentPath,setDocumentPath]=useState<string|null>(null);
 useEffect(()=>setDocumentPath(null),[run.id,node]);
 const documents=context.files.filter(f=>f.path.startsWith(`skills/${skill}/`));
 const selected=documents.find(f=>f.path===documentPath);
 const file=context.files.find(f=>f.path===`skills/${skill}/SKILL.md`);
 /**
  * 模块树的冻结：**这是产品里唯一一个必须由人按的按钮**。
  *
  * 服务端那条路由只收不带 Authorization 头的请求（`reviewerPrincipal`），所以机器没有这条路；
  * 在这之前它也没有别的路——我自己是用 curl 按的。一个只能由人做、却没有界面的动作，
  * 等于要求每个人都去查路由，那这道闸门迟早会被绕开。
  *
  * 状态不另外取：节点事件已经说了——`waiting_review` 是提议过等着人看，`done` 是冻结了。
  */
 const [rerunning,setRerunning]=useState(false),[rerunError,setRerunError]=useState('');
 const [rerunKey,setRerunKey]=useState(workflowRequestId);
 useEffect(()=>{setRerunKey(workflowRequestId());setRerunError('');},[run.id,node]);
 async function rerun(){
   setRerunning(true);setRerunError('');
   try{const result=await workflowRequest<{wfRunId:string}>(`${workflowBase(projectId)}/${run.id}/rerun`,{node,idempotencyKey:rerunKey});
     navigateProject('canvas',{projectId,runId:result.wfRunId,nodeId:'',revisionId:''});refresh();
   }catch(e){setRerunError(e instanceof Error?e.message:'request_failed');}finally{setRerunning(false);}
 }
 const [freezing,setFreezing]=useState(''),proposed=node==='modules'&&event?.phase==='waiting_review';
 async function freeze(){setFreezing('busy');
  try{await workflowRequest(`${workflowBase(projectId)}/${run.id}/modules/freeze`,{});setFreezing('');refresh();}
  catch(e){setFreezing(e instanceof Error?e.message:'request_failed');}}
 return <section className="space-y-5">
  <section className="rounded-lg border border-border bg-muted/30 p-4 text-sm space-y-3">
    <p className="font-medium">{t(`bench.guide.${node}.summary`)}</p>
    <dl className="space-y-3">{['input','outcome'].map(part=><div key={part}><dt className="text-xs text-muted-foreground">{t(`bench.guide.${part}`)}</dt><dd className="mt-1 leading-relaxed">{t(`bench.guide.${node}.${part}`)}</dd></div>)}</dl>
  </section>
  {['source','modules','stories','cases','gate'].includes(node)&&<div className="space-y-2">
    <Button disabled={rerunning||['running','queued','pending'].includes(run.status)} onClick={()=>void rerun()}>{t(rerunning?'workflow.starting':'bench.rerunNode')}</Button>
    <p className="text-xs text-muted-foreground">{t(['running','queued','pending'].includes(run.status)?'bench.rerunStopFirst':'bench.rerunNodeHint')}</p>
    {rerunError&&<p role="alert" className="text-sm text-bad">{rerunError}</p>}
  </div>}
  <dl className="grid grid-cols-2 gap-4 rounded-lg border border-border p-4 text-sm">
   <div><dt className="text-xs text-muted-foreground">Role</dt><dd className="mt-1">{file?<button type="button" aria-haspopup="dialog" className="text-primary underline underline-offset-4" onClick={()=>setDocumentPath(file.path)}>{roles[node]??node}</button>:roles[node]??node}</dd></div>
   <div><dt className="text-xs text-muted-foreground">{t('bench.reviewStatus')}</dt><dd className="mt-1">{t(nodeStatusKey(event?.phase))}</dd></div>
   <div><dt className="text-xs text-muted-foreground">{t(usesExecutor?'modelRoles.executor':'modelRoles.planner')}</dt><dd className="mt-1 break-words">{model??'—'}</dd></div>
   <div><dt className="text-xs text-muted-foreground">Skill</dt><dd className="mt-1 break-words">{file?<button type="button" aria-haspopup="dialog" className="text-primary underline underline-offset-4" onClick={()=>setDocumentPath(file.path)}>{skill}</button>:skill??'—'}{file&&<small className="mt-1 block font-mono text-muted-foreground" title={file.hash}>SHA256 {file.hash.slice(0,12)}</small>}</dd></div>
  </dl>
  {event?.message&&<p role="status" className={`text-sm ${['failed','blocked','cancelled'].includes(event.phase)?'text-bad':'text-muted-foreground'}`}>{event.message}</p>}
  <section className="space-y-3"><h3 className="text-sm font-medium">{t('bench.nodeKnowledge')}</h3>
    <p className="text-xs text-muted-foreground">{t(!context.recorded?'bench.nodeKnowledgeUnknown':context.used.length?'bench.nodeKnowledgeEvidence':'bench.nodeKnowledgeEmpty')}</p>
    <NodeArtifacts key={`${run.id}-${node}-knowledge`} projectId={projectId} revisions={knowledge.filter(r=>context.used.includes(r.id))} all={run.revisions} descriptions={Object.fromEntries(Object.entries(context.sources).map(([id,sources])=>[id,sources.map(v=>t(`bench.knowledgeVia.${v}`)).join(' · ')]))}/>
  </section>
  {file&&<Drawer open={!!selected} onClose={()=>setDocumentPath(null)} layer={1} resizeKey="bench-node-document" defaultWidth={960} fullscreen title={`${roles[node]??node} · ${skill}`}>
    {selected&&<div className="space-y-5 p-5">
      <p className="text-sm text-muted-foreground">{t('bench.skillDocumentHint')}</p>
      <label className="block text-sm">{t('bench.skillDocument')}<select className="mt-2 block w-full rounded border border-border bg-card p-2" value={selected.path} onChange={e=>setDocumentPath(e.target.value)}>{documents.map(doc=><option key={doc.path} value={doc.path}>{doc.path.split('/').slice(-1)[0]}</option>)}</select></label>
      {selected.text?<Markdown text={selected.text}/>:<p role="status" className="text-sm text-muted-foreground">{t(node==='g2'?'bench.compilerNoSkill':'bench.skillDocumentMissing')}</p>}
      <details className="rounded border border-border p-3 text-xs text-muted-foreground"><summary className="cursor-pointer">{t('bench.skillDocumentSource')}</summary><p className="mt-3 break-all font-mono">{selected.path}<br/>SHA256 {selected.hash}<br/>{instructions?.id}</p></details>
    </div>}
  </Drawer>}
  {!file&&<p className="text-xs text-muted-foreground">{t(node==='g2'?'bench.compilerNoSkill':'bench.skillDocumentMissing')}</p>}
  {context.error&&<p role="alert" className="text-sm text-bad">{context.error}</p>}
  <div><h3 className="mb-3 text-sm font-medium">{t(node==='g2'?'bench.compilationArtifacts':'workflow.artifacts')}</h3>{node==='g2'&&<p className="mb-3 text-xs text-muted-foreground">{t('bench.compilationArtifactsHint')}</p>}{refs.length?<NodeArtifacts key={`${run.id}-${node}-artifacts`} projectId={projectId} revisions={refs} all={run.revisions}/>:<p className="text-sm text-muted-foreground">{t('bench.noNodeArtifact')}</p>}</div>
  {node==='modules'&&<section className="rounded-lg border border-border p-4 text-sm">
   <h3 className="font-medium">{t('bench.moduleReviewTitle')}</h3>
   <p className="mt-2 text-muted-foreground">{t(event?.phase==='done'?'bench.modulesFrozen':'bench.freezeModulesHint')}</p>
   {proposed&&<Button className="mt-3" variant="primary" disabled={freezing==='busy'} onClick={()=>void freeze()}>{t(freezing==='busy'?'bench.moduleReviewSubmitting':'bench.freezeModules')}</Button>}
   {freezing&&freezing!=='busy'&&<p role="alert" className="mt-2 text-bad">{freezing}</p>}
  </section>}
  <div className="flex gap-2">{['cases','gate','review'].includes(node)&&<Button onClick={()=>navigateProject('review',{projectId,runId:run.id,revisionId:''})}>{t('surface.review')}</Button>}<Button onClick={onRunDetails}>{t('bench.runDetails')}</Button></div>
  {['g2','execution'].includes(node)&&<ExecutionControls projectId={projectId} run={run} refresh={refresh} showArtifactLink={false}/>}
 </section>;
}
