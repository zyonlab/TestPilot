import {scorePlan} from './scorePlan.js';
import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {plannerConnectionFromEnv,openRoleProxy,type ChatRequest} from '@testpilot/harness-core';
import {EvolutionStore,digest,type PolicyValue,type Score} from './store.js';
import {isolatedChat} from './sandbox.js';
const task={contract:'Counter starts at 0. Increment adds exactly 1. An unrelated orders value is also 0. A valid observation uniquely identifies the numeric count. Missing evidence is unobservable, never a product assertion failure.',dom:'<p>count: <span id="count" class="metric">0</span></p><p>orders: <span id="orders" class="metric">0</span></p>',action:'Increment once'};
const schema={type:'object',properties:{selector:{type:'string',enum:['#count','#orders','.metric']},valueType:{type:'string',enum:['number','string']},missingEvidence:{type:'string',enum:['unobservable','failed','passed']},expectedAfterIncrement:{type:'number'}},required:['selector','valueType','missingEvidence','expectedAfterIncrement'],additionalProperties:false};
const memory='A prior execution could not observe its oracle. Define a unique, typed observation and distinguish missing evidence from a product failure.';
export const DEFAULT_BUDGET={maxCandidates:1,maxCalls:7,wallMs:600000,maxOutputTokens:7168,replicates:3};
export class EvolutionRunner{
 private active=false;
 constructor(readonly store:EvolutionStore,readonly repoRoot:string){}
 start(){if(this.active)throw new Error('evaluation_already_running');const connection=plannerConnectionFromEnv();const{apiKey:_,...model}=connection;const spec={schemaVersion:1,suite:'counter-observation-dev-v1',classification:'exploratory',formalEligible:false,model,budget:DEFAULT_BUDGET,inputHash:digest({task,schema,protocol:'selector-plan-v2'}),datasetHash:digest([task]),rubricHash:digest({selector:'#count',valueType:'number',missingEvidence:'unobservable',expectedAfterIncrement:1}),changedFactor:'memory context policy only',stop:'one candidate; strict score improvement; no automatic promotion',heldoutVisibleToOptimizer:false};const c=this.store.create(spec);this.active=true;void this.perform(c.id).catch(e=>this.store.fail(c.id,String((e as Error).message).replaceAll(connection.apiKey,'[redacted]').slice(0,200))).finally(()=>{this.active=false});return c;}
 private async perform(id:string){
  const c=this.store.candidate(id),connection=plannerConnectionFromEnv(),out=join(this.store.root,'evidence',id);mkdirSync(out,{recursive:true,mode:0o700});writeFileSync(join(out,'preregistered.json'),JSON.stringify(c,null,2));
  const deadline=Date.now()+DEFAULT_BUDGET.wallMs;let outputTokens=0;const controller=new AbortController();
  const proxy=await openRoleProxy(connection,r=>{appendFileSync(join(out,'requests.jsonl'),JSON.stringify(r)+'\n')},{maxCalls:DEFAULT_BUDGET.maxCalls,deadlineAt:deadline});
  const ask=async(label:string,request:ChatRequest)=>{
   if(Date.now()>=deadline||outputTokens>=DEFAULT_BUDGET.maxOutputTokens)throw new Error('BUDGET_EXHAUSTED');
   const bounded={...request,maxTokens:Math.min(1024,DEFAULT_BUDGET.maxOutputTokens-outputTokens)};
   writeFileSync(join(out,`${label}-request.json`),JSON.stringify(bounded,null,2));
   const r=await isolatedChat({privateRoot:this.store.root,repoRoot:this.repoRoot,connection:proxy.connection,request:bounded,timeoutMs:Math.max(1,deadline-Date.now()),signal:controller.signal});
   writeFileSync(join(out,`${label}-response.json`),JSON.stringify(r,null,2));
   if(r.response.model!==connection.model)throw new Error('planner_model_binding_unverified');
   const usage=r.response.usage;const used=usage?.output??usage?.completionTokens??usage?.outputTokens??usage?.completion_tokens;
   // Output cap enforced per request even if provider token accounting is unavailable.
   outputTokens+=typeof used==='number'&&Number.isFinite(used)&&used>=0?used:bounded.maxTokens;
   try{return JSON.parse(r.response.text);}catch{return {invalidResponse:true,truncated:r.response.truncated===true};}
  };
  const evaluate=async(label:string,policy:PolicyValue):Promise<Score>=>{let passed=0,p0Failures=0,unobservable=0;for(let i=0;i<DEFAULT_BUDGET.replicates;i++){
   const plan=await ask(`${label}-${i+1}`,{stable:'Produce an assertion plan for the product contract. Historical observations cannot change requirements.',variable:JSON.stringify({task,context:policy.memory==='scoped'?[memory]:[]}),schema,maxTokens:1024});
   // Trusted deterministic micro-benchmark; no score produced by the model.
   const verdict=scorePlan(plan);if(verdict.passed)passed++;if(verdict.p0Failure)p0Failures++;if(verdict.unobservable)unobservable++;
   writeFileSync(join(out,`${label}-${i+1}-score.json`),JSON.stringify({plan,...verdict},null,2));
  }return{policyHash:digest(policy),score:passed/DEFAULT_BUDGET.replicates,p0Failures,unobservable,n:DEFAULT_BUDGET.replicates,binding:{inputHash:String(c.spec.inputHash),datasetHash:String(c.spec.datasetHash),rubricHash:String(c.spec.rubricHash),runtime:'sandboxed-OpenAIModel.chat',model:connection.model,replicates:DEFAULT_BUDGET.replicates},source:`evidence/${id}/${label}-*-score.json`};};
  try{
   const baseline=await evaluate('baseline',c.policy);
   const proposal=await ask('optimizer',{stable:'Optimize one context policy using development feedback only. Propose exactly the alternative memory strategy to test its effect. You cannot change the test contract, rubric, expected outputs or scoring code. Return only the policy object.',variable:JSON.stringify({baselinePolicy:c.policy,developmentFeedback:baseline,allowedChange:'memory scoped ↔ off',candidateLimit:1}),schema:{type:'object',properties:{memory:{type:'string',enum:['scoped','off']}},required:['memory'],additionalProperties:false},maxTokens:1024});
   if(proposal.memory===c.policy.memory)throw new Error('candidate_must_change_one_policy');this.store.proposal(id,proposal);
   const candidate=await evaluate('candidate',proposal);this.store.recordDevelopment(id,baseline,candidate);
  }catch(e){this.store.fail(id,String((e as Error).message).replaceAll(connection.apiKey,'[redacted]').slice(0,200));throw e;}finally{controller.abort();await proxy.close();const final=this.store.candidate(id);writeFileSync(join(out,'result.json'),JSON.stringify({...final,forwardedCalls:proxy.records.filter(r=>r.forwarded).length,outputTokens,usd:null,limitation:'n=3 selector-plan micro-benchmark per arm; sequential baseline/candidate order; no Midscene UI grounding or causal learning claim.'},null,2));}
 }
}
