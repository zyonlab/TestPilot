import {nodeStatusKey} from './nodeStatus';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/prefs';
import { workflowBase, workflowRequest } from '@/lib/workflowRuns';
export type Progress = {status:string;error?:string;node?:{phase:string;message?:string};progress:null|{summary:{total:number;done:number;claimed:number;pending:number;failed:number;verified?:number;historicalVerified?:number};units:{unitId:string;status:string;attempt:number;reason?:string;claimedAt?:string}[]};events:{id:string;at:string;phase:string;message?:string;artifactName?:string}[]};
export function useNodeProgress(projectId:string,runId:string,node:string) {
 const t=useT(),[data,setData]=useState<Progress|null>(null),[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;setData(null);setError('');
  const read=async()=>{try{const next=await workflowRequest<Progress>(`${workflowBase(projectId)}/${runId}/progress?node=${encodeURIComponent(node)}`,undefined,'GET',controller.signal);if(!controller.signal.aborted){setData(next);setError('');}}catch{if(!controller.signal.aborted)setError(t('workflow.artifactFailed'));}finally{if(!controller.signal.aborted)timer=setTimeout(()=>void read(),3000);}};
  void read();return()=>{controller.abort();clearTimeout(timer);};
 },[projectId,runId,node,t]);
 return {data,error};
}
export function NodeProgress({data,error,node,compact=false}:{data:Progress|null;error:string;node:string;compact?:boolean}) {
 const t=useT(),logs=useRef<HTMLOListElement>(null),follow=useRef(true);
 const lastEvent=data?.events[data.events.length-1]?.id;
 useEffect(()=>{follow.current=true;},[node]);
 useEffect(()=>{if(follow.current&&logs.current)logs.current.scrollTop=logs.current.scrollHeight;},[lastEvent,node]);
 const counts=data?.progress?.summary,active=data&&['running','registered','queued'].includes(data.status);
 return <section className="space-y-3 border-t border-border pt-4">{!compact&&<h3 className="font-medium">{t('bench.nodeProgress')}</h3>}
  {error&&<p role="alert" className="text-sm text-bad">{error}</p>}
  {!data&&!error&&<p role="status">{t('workflow.loading')}</p>}
  {data?.error&&!active&&data.node?.phase!=='done'&&<p role="status" className="text-sm text-bad">{data.error}</p>}
  {counts&&counts.total>0?<>{!compact&&<><p className="text-sm">{t('bench.unitCount',{done:counts.done,total:counts.total})}</p><progress aria-label={t('bench.nodeProgress')} value={counts.done} max={counts.total} className="h-2 w-full accent-primary"/></>}<p className="text-xs text-muted-foreground">{counts.verified!==undefined?`${t('bench.unit.verified')} ${counts.verified} · `:''}{counts.historicalVerified!==undefined?`${t('bench.historicalVerified')} ${counts.historicalVerified} · `:''}{t('bench.unitPending',{pending:counts.pending,claimed:counts.claimed,failed:counts.failed})}{!active&&counts.claimed>0?` · ${t('bench.claimStopped')}`:''}</p><details><summary className="cursor-pointer text-sm">{t('bench.unitDetails')}</summary><ul className="mt-3 max-h-72 space-y-2 overflow-auto text-xs">{data?.progress?.units.map(u=><li key={u.unitId} className="border-b border-border pb-2"><span className="break-all">{u.unitId}</span> · {u.status==='claimed'&&!active?t('bench.claimStopped'):t(`bench.unit.${u.status}`)} · {t('bench.unitAttempt',{n:u.attempt})}{u.reason&&<p className="mt-1 text-bad">{u.reason}</p>}</li>)}</ul></details></>:data&&<p className="text-sm text-muted-foreground">{t('bench.noUnitProgress')}</p>}
  <details open><summary className="cursor-pointer text-sm">{t('bench.nodeEvents')}</summary><ol ref={logs} onScroll={()=>{const el=logs.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<40;}} className="mt-3 max-h-64 space-y-2 overflow-auto text-xs">{data?.events.map(e=><li key={e.id} className="border-b border-border pb-2"><time>{new Date(e.at).toLocaleString()}</time> · {e.artifactName?t('bench.savedUnit'):t(nodeStatusKey(e.phase))}{e.artifactName&&<p className="mt-1 break-words">{e.artifactName.replace(`units/${node}/`,'')}</p>}{e.message&&<p className="mt-1 whitespace-pre-wrap break-words">{e.message}</p>}</li>)}</ol>{data&&!active&&data.node&&<p className="mt-2 text-xs">{t('bench.currentState')} · {t(nodeStatusKey(data.node.phase))}{data.node.message?` · ${data.node.message}`:''}</p>}</details>
 </section>;
}
