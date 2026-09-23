import { useState } from 'react';
import { RetrievalAuditSchema } from '../../../packages/harness-core/src/retrieval-audit';
import { useT } from '@/lib/prefs';
import type { Revision } from '@/lib/workflowRuns';

/** Run-wide entry, deliberately not inferred from a declared node or an active stage. */
export const retrievalArtifacts = (revisions:Revision[]) => revisions.filter(r=>r.kind==='report'&&r.name.startsWith('retrieval/'));
function IdList({ids}:{ids:string[]}){
  const t=useT(),[limit,setLimit]=useState(32);
  return <><p className="break-words font-mono text-xs">{ids.slice(0,limit).join(' · ')||'—'}</p>{ids.length>limit?<button type="button" className="text-primary underline" onClick={()=>setLimit(n=>n+32)}>{t('retrieval.more')}</button>:null}</>;
}
export function RetrievalAudit({value}:{value:unknown}){
  const t=useT(),parsed=RetrievalAuditSchema.safeParse(value);
  if(!parsed.success)return <p>{t('retrieval.unknown')}</p>;
  const a=parsed.data,d=a.diagnostics;
  const materials=new Map(a.materials.map(m=>[m.docId,m]));
  return <section className="space-y-4 text-sm" aria-label={t('retrieval.title')}>
    <p className="text-muted-foreground">{t('retrieval.boundary')}</p>
    <dl className="space-y-2 break-words">
      <div><dt>{t('retrieval.budget')}</dt><dd>{d.estimatedTokens} / {d.budgetTokens} · {t('retrieval.estimate')}</dd></div>
      <div><dt>{t('retrieval.query')}</dt><dd>{a.request.query||'—'}</dd></div>
      <div><dt>{t('retrieval.serverScope')}</dt><dd>{a.association.serverRunId} · {a.association.serverActiveStages.join(', ')||t('workflow.unknown')}</dd></div>
      <div><dt>{t('retrieval.declaredScope')}</dt><dd>{a.association.declaredNode??t('workflow.unknown')} · {a.association.declaredUnitId??t('workflow.unknown')}</dd></div>
      <div><dt>{t('retrieval.evaluation')}</dt><dd>{t('retrieval.unassessed')}</dd></div>
    </dl>
    <section><h3 className="font-medium">{t('retrieval.selected')} · {a.delivery.chunks.length}</h3>
      {a.delivery.chunks.map(c=>{const m=materials.get(c.docId);return <details key={c.id} className="mt-2 rounded border border-border p-3">
        <summary className="cursor-pointer break-words">{c.id} · {c.heading.join(' / ')} · {c.tokens} {t('retrieval.estimate')}</summary>
        <p className="mt-2">{t(c.why==='requested by id'?'retrieval.requested':c.why==='matches the query'?'retrieval.match':'retrieval.neighbour')}</p>
        <p>{t(`retrieval.source.${m?.sourceType??'unknown'}`)} · {t(`retrieval.evidence.${m?.sourceEvidence??'unknown'}`)}</p>
        <p className="break-all font-mono text-xs">{m?.revisionId} · {m?.contentHash} · {m?.originRunId} · {t(`retrieval.${m?.inheritance??'unknown'}`)}</p>
        <IdList ids={m?.sourceRefs??[]}/>
        <p className="mt-2 text-xs text-muted-foreground">{t('retrieval.frozenText')}</p>
        <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{c.text}</pre>
      </details>;})}
    </section>
    {(['budgetOmittedIds','deliveryOmittedIds','unknownRequiredIds','duplicateRequestedIds'] as const).map(key=><section key={key}><h3 className="font-medium">{t(`retrieval.${key}`)} · {d[key].length}</h3><IdList ids={d[key]}/></section>)}
    <p className="text-muted-foreground">{t('retrieval.followup')}</p>
    <details className="rounded border border-border p-3"><summary className="cursor-pointer">{t('retrieval.fingerprints')}</summary>
      <dl className="mt-2 space-y-2 break-all font-mono text-xs">{[['delivery',a.deliveryDigest],['materials',a.materialsHash],['input',a.inputHash],['index',a.indexDigest]].map(([key,digest])=><div key={key}><dt>{key} SHA256</dt><dd>{digest}</dd></div>)}</dl>
      {a.materials.map(m=><p className="mt-2 break-all text-xs" key={m.revisionId}>{m.docId} · {m.revisionId} · {m.contentHash} · {t(`retrieval.source.${m.sourceType}`)}{m.sources.map(s=><span className="block" key={s.revisionId}>{s.name} · {s.revisionId} · {s.runId} · {s.contentHash}</span>)}</p>)}
    </details>
  </section>;
}
