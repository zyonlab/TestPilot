/** Exploration-only domain ablation. No gold or held-out labels are read by the planner. */
import { config } from 'dotenv';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ABLATABLE, OpenAIModel, type ChatRequest } from '@testpilot/harness-core';
import { plannerConnectionFromEnv, executorConnectionFromEnv, openRoleProxy } from '@testpilot/harness-core';
import { designCasesNode } from '../../packages/harness-testing/src/casegen/nodes.js';
import { domainReferenceBlock } from '../../packages/harness-testing/src/casegen/prompts.js';
import { canonicalJSON } from '@testpilot/harness-core/run-contracts';
if (!process.argv.includes('--real')) throw new Error('--real is required');
const root = resolve(import.meta.dirname,'../..');
// 领域参考是评测数据集，不是代码常量（2026-09-15）：两臂读同一份冻结文件，off 臂由 domain-reference 开关去掉。
const DOMAIN_TEXT = readFileSync(join(root,'benchmark/hyperliquid-testnet/domain-reference.md'),'utf8');
const DOMAIN = domainReferenceBlock(DOMAIN_TEXT); config({path:join(root,'server/.env'),quiet:true} as any);
const out = resolve(process.env.TP_EVIDENCE_DIR ?? join(root,`docs/v3/evidence/n-16/domain-lab-${Date.now()}`)); mkdirSync(out,{recursive:true});
const hash=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:canonicalJSON(v)).digest('hex');
const material=readFileSync(join(root,'benchmark/local-perp/statement/materials.md'),'utf8');
const upstream={origin:'benchmark/local-perp/statement/materials.md',derivedFrom:'document',specText:material,stories:[{id:'S-size',title:'Submit BTC market orders using the documented quantity normalization',role:'local trader',benefit:'avoid an unintended position size',acceptance:['Given a reset account, when a market order is submitted, then the normalized BTC quantity follows the size contract.','Given a reset account, when the normalized quantity is below the minimum, then the order is rejected and no position is created.','Include a fractional-step probe using input 0.0016 BTC, an aligned input, and a below-minimum input.']} ]};
const planner=plannerConnectionFromEnv(), executor=executorConnectionFromEnv(), publicRole=({apiKey:_,...rest}:typeof planner)=>rest;
const canary='TP_DOMAIN_CONTEXT_V1_3C19A2', repetitions=process.argv.includes('--smoke')?1:3;
const spec={schemaVersion:1,id:`domain-lab-${Date.now()}`,classification:'exploratory',formalEligible:false,reason:'local-perp gold requires actual human review/freeze',datasetHash:hash(material),inputHash:hash(upstream),repetitions,runtime:'pipeline:designCasesNode',mechanism:'fixed upstream story; optional domain reference on/off',changedFactors:['domain reference bytes including load canary'],planner:publicRole(planner),executor:publicRole(executor),budget:{maxForwardedCalls:repetitions*8,wallMs:1800000,perResponseTokens:16000},prediction:'No directional effect assumed: the product statement already contains the quantity rule.',executionPlan:'Evaluate every generated size case on healthy and round-size fixture; unsupported action interpretation remains unobservable. No formal gold score or significance claim.'};
writeFileSync(join(out,'preregistered.json'),JSON.stringify(spec,null,2));writeFileSync(join(out,'frozen-upstream.json'),JSON.stringify(upstream,null,2));
const results:any[]=[];const proxy=await openRoleProxy(planner,r=>appendFileSync(join(out,'model-requests.jsonl'),JSON.stringify(r)+'\n'),{maxCalls:spec.budget.maxForwardedCalls,deadlineAt:Date.now()+spec.budget.wallMs});
const model=new OpenAIModel({baseUrl:proxy.connection.endpoint,apiKey:proxy.connection.apiKey,model:planner.model,noThink:planner.thinking===false,providerThinkingDefault:planner.thinking===null,timeoutMs:planner.timeoutMs,retries:0});
try {
 for(let repetition=0;repetition<repetitions;repetition++) for(const arm of repetition%2?['on','off']:['off','on']) {
  const started=Date.now(), runId=`${spec.id}-${arm}-${repetition+1}`, calls:any[]=[], events:any[]=[];
  const recorder={chat:async(req:ChatRequest)=>{
   const hasDomain=req.stable.endsWith(DOMAIN);if(hasDomain!==(arm==='on'))throw new Error('ablation_not_applied');
   const common='\nContext audit: return contextCanary equal to the CONTEXT_CANARY in the optional domain reference; use "absent" when no reference is present.\n';
   const stable=req.stable.slice(0,hasDomain?-DOMAIN.length:undefined)+common+(hasDomain?DOMAIN+`\nCONTEXT_CANARY: ${canary}\n`:'');
   const schema={...req.schema,properties:{...(req.schema as any).properties,contextCanary:{type:'string'}},required:[...((req.schema as any).required??[]),'contextCanary']};
   const request={...req,stable,schema};const index=calls.length;
   writeFileSync(join(out,`${runId}-request-${index}.json`),JSON.stringify(request,null,2));
   const response=await model.chat(request);writeFileSync(join(out,`${runId}-response-${index}.json`),JSON.stringify(response,null,2));
   let observed:string|null=null;try{observed=JSON.parse(response.text).contextCanary??null;}catch{}
   calls.push({stableHash:hash(stable),variableHash:hash(req.variable),schemaHash:hash(schema),loadedDigest:hash(stable),domainPresent:hasDomain,canaryExpected:hasDomain?canary:'absent',canaryObserved:observed,canaryPassed:observed===(hasDomain?canary:'absent'),model:response.model??null,usage:response.usage??null,ms:response.ms});
   return response;
  }};
  let bundle:unknown,error:string|undefined;
  try{ const node=designCasesNode({model:recorder});const params=node.params.parse({lang:'en',contextTokens:8000,perStoryMaxTokens:16000,maxCasesPerStory:4,oracleGuidance:'strict',domainReference:DOMAIN_TEXT});bundle=await node.run(upstream as never,params,{nodeId:'design',ablated:new Set(arm==='off'?[ABLATABLE.domainReference]:[]),spend:()=>{},emit:(type:string,data:unknown)=>events.push({type,data}),signal:AbortSignal.timeout(spec.budget.wallMs)} as never); }
  catch(e){error=String((e as Error).message).replaceAll(planner.apiKey,'[redacted]').slice(0,1500);}
  const result={runId,arm,repetition:repetition+1,startedAt:new Date(started).toISOString(),wallMs:Date.now()-started,inputHash:hash(upstream),datasetHash:hash(material),calls,bundle,error,events,validBinding:calls.length>0&&calls.every(c=>c.canaryPassed)};
  writeFileSync(join(out,`${runId}.json`),JSON.stringify(result,null,2));results.push(result);
  console.log(JSON.stringify({runId,arm,cases:(bundle as any)?.cases?.length??0,error,validBinding:result.validBinding}));
 }
} finally { await proxy.close(); writeFileSync(join(out,'results.json'),JSON.stringify({spec,results,modelRequests:proxy.records},null,2)); }
console.log(JSON.stringify({evidence:out,runs:results.length,allBindingsValid:results.every(r=>r.validBinding),formalEligible:false}));
