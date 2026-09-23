import { useT } from '@/lib/prefs';
import { LifecycleSchema, LifecycleReceiptSchema } from '../../../packages/harness-testing/src/exec/lifecycle';

export function LifecycleDetail({contract,value,receipt=false}:{contract?:unknown;value?:unknown;receipt?:boolean}){
  const t=useT();
  const parsedContract=LifecycleSchema.safeParse(contract),parsedReceipt=LifecycleReceiptSchema.safeParse(value);
  const c=parsedContract.success?parsedContract.data:undefined;
  const r=parsedReceipt.success?parsedReceipt.data:undefined;
  return <section className="space-y-2 rounded border border-border p-3 text-xs">
    <h4 className="font-medium">{t(receipt?'lifecycle.receipt':'lifecycle.contract')}</h4>
    {!c&&!r&&!receipt&&<p className="text-warn">{t('lifecycle.unknown')}</p>}
    {c&&<>
      <p>{t(`lifecycle.mode.${c.mode}`)} · {c.rationale}</p>
      <p className="break-words font-mono">{t('lifecycle.bindings')}: {c.sourceRefs?.join(', ')} → {c.supports?.join(', ')}</p>
      <ul className="space-y-1">{c.baseline?.map((b,i)=><li key={i}>{t('lifecycle.baseline')}: {b.statement}</li>)}</ul>
      {c.resources?.map(r=><div key={r.id} className="space-y-1 rounded bg-muted/40 p-2"><p className="break-words font-mono">{r.id} · {r.identity} · {r.sourceRef}</p><p>{t('lifecycle.establish')}: {r.establishAfterStep} · {r.established.statement}</p><p>{t('lifecycle.ownership')}: {r.ownership.statement}</p>{c.cleanup?.filter(x=>x.resourceId===r.id).map(x=><p key={x.id}>{t('lifecycle.cleanup')}: {x.postStep} · {x.verified.statement}</p>)}</div>)}
      <details><summary className="cursor-pointer">{t('lifecycle.evidence')}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(c,null,2)}</pre></details>
    </>}
    {receipt&&!r&&<p className="text-warn">{t('lifecycle.unknown')}</p>}
    {r&&<>
      <p>{t(`lifecycle.status.${r.status}`)}</p>
      <ul className="space-y-1">{r.checks?.map((x,i)=><li key={i}>{t(`lifecycle.${x.phase}`)} · {x.resourceId??x.id} · {t(`lifecycle.status.${x.status}`)} · {x.statement}{x.detail&&<p className="break-words text-muted-foreground">{x.detail}</p>}</li>)}</ul>
      <ul className="space-y-1">{r.cleanup?.map((x,i)=><li key={i}>{t('lifecycle.cleanup')} · {x.id} · {t(`lifecycle.status.${x.status}`)} · {x.detail}</li>)}</ul>
      {!!r.pendingResources?.length&&<div className="rounded border border-warn/50 p-2 text-warn"><p>{t('lifecycle.pending')}</p>{r.pendingResources.map(x=><p key={x.id} className="break-words font-mono">{x.id} · {x.identity} · {x.reason}</p>)}</div>}
    </>}
  </section>;
}
