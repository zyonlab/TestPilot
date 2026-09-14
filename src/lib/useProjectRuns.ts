import { useCallback, useEffect, useState } from 'react';
import { workflowBase, workflowRequest, WorkflowError, type WorkflowRun } from './workflowRuns';
/** A project-scoped query. Late responses are discarded when its owner changes. */
export function useProjectRuns(projectId: string) {
  const [result, setResult] = useState<{projectId:string;runs:WorkflowRun[];loaded:boolean;error:string}>({projectId,runs:[],loaded:false,error:''});
  const [version,setVersion]=useState(0);
  const refresh=useCallback(()=>setVersion(v=>v+1),[]);
  useEffect(()=>{
    const c=new AbortController();let timer:ReturnType<typeof setTimeout>;
    setResult(previous=>previous.projectId === projectId ? previous : {projectId,runs:[],loaded:false,error:''});
    const poll=async()=>{try{
      const data=await workflowRequest<{runs:WorkflowRun[]}>(workflowBase(projectId),undefined,'GET',c.signal);
      if(!c.signal.aborted)setResult({projectId,runs:data.runs,loaded:true,error:''});
    }catch(e){if(!c.signal.aborted)setResult(previous=>({projectId,runs:previous.projectId===projectId?previous.runs:[],loaded:true,error:e instanceof WorkflowError?e.code:'request_failed'}));}
    if(!c.signal.aborted)timer=setTimeout(()=>void poll(),3000);};
    if(projectId)void poll();return()=>{c.abort();clearTimeout(timer);};
  },[projectId,version]);
  return {...(result.projectId===projectId?result:{projectId,runs:[],loaded:false,error:''}),refresh};
}
