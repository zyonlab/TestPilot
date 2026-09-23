import { artifactLabel } from './artifactLabel';
import { DocumentFields, RulePackDocument, ExplorationDocument } from './ArtifactDocument';
import { ExplorationGraph, type ExplorationGraphData } from './ExplorationGraph';
import {ExecutionReport} from './ExecutionReport';
import {GateReport} from './GateReport';
import {TextCaseDetail} from './TextCaseDetail';
import { ProductStructure } from './ProductStructure';
import { useEffect, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui';
import { useT } from '@/lib/prefs';
import { API_BASE } from '@/lib/base';
import { workflowBase, workflowRequest, type Revision } from '@/lib/workflowRuns';

/**
 * 一条文本用例的完整形状。
 *
 * 此前这里只渲染标题、步骤、预期——而一条用例之所以专业，恰恰在被丢掉的那些字段上：
 * 优先级说的是坏了要付多大代价，`designMethod` 说的是用了哪种设计方法，`tier` 说的是
 * 判决有多硬，`oracle` 是那条判决本身，`precondition` / `postSteps` 决定这条用例能不能
 * 独立重跑，`sourceRefs` / `ruleRefs` 决定它的断言能不能追回出处。看不见它们，
 * 复核的人就只能凭标题点头。
 */
function CaseList({cases}:{cases:Record<string,unknown>[]}){
  return <div className="space-y-4">{cases.map((c,index)=><article key={String(c.id??index)} className="rounded-lg border border-border bg-card p-4">
    <h3 className="mb-3 font-medium">{String(c.title??c.id??'')}</h3>
    <TextCaseDetail kase={c}/>
  </article>)}</div>;
}

/**
 * `modules` 节点的产物：一棵待冻结的模块树，外加机检说了什么。
 *
 * 不走默认的 JSON 兜底，因为复核这份东西的人要看的正是树的形状——机检判得了
 * 「有没有漏材料、是不是一张伪装成树的清单」，判不了「这棵树切得对不对」，
 * 而后者只有把树画出来才看得见。findings 排在树前面：先看机器说了什么，再自己看。
 */
function ModulePlan({data}:{data:Record<string,unknown>}){
  const t=useT(),findings=(Array.isArray(data.findings)?data.findings:[]) as Array<Record<string,unknown>>;
  const outOfScope=(Array.isArray(data.outOfScope)?data.outOfScope:[]) as Array<Record<string,unknown>>;
  const tone=(s:string)=>s==='error'?'bg-bad/10 text-bad':s==='warn'?'bg-warn/10 text-warn':'bg-muted text-muted-foreground';
  return <div className="space-y-5">
    <section><h3 className="font-medium">{t('bench.modulePlanFindings')} · {findings.length}</h3>
      {findings.length===0?<p className="mt-2 text-sm text-muted-foreground">{t('bench.modulePlanClean')}</p>:
      <ul className="mt-2 space-y-2">{findings.map((f,i)=><li key={i} className="flex flex-wrap items-baseline gap-2 rounded border border-border bg-card p-3 text-sm">
        <span className={`rounded px-1.5 py-0.5 text-[0.6875rem] ${tone(String(f.severity))}`}>{String(f.severity)}</span>
        <span className="font-mono text-[0.6875rem] text-muted-foreground">{String(f.code)}</span>
        <span className="min-w-0">{String(f.message??'')}</span>
        {(f.moduleId!=null||f.sectionId!=null||f.storyId!=null)&&<span className="font-mono text-[0.6875rem] text-muted-foreground">{String(f.moduleId??f.sectionId??f.storyId)}</span>}
      </li>)}</ul>}
    </section>
    <ProductStructure data={{...data,stories:[]}} hideStories/>
    {outOfScope.length>0&&<section><h3 className="font-medium">{t('bench.outOfScope')} · {outOfScope.length}</h3>
      <ul className="mt-2 space-y-2 text-sm">{outOfScope.map((o,i)=><li key={i} className="rounded border border-border bg-card p-3"><span className="font-mono text-[0.6875rem] text-muted-foreground">{String(o.sectionId)}</span> {String(o.reason??'')}</li>)}</ul></section>}
  </div>;
}

export function RevisionContent({content,kind,projectId,runId}:{content:unknown;kind:string;projectId?:string;runId?:string}) {
  const t=useT();
  if(typeof content==='string')return <Markdown text={content}/>;
  if(!content||typeof content!=='object')return <DocumentFields data={content}/>;
  const data=content as Record<string,unknown>;
  if(data.schemaVersion==='product-rule-pack.v1')return <RulePackDocument data={{rulePack:data}}/>;
  if(data.rulePack&&typeof data.rulePack==='object'&&Array.isArray((data.rulePack as Record<string,unknown>).rules))return <RulePackDocument data={data}/>;
  if(data.schemaVersion==='exploration-report.v1')return <ExplorationDocument data={data}/>;
  if(data.schemaVersion==='product-model.v1')return <DocumentFields data={data}/>;
  if(data.graph && typeof data.graph==='object' && Array.isArray((data.graph as ExplorationGraphData).states) && Array.isArray((data.graph as ExplorationGraphData).transitions)) return <div className="space-y-5"><ExplorationGraph graph={data.graph as ExplorationGraphData}/>{data.report&&typeof data.report==='object'?<ExplorationDocument data={data.report as Record<string,unknown>}/>:null}{typeof data.notes==='string'&&<details><summary className="cursor-pointer font-medium">{t('artifact.notes')}</summary><Markdown text={data.notes}/></details>}</div>;
  if(kind==='gate')return <GateReport data={data}/>;
  if(kind==='cases'&&typeof data.id==='string'&&Array.isArray(data.steps))return <RevisionContent kind="cases" content={{cases:[data]}}/>;
  if(kind==='execution')return <ExecutionReport data={data} projectId={projectId} runId={runId}/>;
  if(kind==='code'&&Array.isArray(data.code))return <div className="space-y-4">{data.code.map((c,i)=>{const row=c as Record<string,unknown>;return <article key={i} className="rounded border border-border p-4"><h3 className="font-medium">{String(row.caseId??'')} · {String(row.title??'')}</h3>{row.entryUrl!=null&&<p className="mt-2 break-words text-xs text-muted-foreground">{String(row.entryUrl)}</p>}<pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{String(row.code??'')}</pre></article>;})}</div>;
  if(Array.isArray(data.cases))return <CaseList cases={data.cases as Record<string,unknown>[]}/>;
  if(Array.isArray(data.modules)&&!Array.isArray(data.stories))return <ModulePlan data={data}/>;
  if(Array.isArray(data.stories)) return <ProductStructure data={data} projectId={projectId} runId={runId}/>;
  if(typeof data.text==='string'||typeof data.specText==='string'||typeof data.notes==='string')return <div className="space-y-6"><Markdown text={String(data.text??data.specText??data.notes)}/><details><summary className="cursor-pointer text-sm">{t('artifact.additional')}</summary><DocumentFields data={Object.fromEntries(Object.entries(data).filter(([k])=>!['text','specText','notes'].includes(k)))}/></details></div>;
  if(typeof data.code==='string')return <pre className="overflow-auto whitespace-pre-wrap text-xs">{data.code}</pre>;
  return <DocumentFields data={content}/>;
}
export function RevisionViewer({projectId,revision,all,onSelect,hideTitle=false}:{hideTitle?:boolean;projectId:string;revision:Revision;all:Revision[];onSelect:(revision:Revision)=>void}) {
  const t=useT(),[state,setState]=useState<{key:string;content?:unknown;error?:string}>({key:''});
  const key=projectId+':'+revision.runId+':'+revision.id;
  useEffect(()=>{const c=new AbortController();setState({key});
    void workflowRequest<{content:unknown}>(`${workflowBase(projectId)}/${revision.runId}/artifacts/${revision.id}`,undefined,'GET',c.signal).then(r=>{if(!c.signal.aborted)setState({key,content:r.content});}).catch(e=>{if(!c.signal.aborted)setState({key,error:String(e.code??'request_failed')});});return()=>c.abort();
  },[projectId,revision.id,revision.runId,key]);
  const ready=state.key===key&&state.content!==undefined;
  return <section className="min-w-0 space-y-4" aria-label={t('workflow.artifactDetail')}>
    <header className="flex flex-wrap items-center justify-between gap-3">{!hideTitle&&<h2 className="break-words font-medium">{artifactLabel(revision.name,t)} · v{revision.revision}</h2>}<a className="ml-auto text-sm text-primary underline" href={`${API_BASE}/api/${workflowBase(projectId)}/${revision.runId}/artifacts/${revision.id}/export`}>{t('workflow.download')}</a></header>
    {revision.name.startsWith('knowledge/')&&all.filter(r=>r.runId===revision.runId&&r.name===revision.name&&r.kind===revision.kind).length>1&&<div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">{t('bench.knowledgeVersions')}</span>
      {all.filter(r=>r.runId===revision.runId&&r.name===revision.name&&r.kind===revision.kind).map(r=><Button key={r.id} size="sm" disabled={r.id===revision.id} onClick={()=>onSelect(r)}>v{r.revision}{r.id!==revision.id&&r.contentHash===revision.contentHash? ` · ${t('bench.sameKnowledge')}`:''}</Button>)}
    </div>}
    {state.error?<p role="alert" className="text-bad">{t('workflow.artifactFailed')} · {state.error}</p>:!ready?<p role="status">{t('workflow.loading')}</p>:<RevisionContent content={state.content} kind={revision.kind} projectId={projectId} runId={revision.runId}/>}
    <details className="border-t border-border pt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">{t('artifact.sourceData')}</summary><p className="my-3 break-all">{revision.runId} · {revision.id}<br/>SHA256 {revision.contentHash}</p><div className="flex flex-wrap gap-2">{revision.sourceRefs.map(id=>{const r=all.find(x=>x.id===id);return r?<Button key={id} size="sm" onClick={()=>onSelect(r)}>{artifactLabel(r.name,t)} · v{r.revision}</Button>:<span key={id}>{id}</span>;})}</div>{ready&&<pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(state.content,null,2)}</pre>}</details>
  </section>;
}
