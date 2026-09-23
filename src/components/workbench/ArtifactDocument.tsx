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
  const t=useT(),a=object(data.assessment),scope=object(a.scope),counts=object(a.counts),progress=object(a.progress);
  const targets=rows(a.targets),stop=object(a.stop??data.stopReason??data.stopped);
  const text=(code:unknown)=>{const key=`exploration.evidence.${String(code)}`,value=t(key);return value===key?String(code??t('exploration.evidence.unknown')):value;};
  const list=(v:unknown)=>Array.isArray(v)?v.map(String):[];
  const collected=a.version===1;
  return <article className="space-y-6">
    <header><h3 className="text-xl font-semibold">{t('artifact.explorationReport')}</h3><p className="mt-2 font-medium">{text(collected?a.status:'unknown')}</p><p className="mt-2 text-sm text-muted-foreground">{t('exploration.evidence.boundary')}</p></header>
    {!collected&&<p role="status">{t('exploration.evidence.legacy')}</p>}
    <section className="space-y-2 text-sm"><h4 className="font-semibold">{t('exploration.scope')}</h4><p className="break-all">{String(scope.entryUrl??data.entryUrl??data.url??'—')}</p>
      <p>{[...list(scope.routes),...list(scope.urlPatterns)].join(' · ')}</p>
      <p>{t('exploration.evidence.denominator')}: {collected&&scope.denominator!=null?String(scope.denominator):t('exploration.evidence.unknown')}</p>
      <p>{t('exploration.evidence.stop')}: {text(stop.kind??'unknown')}{stop.n!=null?` (${stop.n})`:''}</p>
      <ul className="list-disc pl-5">{list(a.reasons).map(reason=><li key={reason}>{text(reason)}</li>)}</ul>
    </section>
    {collected&&<><dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">{['seen','attempted','interactionCompleted','observationCompleted','assertionsPassed'].map(key=><div key={key}><dt className="text-xs text-muted-foreground">{text(key)}</dt><dd>{counts[key]==null?t('exploration.evidence.not_collected'):String(counts[key])}</dd></div>)}</dl>
      <section className="space-y-2"><h4 className="font-semibold">{t('exploration.evidence.progress')}</h4><p className="text-sm text-muted-foreground">{t('exploration.evidence.progressHint')}</p>{a.progress==null?<p>{t('exploration.evidence.not_collected')}</p>:<dl className="grid grid-cols-2 gap-4">{['abstractStates','uniqueWalkedTransitions','repeatedActions','invalidTransitions','abstraction'].map(key=><div key={key}><dt className="text-xs text-muted-foreground">{text(key)}</dt><dd>{String(progress[key]??'—')}</dd></div>)}</dl>}</section>
      <section className="space-y-3"><h4 className="font-semibold">{t('exploration.evidence.targets')}</h4>{targets.map((target,i)=><details key={i} className="rounded border border-border p-3"><summary className="cursor-pointer text-sm"><span className="font-mono">{String(target.targetSpecId)}</span> · {text(target.reason)}</summary><div className="mt-3 space-y-3 text-sm"><p>{t('exploration.evidence.assertionsPassed')}: {text(target.assertion)}</p>
        <p>{t('artifact.references')}: {[...list(target.observationIds),...list(target.evidenceRefs)].join(' · ')||t('exploration.evidence.not_collected')}</p>
        {list(target.invalidRefs).length>0&&<p>{t('exploration.evidence.invalid_evidence')}: {list(target.invalidRefs).join(' · ')}</p>}
        <DocumentFields data={rows(data.observations).filter(o=>list(target.observationIds).includes(String(o.id)))}/>
      </div></details>)}</section>
      {list(a.unvisited).length>0&&<section><h4 className="font-semibold">{t('exploration.evidence.unvisited')}</h4><ul className="list-disc pl-5 text-sm">{list(a.unvisited).map(url=><li key={url} className="break-all">{url}</li>)}</ul></section>}
    </>}
    <section><h4 className="mb-3 font-semibold">{t('artifact.unknowns')}</h4><DocumentFields data={data.unknowns??[]}/></section>
    <details><summary className="cursor-pointer text-sm">{t('exploration.evidence.raw')}</summary><DocumentFields data={Object.fromEntries(Object.entries(data).filter(([k])=>k!=='assessment'))}/></details>
  </article>;
}
