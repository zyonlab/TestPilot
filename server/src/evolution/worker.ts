/** Deliberately no filesystem/shell tools. Parent owns data, scoring and budgets. */
import {readFileSync,writeFileSync} from 'node:fs';
import {OpenAIModel} from '@testpilot/harness-core';
process.on('disconnect',()=>process.exit(0));
process.once('message',async(raw:any)=>{try{
 const isolation=raw.probes.map((path:string)=>{try{readFileSync(path);return{path,denied:false}}catch(e){return{path,denied:['EPERM','EACCES'].includes((e as NodeJS.ErrnoException).code??'')}}});
 const writes=raw.probes.map((path:string)=>{try{writeFileSync(path,'forbidden candidate write');return{path,denied:false}}catch(e){return{path,denied:['EPERM','EACCES'].includes((e as NodeJS.ErrnoException).code??'')}}});
 if(isolation.some((p:any)=>!p.denied)||writes.some((p:any)=>!p.denied))throw new Error('isolation_probe_failed');
 const c=raw.connection;const model=new OpenAIModel({baseUrl:c.endpoint,apiKey:c.apiKey,model:c.model,noThink:c.thinking===false,providerThinkingDefault:c.thinking===null,timeoutMs:c.timeoutMs,retries:0,growOnTruncation:false});
 const response=await model.chat(raw.request);process.send?.({ok:true,response,isolation,writes});
 }catch(e){process.send?.({ok:false,error:String((e as Error).message).slice(0,200)});}finally{process.disconnect();}});
