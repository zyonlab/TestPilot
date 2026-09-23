import { useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { useT } from '@/lib/prefs';

export type DocumentData = Record<string, unknown>;
const object = (v: unknown): DocumentData => v && typeof v === 'object' && !Array.isArray(v) ? v as DocumentData : {};
const rows = (v: unknown): DocumentData[] => Array.isArray(v) ? v.map(object) : [];
const technical = /^(id|schemaVersion|hash|.*Hash|.*Digest|selector|.*Refs|.*Ids|stateBefore|stateAfter|stateId|charterId)$/;

/** Lossless fallback: unknown fields remain readable and never silently disappear. */
export function DocumentFields({data,depth=0}:{data:unknown;depth?:number}) {
  const t=useT();
  const label=(key:string)=>{const value=t(`artifact.field.${key}`);return value===`artifact.field.${key}`?key.replace(/([a-z])([A-Z])/g,'$1 $2'):value;};
  const valueLabel=(v:string)=>{const value=t(`artifact.value.${v}`);return value===`artifact.value.${v}`?v:value;};
  if(data===null||data===undefined)return <span className="text-muted-foreground">—</span>;
  if(typeof data==='boolean')return <span>{t(data?'artifact.yes':'artifact.no')}</span>;
  if(typeof data==='string')return <Markdown text={valueLabel(data)}/>;
  if(typeof data!=='object')return <span>{String(data)}</span>;
  if(Array.isArray(data))return data.length?<ul className="space-y-3">{data.map((item,i)=><li key={i} className="min-w-0 border-b border-border/60 pb-3 last:border-0">{typeof item==='object'&&item!==null?<details open={data.length<=3}><summary className="cursor-pointer py-2 font-medium">{String(object(item).name??object(item).title??object(item).statement??object(item).path??object(item).id??`${t('artifact.item')} ${i+1}`)}</summary><div className="mt-2"><DocumentFields data={item} depth={depth+1}/></div></details>:<DocumentFields data={item} depth={depth+1}/>}</li>)}</ul>:<span className="text-muted-foreground">{t('artifact.empty')}</span>;
  if(Object.keys(data).length===0)return <span className="text-muted-foreground">{t('artifact.empty')}</span>;
  const entries=Object.entries(data),visible=entries.filter(([k])=>!technical.test(k)),meta=entries.filter(([k])=>technical.test(k));
  return <div className="min-w-0 space-y-4 text-sm leading-7 break-words">{visible.map(([key,value])=><section key={key}>{value&&typeof value==='object'?<details open={depth===0&&!Array.isArray(value)}><summary className="cursor-pointer font-medium">{label(key)}{Array.isArray(value)?` · ${value.length}`:''}</summary><div className="mt-3 pl-3"><DocumentFields data={value} depth={depth+1}/></div></details>:<><h4 className="mb-1 text-xs text-muted-foreground">{label(key)}</h4><DocumentFields data={value} depth={depth+1}/></>}</section>)}{meta.length>0&&<details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t('artifact.references')}</summary><dl className="mt-2 space-y-2">{meta.map(([key,value])=><div key={key}><dt>{label(key)}</dt><dd className="whitespace-pre-wrap break-all">{typeof value==='object'?JSON.stringify(value,null,2):String(value??'—')}</dd></div>)}</dl></details>}</div>;
}

