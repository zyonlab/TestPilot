import {useEffect,useState} from 'react';
import {workflowBase,workflowRequest} from '@/lib/workflowRuns';
import {BusinessLifecycle,type BusinessTransitionView} from './BusinessLifecycle';
/** Read the immutable run-bound inputs, including before stories exist. */
export function BusinessLifecycleInputs({projectId,runId,status}:{projectId:string;runId:string;status:string}){
 const [transitions,setTransitions]=useState<BusinessTransitionView[]>(),[error,setError]=useState('');
 useEffect(()=>{let live=true;setTransitions(undefined);setError('');workflowRequest<{transitions?:BusinessTransitionView[]}>(`${workflowBase(projectId)}/${runId}/story-requirements`).then(data=>{if(live)setTransitions(data.transitions??[]);}).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[projectId,runId,status]);
 if(error)return <p role="alert">{error}</p>;
 return transitions?<BusinessLifecycle transitions={transitions}/>:null;
}
