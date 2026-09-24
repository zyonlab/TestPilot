import {useT} from '@/lib/prefs';
export type BusinessTransitionView={id:string;featureId:string;name:string;claimType:string;preconditions:string[];action:string;outcome:string;failureModes:string[];preparation:string;sourceRefs:string[]};
export type TransitionStoryView={id:string;title:string;acceptance:string[];businessTransitions?:Array<{transitionId:string;preconditions:string[];acceptanceIndexes:number[];failureAcceptanceIndexes:number[]}>};
/** Displays planning coverage separately from observation and requirement approval. */
export function BusinessLifecycle({transitions=[],stories,findings=[]}:{transitions?:BusinessTransitionView[];stories?:TransitionStoryView[];findings?:Array<{code:string;message:string}>}){
 const t=useT();
 return <section className="space-y-3 rounded border border-border p-4">
 <h3 className="font-semibold">{t('businessLifecycle.title')}</h3>
 <p className="text-sm text-muted-foreground">{t('businessLifecycle.hint')}</p>
 {!transitions.length?<p className="text-sm">{t('businessLifecycle.unknown')}</p>:transitions.map(transition=>{
  const linked=stories?.filter(s=>s.businessTransitions?.some(b=>b.transitionId===transition.id));
  return <details key={transition.id} className="rounded border border-border p-3"><summary className="cursor-pointer">{transition.name} · {t(transition.claimType==='hypothesis'?'businessLifecycle.hypothesis':'businessLifecycle.normative')}{linked!==undefined&&` · ${t(linked.length?'businessLifecycle.linked':'businessLifecycle.missing')} (${linked.length})`}</summary>
   <dl className="mt-3 grid gap-2 text-sm"><dt className="font-medium">{t('businessLifecycle.prerequisites')}</dt><dd><ul className="list-disc pl-5">{transition.preconditions.map((p,i)=><li key={i}>{p}</li>)}</ul></dd>
   <dt className="font-medium">{t('businessLifecycle.action')}</dt><dd>{transition.action} → {transition.outcome}</dd>
   <dt className="font-medium">{t('businessLifecycle.failures')}</dt><dd><ul className="list-disc pl-5">{transition.failureModes.map((p,i)=><li key={i}>{p}</li>)}</ul></dd>
   <dt className="font-medium">{t('businessLifecycle.preparation')}</dt><dd>{transition.preparation}</dd>
   <dt className="font-medium">{t('businessLifecycle.sources')}</dt><dd className="break-words">{transition.sourceRefs.join(', ')} · {transition.featureId}</dd></dl>
   {linked?.map(story=><div key={story.id} className="mt-3 border-t border-border pt-3 text-sm"><p className="font-medium">{story.id} · {story.title}</p>{story.businessTransitions?.filter(b=>b.transitionId===transition.id).map((b,i)=><div key={i}><p>{b.preconditions.join('；')}</p><ul className="list-disc pl-5">{[...new Set([...b.acceptanceIndexes,...b.failureAcceptanceIndexes])].map(n=><li key={n}>{story.acceptance[n]??t('businessLifecycle.invalid')}</li>)}</ul></div>)}</div>)}
  </details>;
 })}
 {findings.length>0&&<ul className="list-disc pl-5 text-sm text-warn">{findings.map((f,i)=><li key={i}>{f.code}: {f.message}</li>)}</ul>}
 </section>;
}
