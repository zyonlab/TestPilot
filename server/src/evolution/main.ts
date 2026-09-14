import {createGates} from './releaseGates.js';
import {config} from 'dotenv';
import {existsSync,readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {EvolutionStore} from './store.js';
import {EvolutionRunner} from './runner.js';
import {evaluationApp,type TrustedGates} from './http.js';
import {evolutionRoot} from './bridge.js';
const repo=resolve(import.meta.dirname,'../../..');config({path:join(repo,'server/.env'),quiet:true} as any);
const root=evolutionRoot();mkdirSync(root,{recursive:true,mode:0o700});const tokenFile=join(root,'review-token');
if(!process.env.TP_EVOLUTION_REVIEW_TOKEN&&!existsSync(tokenFile))writeFileSync(tokenFile,randomBytes(32).toString('hex'),{mode:0o600});if(existsSync(tokenFile))chmodSync(tokenFile,0o600);
const token=process.env.TP_EVOLUTION_REVIEW_TOKEN??readFileSync(tokenFile,'utf8').trim();
const store=new EvolutionStore(root);store.recover();const runner=new EvolutionRunner(store,repo);
// An operator may provide a reviewed evaluator module. No route can install one.
const gates:TrustedGates=process.env.TP_EVOLUTION_GATE_MODULE?(await import(pathToFileURL(resolve(process.env.TP_EVOLUTION_GATE_MODULE)).href)).createGates({store,repoRoot:repo}):createGates({store,repoRoot:repo});
const port=Number(process.env.TP_EVOLUTION_PORT??7365);const server=evaluationApp(store,runner,token,repo,gates).listen(port,'127.0.0.1',()=>console.log(JSON.stringify({service:'testpilot-penguin-evaluation',url:`http://127.0.0.1:${port}`,reviewTokenFile:tokenFile,boundary:'Penguin companion extension'})));
let closing=false;const close=()=>{if(closing)return;closing=true;server.closeAllConnections();server.close(()=>{store.close();process.exit(0)});};process.on('SIGINT',close);process.on('SIGTERM',close);
