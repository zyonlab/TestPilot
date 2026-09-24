import {BusinessLifecycle,type BusinessTransitionView,type TransitionStoryView} from './BusinessLifecycle';
import {useEffect,useState} from 'react';
import {workflowBase,workflowRequest} from '@/lib/workflowRuns';
import {useT} from '@/lib/prefs';
import {Button} from '@/components/ui';
type Review={inheritedFromRun?:string;rejection?:{note:string;at:string};transitions?:BusinessTransitionView[];stories?:TransitionStoryView[];transitionFindings?:Array<{code:string;message:string}>;pending:boolean;revisionId?:string;candidates?:Array<{id:string;title:string;acceptance:string[];requirementDraft:{reason:string;questions:string[]}}>};
export function StoryRequirementsReview({projectId,runId,status,refresh}:{projectId:string;runId:string;status:string;refresh:()=>void}){
 const [data,setData]=useState<Review>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const base=`${workflowBase(projectId)}/${runId}/story-requirements`;
 useEffect(()=>{let live=true;setData(undefined);setError('');workflowRequest<Review>(base).then(x=>{if(live)setData(x);}).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[base,status]);
 async function approve(){setBusy(true);setError('');try{await workflowRequest(base+'/approve',{revisionId:data?.revisionId});setData({...data!,pending:false});refresh();}catch(e){setError(String(e));}finally{setBusy(false);}}
 async function reject(note:string){setBusy(true);setError('');try{const next=await workflowRequest<Review>(base+'/reject',{revisionId:data?.revisionId,note});setData({...data!,...next});refresh();}catch(e){setError(String(e));}finally{setBusy(false);}}
 return <div className="space-y-4">{data&&<BusinessLifecycle transitions={data.transitions} stories={data.stories} findings={data.transitionFindings}/>}<StoryRequirementsPanel data={data} error={error} busy={busy} status={status} approve={approve} reject={reject}/></div>;
}
export function StoryRequirementsPanel({data,error,busy,status,approve,reject}:{data?:Review;error:string;busy:boolean;status:string;approve:()=>Promise<void>;reject?:(note:string)=>Promise<void>}){
 const t=useT();const [note,setNote]=useState('');const locked=busy||status==='running'||status==='queued';
 if(!data?.pending)return error?<p role="alert">{error}</p>:data?.inheritedFromRun?<p className="break-all rounded border border-border p-3 text-sm">{t('stories.review.inherited')} {data.inheritedFromRun}</p>:null;
 return <section className="rounded border border-border p-4 space-y-3"><h3 className="font-semibold">{t('stories.review.title')}</h3><p className="text-sm">{t('stories.review.hint')}</p>
 {data.candidates?.map(s=><details key={s.id} className="rounded border border-border p-3"><summary>{s.id} · {s.title}</summary><p className="my-2 text-sm">{s.requirementDraft.reason}</p><ul className="list-disc pl-5 text-sm">{s.acceptance.map((a,i)=><li key={i}>{a}</li>)}</ul><ul className="mt-2 list-disc pl-5 text-sm">{s.requirementDraft.questions.map((q,i)=><li key={i}>{q}</li>)}</ul></details>)}
 {data.rejection&&<p className="rounded border border-warn/50 p-2 text-sm text-warn">{t('stories.review.rejected')}: {data.rejection.note}</p>}
 <div className="flex flex-wrap items-start gap-2"><Button disabled={locked} onClick={()=>void approve()}>{t('stories.review.approve')}</Button>
 {reject&&<><textarea aria-label={t('stories.review.rejectReason')} placeholder={t('stories.review.rejectReason')} className="min-h-9 min-w-0 flex-1 rounded border border-border bg-background p-2 text-sm" value={note} onChange={e=>setNote(e.target.value)}/><Button variant="outline" disabled={locked||note.trim().length<4} onClick={()=>void reject(note).then(()=>setNote(''))}>{t('stories.review.reject')}</Button></>}</div>
 <p className="text-xs text-muted-foreground">{t('stories.review.after')}</p>{error&&<p role="alert">{error}</p>}</section>;
}
