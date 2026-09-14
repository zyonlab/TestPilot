import {randomUUID} from 'node:crypto';
/** Installed Penguin 0.2.9 extension contract: workflow + separately identified companion UI. */
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export async function activate(ctx){
 const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
 const instance=randomUUID();
 const port=Number(process.env.TP_EVOLUTION_PORT??7365);
 const child=spawn(process.env.TP_EVOLUTION_NODE_BIN??process.execPath,['--import','tsx',resolve(repo,'server/src/evolution/main.ts')],{cwd:resolve(repo,'server'),env:{...process.env,TP_EVOLUTION_PORT:String(port),TP_EVOLUTION_INSTANCE:instance},stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.on('data',b=>{stderr=(stderr+b).slice(-1000)});
 let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(`evaluation_companion_exit_${child.exitCode}`);try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok&&(await r.json()).instance===instance){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100));}
 if(!ready){child.kill();throw new Error('evaluation_companion_start_timeout')}
 ctx.disposables.push({dispose(){child.kill('SIGTERM')}});
 ctx.on('initialize',iface=>iface.workflow.set('testpilot-evaluation',()=>({run:()=>({uiUrl:`http://127.0.0.1:${port}`,boundary:'Penguin evaluation companion; native 0.2.9 has no UI mounting hook. Open the UI to create and review a bounded experiment.'})})));
}
