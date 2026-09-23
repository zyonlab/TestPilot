import {useT} from '@/lib/prefs';
/** Optional receipt: legacy and malformed data never become a cache-hit assertion. */
export function EvidenceReuse({value,context}:{value?:unknown;context?:unknown}){
 const t=useT(),r=value&&typeof value==='object'?value as Record<string,any>:null;
 const c=context??r?.context,valid=c&&typeof c==='object'&&(c as any).version===1?c as Record<string,any>:null;
 const collected=Array.isArray(r?.events)&&r.events.every((e:any)=>e&&['used','fallback','action-error'].includes(e.status)&&typeof e.reason==='string'&&(!e.source?e.status==='fallback':['revision','observation','edge','state'].every(k=>typeof e.source[k]==='string')));
 const events=collected?r!.events:[];
 const rejected=Array.isArray(valid?.rejected)?valid.rejected.filter((e:any)=>e&&typeof e==='object'):[];
 return <section className="space-y-2 rounded border border-border p-3 text-xs">
  <h4 className="font-medium">{t('reuse.title')}</h4><p className="text-muted-foreground">{t('reuse.notice')}</p>
  {!valid?<p>{t('reuse.unknown')}</p>:<><p>{t('reuse.selected',{n:Array.isArray(valid.hints)?valid.hints.length:0})} · {collected?t('reuse.used',{n:events.filter((e:any)=>e.status==='used').length}):t('reuse.unknown')}</p><p className="break-all font-mono">{String(valid.digest??'')} · {String(valid.sourceRevision??'')}</p>
  {rejected.map((e:any,i:number)=><p key={i}>{t('reuse.rejected')} · {String(e.observation??'')} · {t(`reuse.reason.${e.reason}`)}</p>)}
  {rejected.some((e:any)=>['metadata_unknown','source_ancestry_unknown'].includes(e.reason))?<p>{t('reuse.versionHelp')}</p>:null}</>}
  {events.map((e:any,i:number)=><div key={i}><p>{t(`reuse.${e.status}`,{n:1})} · {String(e.label??'')} · {t(`reuse.reason.${e.reason}`)}</p>{e.source?<p className="break-all font-mono">{[e.source.revision,e.source.observation,e.source.edge,e.source.state].map(String).join(' · ')}</p>:null}</div>)}
 </section>;
}
