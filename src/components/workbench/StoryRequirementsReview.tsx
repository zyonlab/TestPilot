import {BusinessLifecycle,type BusinessTransitionView,type TransitionStoryView} from './BusinessLifecycle';
import {useEffect,useState} from 'react';
import {workflowBase,workflowRequest} from '@/lib/workflowRuns';
import {useT} from '@/lib/prefs';
import {Button} from '@/components/ui';
type Review={transitions?:BusinessTransitionView[];stories?:TransitionStoryView[];transitionFindings?:Array<{code:string;message:string}>;pending:boolean;revisionId?:string;candidates?:Array<{id:string;title:string;acceptance:string[];requirementDraft:{reason:string;questions:string[]}}>};
export function StoryRequirementsReview({projectId,runId,status,refresh}:{projectId:string;runId:string;status:string;refresh:()=>void}){
 const [data,setData]=useState<Review>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const base=`${workflowBase(projectId)}/${runId}/story-requirements`;
 useEffect(()=>{let live=true;setData(undefined);setError('');workflowRequest<Review>(base).then(x=>{if(live)setData(x);}).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[base,status]);
 async function approve(){setBusy(true);setError('');try{await workflowRequest(base+'/approve',{revisionId:data?.revisionId});setData({...data!,pending:false});refresh();}catch(e){setError(String(e));}finally{setBusy(false);}}
 return <div className="space-y-4">{data&&<BusinessLifecycle transitions={data.transitions} stories={data.stories} findings={data.transitionFindings}/>}<StoryRequirementsPanel data={data} error={error} busy={busy} status={status} approve={approve}/></div>;
}
export function StoryRequirementsPanel({data,error,busy,status,approve}:{data?:Review;error:string;busy:boolean;status:string;approve:()=>Promise<void>}){
 const t=useT();
 if(!data?.pending)return error?<p role="alert">{error}</p>:null;
 return <section className="rounded border border-border p-4 space-y-3"><h3 className="font-semibold">{t('stories.review.title')}</h3><p className="text-sm">{t('stories.review.hint')}</p>
 {data.candidates?.map(s=><details key={s.id} className="rounded border border-border p-3"><summary>{s.id} · {s.title}</summary><p className="my-2 text-sm">{s.requirementDraft.reason}</p><ul className="list-disc pl-5 text-sm">{s.acceptance.map((a,i)=><li key={i}>{a}</li>)}</ul><ul className="mt-2 list-disc pl-5 text-sm">{s.requirementDraft.questions.map((q,i)=><li key={i}>{q}</li>)}</ul></details>)}
 <Button disabled={busy||status==='running'||status==='queued'} onClick={()=>void approve()}>{t('stories.review.approve')}</Button><p className="text-xs text-muted-foreground">{t('stories.review.after')}</p>{error&&<p role="alert">{error}</p>}</section>;
}
