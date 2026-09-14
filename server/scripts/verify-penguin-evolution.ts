import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,copyFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import{join,resolve}from'node:path';import{spawn}from'node:child_process';import{randomBytes}from'node:crypto';import{createServer}from'node:net';
import puppeteer from 'puppeteer';
import{node24Path,penguinBin}from'../src/penguin.js';
if(!process.argv.includes('--real'))throw new Error('--real required');
const repo=resolve(import.meta.dirname,'../..'),workspace=mkdtempSync(join(tmpdir(),'tp-penguin-evaluation-')),root=join(workspace,'penguin'),evaluation=join(workspace,'evaluation');mkdirSync(root,{recursive:true});
const out=resolve(process.env.TP_EVIDENCE_DIR??join(repo,`docs/v3/evidence/n-21/real-${Date.now()}`));mkdirSync(out,{recursive:true});
const free=async()=>{const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as any).port;await new Promise<void>(r=>s.close(()=>r()));return p;};const nativePort=await free(),evaluationPort=await free(),token=randomBytes(24).toString('hex');
writeFileSync(join(root,'extensions.json'),JSON.stringify({extensions:[join(repo,'extensions/penguin-evaluation/index.mjs')]},null,2));
const child=spawn(node24Path(),[penguinBin(),'server','--host','127.0.0.1','--port',String(nativePort)],{cwd:repo,env:{...process.env,PENGUIN_HOME:root,TP_EVOLUTION_DIR:evaluation,TP_EVOLUTION_PORT:String(evaluationPort),TP_EVOLUTION_REVIEW_TOKEN:token},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
const url=`http://127.0.0.1:${evaluationPort}`,nativeUrl=`http://127.0.0.1:${nativePort}`;let browser:any,recording:any,candidateId:string|undefined,result:any;
try{
 let ready=false;for(let i=0;i<300;i++){if(child.exitCode!==null)throw new Error(`penguin_exit_${child.exitCode}`);try{if((await fetch(url+'/health')).ok&&(await fetch(nativeUrl)).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,200));}if(!ready)throw new Error('extension_start_timeout');
 if(process.argv.includes('--startup-only')){const health=await(await fetch(url+'/health')).json();writeFileSync(join(out,'startup.json'),JSON.stringify({passed:true,health,nativeUrl,privateWorkspace:workspace},null,2));console.log(JSON.stringify({startupPassed:true,evidence:out}));}
 else {browser=await puppeteer.launch({headless:true});const native=await browser.newPage();await native.setViewport({width:1280,height:900});await native.goto(nativeUrl);await native.screenshot({path:join(out,'penguin-native.png'),fullPage:true});
 const page=await browser.newPage();await page.setViewport({width:1280,height:960});await page.goto(url);recording=await page.screencast({path:join(out,'evaluation.webm'),ffmpegPath:process.env.FFMPEG_PATH??'ffmpeg'});await page.screenshot({path:join(out,'companion-before.png'),fullPage:true});
 const unauthorized=await fetch(url+'/api/experiments',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(unauthorized.status!==401)throw new Error('review_session_required');
 await page.type('#token',token);await page.click('#auth button');await page.waitForFunction(()=>document.querySelector('#auth-status')!.textContent!.includes('已登录'));await page.click('#start');
 const deadline=Date.now()+660000;while(Date.now()<deadline){const state=await(await fetch(url+'/api/state')).json() as any;const candidate=state.candidates[0];candidateId=candidate?.id;if(candidate&&candidate.status!=='evaluating'){result=state;break}await new Promise(r=>setTimeout(r,1000));}
 if(!result)throw new Error('experiment_timeout');await page.click('#refresh');await page.screenshot({path:join(out,'companion-result.png'),fullPage:true});
 await page.setViewport({width:390,height:844});await page.screenshot({path:join(out,'companion-mobile.png'),fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(overflow)throw new Error('mobile_overflow');
 const c=result.candidates[0];const copied=join(out,'candidate');mkdirSync(copied,{recursive:true});const original=join(evaluation,'evidence',c.id);for(const file of readdirSync(original))if(/\.jsonl?$/.test(file))copyFileSync(join(original,file),join(copied,file));
 writeFileSync(join(out,'result.json'),JSON.stringify({passed:!!c.baseline&&!!c.candidate,classification:'actual Penguin extension + actual browser controls + actual qwen model; synthetic review login only',humanPromotion:false,penguin:{version:'0.2.9',commit:'f8e795f0458943524424908a8365807b8b9c5474',nativeUrl},uiBoundary:'separate Penguin companion delivered through extension; native UI has no page-mount hook',privateWorkspace:workspace,unauthorizedStatus:unauthorized.status,overflow,state:result},null,2));
 console.log(JSON.stringify({evidence:out,status:c.status,reason:c.reason,error:c.error,baseline:c.baseline?.score,candidate:c.candidate?.score}));
}
} catch(e){writeFileSync(join(out,'failure.json'),JSON.stringify({error:String(e),privateWorkspace:workspace,candidateId},null,2));writeFileSync(join(workspace,'private-native.log'),logs);console.log(JSON.stringify({error:String(e),evidence:out,privateLog:join(workspace,'private-native.log')}));process.exitCode=1;}
finally{await recording?.stop();await browser?.close();child.kill('SIGTERM');await new Promise(r=>setTimeout(r,800));if(child.exitCode===null)child.kill('SIGKILL');}
