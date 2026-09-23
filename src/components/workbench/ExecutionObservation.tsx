import { readExecutionObservation, ExecutionAttemptSchema } from '../../../packages/harness-core/src/execution-observation';
import { useT } from '@/lib/prefs';

/** The same validated, content-free receipt is used for preparation and formal runs. */
export function ExecutionObservation({value,attempts}:{value:unknown;attempts?:unknown}) {
  const t=useT();
  if(Array.isArray(attempts)&&attempts.length) return <div className="space-y-3">{attempts.map((raw,i)=>{
    const parsed=ExecutionAttemptSchema.safeParse(raw);
    if(!parsed.success)return <p key={i}>{t('observation.missing')}</p>;
    const a=parsed.data;
    return <section key={i}><p className="mb-2 text-xs font-medium">{t('observation.attempt',{n:a.attempt})} · {a.status==='unknown'?t('workflow.unknown'):t(`workflow.status.${a.status}`)} · {(a.durationMs/1000).toFixed(2)} s</p><ExecutionObservation value={a.observation}/></section>;
  })}</div>;
  const data=readExecutionObservation(value);
  if(!data)return <p className="text-xs text-muted-foreground">{t('observation.missing')}</p>;
  const slowest=data.stages.reduce<typeof data.stages[number]|undefined>((a,b)=>!a||b.durationMs>a.durationMs?b:a,undefined);
  return <section className="space-y-2 rounded border border-border p-3 text-xs" aria-label={t('observation.title')}>
    <p className="font-medium">{t('observation.title')}{slowest&&<> · {t('observation.slowest')}: {t(`observation.stage.${slowest.stage}`)} {(slowest.durationMs/1000).toFixed(2)} s</>}</p>
    <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr>{['stage','duration','status','calls','source'].map(k=><th key={k} scope="col" className="px-2 py-1 font-medium">{t(`observation.${k}`)}</th>)}</tr></thead>
      <tbody>{data.stages.map((s,i)=><tr key={i} className={s.status==='failed'?'text-bad':s.status!=='completed'?'text-warn':''}>
        <th scope="row" className="px-2 py-1 font-normal">{t(`observation.stage.${s.stage}`)}</th><td className="px-2 py-1 font-mono">{(s.durationMs/1000).toFixed(2)} s</td>
        <td className="px-2 py-1">{t(`observation.status.${s.status}`)}{s.failure&&<> · {t(`report.attribution.${s.failure.attribution}`)}</>}</td>
        <td className="px-2 py-1">{s.model.forwarded??t('workflow.unknown')}{s.model.blocked!==null&&s.model.blocked>0&&<> · {t('observation.blocked',{n:s.model.blocked})}</>}</td>
        <td className="px-2 py-1">{t(`observation.source.${s.model.source}`)}</td>
      </tr>)}</tbody></table></div>
    <p className="text-muted-foreground">{t('observation.cache',{session:t(`observation.cache.${data.cache.session}`),midscene:t(`observation.cache.${data.cache.midscene}`)})}</p>
    {data.retries.map((r,i)=><p key={i} className="text-warn">{t(`observation.retry.${r.reason}`)} · {t(`observation.stage.${r.stage}`)} · {(r.delayMs/1000).toFixed(2)} s</p>)}
  </section>;
}
