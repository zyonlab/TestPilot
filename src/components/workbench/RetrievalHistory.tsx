import {useState} from 'react';
import {useT} from '@/lib/prefs';
import type {Revision} from '@/lib/workflowRuns';
import {NodeArtifacts} from './NodeArtifacts';
import {retrievalArtifacts} from './RetrievalAudit';

export function RetrievalHistory({projectId,revisions}:{projectId:string;revisions:Revision[]}){
  const t=useT(),[open,setOpen]=useState(false),[limit,setLimit]=useState(8),audits=retrievalArtifacts(revisions);
  return <details onToggle={e=>setOpen(e.currentTarget.open)} className="space-y-3 rounded border border-border p-3">
    <summary className="cursor-pointer text-sm font-medium">{t('retrieval.runHistory')} · {audits.length||t('workflow.unknown')}</summary>
    <p className="text-xs text-muted-foreground">{t(audits.length?'retrieval.boundary':'retrieval.unknown')}</p>
    {open?<><NodeArtifacts projectId={projectId} revisions={audits.slice(-limit).reverse()} all={revisions}/>{audits.length>limit?<button type="button" className="text-sm text-primary underline" onClick={()=>setLimit(n=>n+8)}>{t('retrieval.moreRecords')}</button>:null}</>:null}
  </details>;
}
