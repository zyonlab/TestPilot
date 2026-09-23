import {config} from 'dotenv';
import {resolve} from 'node:path';
config({path:resolve(import.meta.dirname,'../.env'),quiet:true} as any);
const {startStudy,readStudy}=await import('../src/evidenceStudy/runner.js');
const job=startStudy();console.log(JSON.stringify(job));
const timer=setInterval(()=>{const current=readStudy(job.id);console.log(JSON.stringify({id:current.id,status:current.status,stage:current.stage,completedTrials:current.completedTrials,error:current.error,summary:current.summary}));if(current.status!=='running'){clearInterval(timer);process.exitCode=current.status==='done'?0:1;}},15000);
