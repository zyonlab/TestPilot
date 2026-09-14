/** Actual g1 oracle + actual Midscene UI, on healthy and known-defect local SUT. No gold labels. */
import{config}from'dotenv';import{readFileSync,writeFileSync,mkdirSync,mkdtempSync}from'node:fs';import{join,resolve}from'node:path';import{tmpdir}from'node:os';import{once}from'node:events';import{createHash}from'node:crypto';
import{executeRun}from'@testpilot/harness-testing/exec';import{executorConnectionFromEnv}from'@testpilot/harness-core';
// JS fixture is intentionally independent from the oracle implementation.
const root=resolve(import.meta.dirname,'../..');config({path:join(root,'server/.env'),quiet:true}as any);
if(!process.argv.includes('--real'))throw new Error('--real required');
const source=JSON.parse(readFileSync(join(root,'docs/v3/evidence/n-16/smoke/results.json'),'utf8'));const generated=source.results[0];
const kase=generated.bundle.cases.find((c:any)=>c.steps.some((s:string)=>/^Enter 0\.0016 in the Size field$/.test(s)));if(!kase||kase.oracle?.kind!=='api')throw new Error('predeclared_generated_probe_missing');
const out=resolve(process.env.TP_EVIDENCE_DIR??join(root,'docs/v3/evidence/n-15/real-g1-oracle'));mkdirSync(out,{recursive:true});
const {createPerpLab}=await import('../../fixtures/perp-lab/server.mjs' as string);const artifacts=mkdtempSync(join(tmpdir(),'tp-domain-exec-'));const results=[];
for(const defect of [null,'round-size']){
 const server=createPerpLab({defect});server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
 const setup=kase.steps.filter((s:string)=>/^(POST|GET) |^Open the order panel/.test(s));
 for(const step of setup)if(!['POST ${env.LAB_URL}/api/reset','GET ${env.LAB_URL}/api/clearinghouse','Open the order panel at ${env.LAB_URL}'].includes(step))throw new Error('unsupported_fixture_setup');
 const uiSteps=kase.steps.filter((s:string)=>!setup.includes(s));
 try{
  await fetch(url+'/api/reset',{method:'POST'});
  const run=await executeRun(url,uiSteps,kase.expected,{headless:true,executorModel:executorConnectionFromEnv(),oracle:kase.oracle,resolve:{env:{LAB_URL:url},secrets:{}},postSteps:[],cacheId:`n15-${defect??'healthy'}-${Date.now()}`,modelBudget:{maxCalls:30,deadlineAt:Date.now()+180000},onLog:()=>{}});
  const observed=await(await fetch(url+'/api/clearinghouse')).json();
  // Save browser evidence without exposing model credentials or raw endpoint request bodies.
  for(let i=0;i<run.pngBuffers.length;i++)writeFileSync(join(out,`${defect??'healthy'}-${i}.png`),run.pngBuffers[i]);
  const {pngBuffers:_,screenshots:__,...publicRun}=run;results.push({defect,result:publicRun,observed});
 }finally{await fetch(url+'/api/reset',{method:'POST'});server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
const passed=results[0]?.result.status==='passed'&&results[1]?.result.status==='failed';
writeFileSync(join(out,'result.json'),JSON.stringify({passed,sourceRunId:generated.runId,sourceCaseHash:createHash('sha256').update(JSON.stringify(kase)).digest('hex'),case:kase,oracleUnchanged:true,adapter:'Reset and API observation steps are handled by the controlled fixture harness; panel navigation by launch; UI steps use Midscene unchanged.',humanReviewEvidence:false,formalGoldEvidence:false,results},null,2));
console.log(JSON.stringify({passed,evidence:out,results:results.map(r=>({defect:r.defect,status:r.result.status}))}));process.exit(passed?0:1);
