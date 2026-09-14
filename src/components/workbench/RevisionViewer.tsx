import {ExecutionReport} from './ExecutionReport';
import {GateReport} from './GateReport';
import { ProductStructure } from './ProductStructure';
import { useEffect, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui';
import { useT } from '@/lib/prefs';
import { API_BASE } from '@/lib/base';
import { workflowBase, workflowRequest, type Revision } from '@/lib/workflowRuns';

/** 判据写成一行人能读的话；tier 3 没有判据时说出来，而不是留空。 */
function oracleLine(o:Record<string,unknown>|undefined):string{
  if(!o||typeof o!=='object')return '';
  const k=String(o.kind??'');
  if(k==='none')return 'none';
  if(k==='api')return `api ${String(o.method??'GET')} ${String(o.url??'')} · ${String(o.path??'')} ${String(o.op??'')} ${o.value!==undefined?String(o.value):''}${o.settleMs?` · settle ${String(o.settleMs)}ms`:''}`;
  if(k==='count')return `count「${String(o.value??'')}」${String(o.op??'eq')} ${String(o.n??'')}`;
  if(k==='delta')return `delta「${String(o.value??'')}」${String(o.direction??'')}${o.by!==undefined?` by ${String(o.by)}`:''}`;
  return `${k}「${String(o.value??'')}」`;
}
const Chip=({label,value,tone}:{label:string;value:string;tone?:string})=>
  <span className={`rounded px-1.5 py-0.5 text-[0.6875rem] ${tone??'bg-muted text-muted-foreground'}`}><span className="opacity-70">{label}</span> {value}</span>;

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
  const t=useT();
  const arr=(v:unknown):string[]=>Array.isArray(v)?v.map(String):[];
  return <div className="space-y-4">{cases.map((c,index)=>{
    const pri=String(c.priority??''),tier=c.tier as number|undefined,oracle=c.oracle as Record<string,unknown>|undefined;
    const refs:Array<[string,string[]]>=[['sourceRefs',arr(c.sourceRefs)],['ruleRefs',arr(c.ruleRefs)],['featureRefs',arr(c.featureRefs)],['covers',arr(c.covers)],['acRefs',arr(c.acRefs)],['conditionRefs',arr(c.conditionRefs)]];
    return <article key={String(c.id??index)} className="rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="min-w-0 font-medium">{String(c.title??c.id??'')}</h3>
        <span className="font-mono text-[0.6875rem] text-muted-foreground">{String(c.id??'')}</span>
      </header>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {pri&&<Chip label="" value={pri} tone={pri==='P0'?'bg-bad/10 text-bad':pri==='P1'?'bg-warn/10 text-warn':'bg-muted text-muted-foreground'}/>}
        {c.designMethod!=null&&<Chip label="" value={String(c.designMethod)}/>}
        {tier!=null&&<Chip label="tier" value={String(tier)} tone={tier===3?'bg-warn/10 text-warn':'bg-muted text-muted-foreground'}/>}
        {c.storyId!=null&&<Chip label="story" value={String(c.storyId)}/>}
      </div>
      {arr(c.precondition).length>0&&<section className="mt-3"><h4 className="text-xs text-muted-foreground">{t('bench.precondition')}</h4><ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{arr(c.precondition).map((p,i)=><li key={i}>{p}</li>)}</ul></section>}
      <section className="mt-3"><h4 className="text-xs text-muted-foreground">{t('bench.steps')}</h4><ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">{arr(c.steps).map((x,i)=><li key={i}>{x}</li>)}</ol></section>
      <section className="mt-3"><h4 className="text-xs text-muted-foreground">{t('bench.expected')}</h4><p className="mt-1 text-sm">{String(c.expected??'')}</p></section>
      <section className="mt-3"><h4 className="text-xs text-muted-foreground">{t('bench.oracle')}</h4><p className="mt-1 break-all font-mono text-xs">{oracleLine(oracle)||t('bench.noOracle')}</p></section>
      {arr(c.postSteps).length>0&&<section className="mt-3"><h4 className="text-xs text-muted-foreground">{t('bench.cleanup')}</h4><ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{arr(c.postSteps).map((x,i)=><li key={i}>{x}</li>)}</ul></section>}
      {/* v2 设计证据（21 §2/§5）。旧归档没有这些字段，整段不渲染——空着比填一个假的空壳诚实。 */}
      {c.design!=null&&<section className="mt-3"><h4 className="text-xs text-muted-foreground">{t('bench.designEvidence')}</h4><dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">{Object.entries(c.design as Record<string,unknown>).map(([k,v])=><div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="break-all font-mono">{typeof v==='object'?JSON.stringify(v):String(v)}</dd></div>)}</dl></section>}
      {Array.isArray(c.assertions)&&c.assertions.length>0&&<section className="mt-3"><h4 className="text-xs text-muted-foreground">{t('bench.assertions')}</h4><ul className="mt-1 space-y-2 text-sm">{(c.assertions as Record<string,unknown>[]).map((a,i)=><li key={i} className="rounded bg-muted/40 p-2"><p>{String(a.statement??'')}</p><p className="mt-1 break-all font-mono text-[0.6875rem] text-muted-foreground">{String(a.id??'')} · {oracleLine(a.oracle as Record<string,unknown>|undefined)||t('bench.noOracle')}{Array.isArray(a.ruleRefs)&&a.ruleRefs.length>0?` · ${a.ruleRefs.join(', ')}`:''}</p></li>)}</ul></section>}
      {c.testData!=null&&<section className="mt-3"><h4 className="text-xs text-muted-foreground">{t('bench.testData')}</h4><p className="mt-1 break-all font-mono text-xs">{JSON.stringify(c.testData)}</p></section>}
      {(c.risk!=null||c.readiness!=null||c.scenarioType!=null)&&<div className="mt-3 flex flex-wrap gap-1.5">{c.scenarioType!=null&&<Chip label="scenario" value={String(c.scenarioType)}/>}{c.risk!=null&&<Chip label="impact" value={String((c.risk as Record<string,unknown>).impact??'')} tone="bg-bad/10 text-bad"/>}{c.readiness!=null&&<Chip label="execution" value={String((c.readiness as Record<string,unknown>).execution??'')} tone={String((c.readiness as Record<string,unknown>).execution)==='ready'?'bg-ok/10 text-ok':'bg-warn/10 text-warn'}/>}</div>}
      {c.risk!=null&&<p className="mt-2 text-xs text-muted-foreground">{String((c.risk as Record<string,unknown>).reason??'')}</p>}
      {c.readiness!=null&&(c.readiness as Record<string,unknown>).reason!=null&&<p className="mt-1 text-xs text-muted-foreground">{String((c.readiness as Record<string,unknown>).reason)}</p>}
      {refs.some(([,v])=>v.length>0)&&<footer className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-3">{refs.flatMap(([k,v])=>v.map((x,i)=><Chip key={k+i} label={k} value={x}/>))}</footer>}
    </article>;})}</div>;
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

export function RevisionContent({content,kind}:{content:unknown;kind:string}) {
  if(typeof content==='string')return <Markdown text={content}/>;
  if(!content||typeof content!=='object')return <pre>{JSON.stringify(content,null,2)}</pre>;
  const data=content as Record<string,unknown>;
  if(kind==='gate')return <GateReport data={data}/>;
  if(kind==='cases'&&typeof data.id==='string'&&Array.isArray(data.steps))return <RevisionContent kind="cases" content={{cases:[data]}}/>;
  if(kind==='execution')return <ExecutionReport data={data}/>;
  if(kind==='code'&&Array.isArray(data.code))return <div className="space-y-4">{data.code.map((c,i)=>{const row=c as Record<string,unknown>;return <article key={i} className="rounded border border-border p-4"><h3 className="font-medium">{String(row.caseId??'')} · {String(row.title??'')}</h3>{row.entryUrl!=null&&<p className="mt-2 break-words text-xs text-muted-foreground">{String(row.entryUrl)}</p>}<pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{String(row.code??'')}</pre></article>;})}</div>;
  if(Array.isArray(data.cases))return <CaseList cases={data.cases as Record<string,unknown>[]}/>;
  if(Array.isArray(data.modules)&&!Array.isArray(data.stories))return <ModulePlan data={data}/>;
  if(Array.isArray(data.stories)) return <ProductStructure data={data}/>;
  if(typeof data.text==='string'||typeof data.specText==='string'||typeof data.notes==='string')return <Markdown text={String(data.text??data.specText??data.notes)}/>;
  if(typeof data.code==='string')return <pre className="overflow-auto whitespace-pre-wrap text-xs">{data.code}</pre>;
  return <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-4 text-xs" aria-label={kind}>{JSON.stringify(content,null,2)}</pre>;
}
export function RevisionViewer({projectId,revision,all,onSelect}:{projectId:string;revision:Revision;all:Revision[];onSelect:(revision:Revision)=>void}) {
  const t=useT(),[state,setState]=useState<{key:string;content?:unknown;error?:string}>({key:''});
  const key=projectId+':'+revision.runId+':'+revision.id;
  useEffect(()=>{const c=new AbortController();setState({key});
    void workflowRequest<{content:unknown}>(`${workflowBase(projectId)}/${revision.runId}/artifacts/${revision.id}`,undefined,'GET',c.signal).then(r=>{if(!c.signal.aborted)setState({key,content:r.content});}).catch(e=>{if(!c.signal.aborted)setState({key,error:String(e.code??'request_failed')});});return()=>c.abort();
  },[projectId,revision.id,revision.runId,key]);
  const ready=state.key===key&&state.content!==undefined;
  return <section className="min-w-0 space-y-4" aria-label={t('workflow.artifactDetail')}>
    <header className="flex flex-wrap items-center justify-between gap-3"><h2 className="break-words font-medium">{revision.name} · v{revision.revision}</h2><a className="text-sm text-primary underline" href={`${API_BASE}/api/${workflowBase(projectId)}/${revision.runId}/artifacts/${revision.id}/export`}>{t('workflow.download')}</a></header>
    {state.error?<p role="alert" className="text-bad">{t('workflow.artifactFailed')} · {state.error}</p>:!ready?<p role="status">{t('workflow.loading')}</p>:<RevisionContent content={state.content} kind={revision.kind}/>}
    <details className="border-t border-border pt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">{t('workflow.sources')}</summary><p className="my-3 break-all">{revision.runId} · {revision.id}<br/>SHA256 {revision.contentHash}</p><div className="flex flex-wrap gap-2">{revision.sourceRefs.map(id=>{const r=all.find(x=>x.id===id);return r?<Button key={id} size="sm" onClick={()=>onSelect(r)}>{r.name} · v{r.revision}</Button>:<span key={id}>{id}</span>;})}</div>{ready&&<pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(state.content,null,2)}</pre>}</details>
  </section>;
}
