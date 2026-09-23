import {StoryEvidence} from "./StoryEvidence";
import {readProjectContext,navigateProject} from '@/lib/projectContext';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ModuleFlow } from './ModuleFlow';
import { useT } from '@/lib/prefs';
type Item=Record<string,unknown>;
export function ProductStructure({data,hideStories=false,onScope,projectId,runId}:{data:Item;projectId?:string;runId?:string;hideStories?:boolean;onScope?:(scope:Set<string>|null)=>void}) {
  const t=useT(),[selected,setSelected]=useState(()=>readProjectContext().scope),[query,setQuery]=useState('');
  useEffect(()=>{const h=()=>setSelected(readProjectContext().scope);window.addEventListener('hashchange',h);return()=>window.removeEventListener('hashchange',h);},[]);
  const selectModule=(id:string)=>{setSelected(id);navigateProject(new URLSearchParams(location.hash.split('?')[1]).get('open')??'canvas',{scope:id});};
  const modules=useMemo(()=>(Array.isArray(data.modules)?data.modules:[]) as Item[],[data]);
  const stories=(Array.isArray(data.stories)?data.stories:[]) as Item[];
  const selectedIds=useMemo(()=>{const ids=new Set([selected]);for(let i=0;i<modules.length;i++)for(const m of modules)if(ids.has(String(m.parentId??'')))ids.add(String(m.id));return ids;},[modules,selected]);
  useEffect(()=>onScope?.(selected?selectedIds:null),[onScope,selected,selectedIds]);
  const storyModules=(s:Item):string[]=>Array.isArray(s.moduleIds)?s.moduleIds.map(String):modules.filter(m=>String(m.name)===s.activity||(Array.isArray(m.flowIds)&&m.flowIds.includes(s.flowId))).map(m=>String(m.id));
  const filtered=stories.filter(s=>(!selected||storyModules(s).some(id=>selectedIds.has(id)))&&JSON.stringify(s).toLowerCase().includes(query.toLowerCase()));
  const storyCount=useCallback((id:string)=>stories.filter(s=>storyModules(s).includes(id)).length,[stories]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="space-y-5">{modules.length>0&&<section aria-label={t('bench.productStructure')} className="space-y-3"><div className="flex items-center gap-3"><h3 className="font-medium">{t('bench.productStructure')}</h3><button className="text-xs text-primary underline" onClick={()=>selectModule('')}>{t('bench.allModules')}</button></div>{/* 还没有故事的时候（modules 节点）不显示每个模块的故事数：写 0 像是每个模块都漏了故事。
      扇出要到 stories 合并之后才算得了（docs/v3/history/24 §8.5）。 */}
    <ModuleFlow modules={modules} selected={selected} onSelect={selectModule} storyCount={hideStories?undefined:storyCount} rootSubtitle={`${modules.length}${hideStories?'':` · ${stories.length} ${t('workflow.stage.stories')}`}`}/></section>}
    {!hideStories&&<><div className="flex items-center justify-between gap-3"><h3 className="font-medium">{t('workflow.stage.stories')} · {filtered.length}</h3><input aria-label={t('bench.searchStories')} placeholder={t('bench.searchStories')} value={query} onChange={e=>setQuery(e.target.value)} className="min-w-0 rounded border border-border bg-background px-3 py-2 text-sm"/></div>
    <div className="space-y-3">{filtered.map(s=><details key={String(s.id)} className="rounded-lg border border-border bg-card p-4"><summary className="cursor-pointer text-sm font-medium">{String(s.id)} · {String(s.title)}<span className="ml-2 text-xs font-normal text-muted-foreground">{storyModules(s).map(id=>String(modules.find(m=>m.id===id)?.name??id)).join(' / ')}</span></summary><p className="mt-3 text-sm text-muted-foreground">{String(s.role??'')} · {String(s.benefit??'')}</p><ul className="mt-3 list-disc space-y-2 pl-5 text-sm">{Array.isArray(s.acceptance)&&s.acceptance.map((a,i)=><li key={i}>{String(a)}{projectId&&runId&&<div className="mt-2"><StoryEvidence story={s} index={i} projectId={projectId} runId={runId}/></div>}</li>)}</ul>{(Array.isArray(s.featureRefs)&&s.featureRefs.length>0||Array.isArray(s.ruleRefs)&&s.ruleRefs.length>0)&&<p className="mt-3 flex flex-wrap gap-1.5">{[...(Array.isArray(s.featureRefs)?s.featureRefs:[]).map(x=>['featureRefs',String(x)] as const),...(Array.isArray(s.ruleRefs)?s.ruleRefs:[]).map(x=>['ruleRefs',String(x)] as const)].map(([k,v],i)=><span key={k+i} className="rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground"><span className="opacity-70">{k}</span> {v}</span>)}</p>}{s.source!=null&&<p className="mt-3 break-words text-xs text-muted-foreground">{String(s.source)}</p>}</details>)}</div></>}
  </div>;
}