export function RulePackDocument({data}:{data:DocumentData}) {
  const t=useT(),[query,setQuery]=useState('');
  const pack=object(data.rulePack),rules=rows(pack.rules),modules=rows(pack.modules),features=rows(pack.features);
  const term=query.trim().toLocaleLowerCase(),filtered=rules.filter(r=>JSON.stringify(r).toLocaleLowerCase().includes(term));
  const featureName=(id:unknown)=>String(features.find(f=>f.id===id)?.name??id);
  const moduleOf=(r:DocumentData)=>features.find(f=>Array.isArray(r.featureIds)&&r.featureIds.includes(f.id))?.moduleId;
  const groups=[...modules.filter(m=>filtered.some(r=>moduleOf(r)===m.id)),{id:undefined,name:t('artifact.otherRules')}];
  const rest=Object.fromEntries(Object.entries(pack).filter(([k])=>!['rules','modules','features','product','version','id','network','accountMode','appliesTo'].includes(k)));
  return <article className="space-y-7">
    <header className="space-y-2"><h3 className="text-xl font-semibold">{String(pack.product??pack.id??t('surface.rulePacks'))}</h3><p className="text-sm text-muted-foreground">{String(pack.version??'')} · {t('artifact.rulesCount')} {rules.length} · {t('artifact.featuresCount')} {features.length}</p></header>
    <DocumentFields data={Object.fromEntries(['network','accountMode','appliesTo'].filter(k=>pack[k]!==undefined).map(k=>[k,pack[k]]))}/>
    <section className="space-y-4"><label className="block text-sm font-medium">{t('artifact.searchRules')}<input value={query} onChange={e=>setQuery(e.target.value)} type="search" className="mt-2 block w-full rounded border border-border bg-background px-3 py-2 font-normal"/></label><p role="status" className="text-xs text-muted-foreground">{filtered.length} / {rules.length}</p>
      {groups.map(m=>{const group=filtered.filter(r=>m.id===undefined?!modules.some(mod=>mod.id===moduleOf(r)):moduleOf(r)===m.id);return group.length>0&&<section key={String(m.id)} className="space-y-3"><h3 className="border-b border-border pb-2 font-semibold">{String(m.name)}</h3>{group.map((r,i)=><article key={String(r.id??i)} className="space-y-2 py-3"><div className="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>{String(r.id??'')}</span>{r.riskFloor!=null&&<span>{String(r.riskFloor)}</span>}<span>{t(`artifact.value.${r.claimType}`)===`artifact.value.${r.claimType}`?String(r.claimType??''):t(`artifact.value.${r.claimType}`)}</span></div><Markdown text={String(r.statement??'')}/>{Array.isArray(r.featureIds)&&<p className="text-xs text-muted-foreground">{r.featureIds.map(featureName).join(' / ')}</p>}<details><summary className="cursor-pointer text-sm text-primary">{t('artifact.ruleDetails')}</summary><div className="mt-3"><DocumentFields data={Object.fromEntries(Object.entries(r).filter(([k])=>!['id','riskFloor','claimType','statement','featureIds'].includes(k)))}/></div></details></article>)}</section>;})}
      {filtered.length===0&&<p className="text-sm text-muted-foreground">{t('artifact.noMatches')}</p>}
    </section>
    <details><summary className="cursor-pointer font-medium">{t('artifact.structure')}</summary><div className="mt-4"><DocumentFields data={{modules,features}}/></div></details>
    <details><summary className="cursor-pointer font-medium">{t('artifact.configuration')}</summary><div className="mt-4"><DocumentFields data={rest}/></div></details>
  </article>;
}

export function ExplorationDocument({data}:{data:DocumentData}) {
  const t=useT(),coverage=object(data.coverage);
  return <article className="space-y-6"><h3 className="text-xl font-semibold">{t('artifact.explorationReport')}</h3><DocumentFields data={{entryUrl:data.entryUrl,completion:data.completion,stopReason:data.stopReason}}/>
    <section><h3 className="mb-3 font-semibold">{t('artifact.coverage')}</h3><dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">{Object.entries(coverage).map(([key,value])=><div key={key}><dt className="text-xs text-muted-foreground">{t(`artifact.field.${key}`)===`artifact.field.${key}`?key:t(`artifact.field.${key}`)}</dt><dd className="mt-1 text-base font-medium">{String(value)}</dd></div>)}</dl><p className="mt-3 text-sm text-muted-foreground">{t('artifact.coverageHint')}</p></section>
    <section><h3 className="mb-3 font-semibold">{t('artifact.unknowns')}</h3><DocumentFields data={data.unknowns??[]}/></section>
    <DocumentFields data={Object.fromEntries(Object.entries(data).filter(([k])=>!['entryUrl','completion','stopReason','coverage','unknowns'].includes(k)))}/>
  </article>;
}
