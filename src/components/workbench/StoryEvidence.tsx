import {storyObservationGroups} from './storyObservationGroups';
import {useState} from 'react';
import {Drawer} from '@/components/overlay';
import {Button} from '@/components/ui';
import {useT} from '@/lib/prefs';
import {workflowBase,workflowRequest,type Revision} from '@/lib/workflowRuns';
type Row=Record<string,any>;
/** Old artifacts expose related feature records, never inferred criterion verification. */
export function StoryEvidence({story,index,projectId,runId}:{story:Row;index:number;projectId:string;runId:string}){
 const t=useT(),[open,setOpen]=useState(false),[report,setReport]=useState<Row>(),[error,setError]=useState('');
 const label=(value:unknown)=>{const key=String(value??'');return ['blocked','not_found','failed','attempted','observed_only','stuck','requires:wallet-session'].includes(key)?t(`storyEvidence.${key}`):key;};
 const state=(id:unknown)=>{const item=report?.states?.find((s:Row)=>s.id===id);return item?`${item.title} · ${item.route} (${item.id})`:String(id??'—');};
 const link=story.observationLinks?.find((x:Row)=>x.acceptanceIndex===index);
 async function show(){setOpen(true);if(report)return;setError('');try{
  const run=await workflowRequest<{revisions:Revision[]}>(`${workflowBase(projectId)}/${runId}`);
  const revision=run.revisions.filter(r=>r.name==='exploration/report').sort((a,b)=>b.revision-a.revision)[0];
  if(!revision){setReport({});return;}
  const result=await workflowRequest<{content:Row}>(`${workflowBase(projectId)}/${runId}/artifacts/${revision.id}`);setReport(result.content);
 }catch(e){setError(String(e));}}
 const groups=storyObservationGroups(report?.observations??[],story.featureRefs??[],link?.observationIds??[]);
 const records=groups.linked;
 const targets=(report?.plannedTargets??[]).filter((o:Row)=>story.featureRefs?.includes(o.featureId)&&['blocked','not_found','failed'].includes(o.status));
 const renderRecords=(records:Row[])=>(<ol className="space-y-3">{records.map((o:Row)=><li key={o.id} className="space-y-2 rounded border border-border p-3">
 <p>{o.id} · {o.action?.target??o.targetSpecId} · {label(o.status)}</p>
 <p className="break-all">{state(o.stateBefore)} → {state(o.stateAfter)}</p>
 {o.reason&&<p>{label(o.reason)}</p>}
 {o.controlsAfter?.length>0&&<details><summary className="cursor-pointer">{t('storyEvidence.controlsAfter')}</summary><ul className="mt-2 list-disc pl-5">{o.controlsAfter.map((v:string,i:number)=><li key={i}>{v}</li>)}</ul></details>}
 {o.effect&&<ul className="list-disc pl-5">{[...(o.effect.controlsAdded??[]),...(o.effect.stateChanged??[]),...(o.effect.textAdded??[])].map((v:string,i:number)=><li key={i}>{v}</li>)}</ul>}
 <p className="break-all text-xs text-muted-foreground">{(o.evidenceRefs??[]).join('\n')}</p>
 </li>)}</ol>);
 return <><Button size="sm" onClick={()=>void show()}>{t('storyEvidence.inspect')}</Button>
 <Drawer open={open} onClose={()=>setOpen(false)} title={t('storyEvidence.inspect')} resizeKey="story-evidence" defaultWidth={820}>
 <div className="space-y-5 p-5 text-sm">
 <p className="font-medium">{story.title}</p><p>{story.acceptance?.[index]}</p>
 <p className="text-muted-foreground">{t(link?'storyEvidence.explicit':'storyEvidence.related')}</p>
 {link&&<p>{link.status} · {link.reason}</p>}
 {error?<p role="alert" className="text-bad">{error}</p>:!report?<p role="status">{t('workflow.loading')}</p>:<>
 <h3 className="font-medium">{t('storyEvidence.actions')}</h3>
 {!records.length&&<p>{t('storyEvidence.empty')}</p>}
 {renderRecords(records)}
 {!!groups.related.length&&<section className="space-y-3">
  <h3 className="font-medium">{t('storyEvidence.candidates')}</h3>
  <p className="text-muted-foreground">{t('storyEvidence.candidatesHint')}</p>
  {renderRecords(groups.related)}
 </section>}
 <h3 className="font-medium">{t('storyEvidence.blockers')}</h3>
 {targets.map((o:Row)=><p key={o.targetSpecId}>{o.targetSpecId} · {o.status} · {label(o.reason)}</p>)}
 {!targets.length&&<p>{t('storyEvidence.noBlocker')}</p>}
 <p>{t('storyEvidence.stop')} · {label(report.stopReason?.kind??'—')}</p>
 </>}
 {!!link?.nextSteps?.length&&<section><h3 className="font-medium">{t('storyEvidence.proposed')}</h3><ul className="list-disc pl-5">{link.nextSteps.map((s:string,i:number)=><li key={i}>{s}</li>)}</ul></section>}
 </div></Drawer></>;
}
