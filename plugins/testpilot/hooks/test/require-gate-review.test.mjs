import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function check(t, phase, finalized=false) {
 const dir=mkdtempSync(join(tmpdir(),'tp-stop-review-'));
 const grant=join(dir,'grant.json');
 writeFileSync(grant,JSON.stringify({runId:'run-test',projectId:'project-test',token:'test-only'}));
 const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.endsWith('/status')?{finalized}:{runId:'run-test',stages:[{node:'modules',phase}]}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.close();rmSync(dir,{recursive:true,force:true});});
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../require-gate.mjs',import.meta.url))],{env:{...process.env,TP_RUN_GRANT_FILE:grant,TP_SERVER_URL:`http://127.0.0.1:${server.address().port}`},stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));child.stdin.end(JSON.stringify({hook:'stop',session_id:'review-test'}));
 });
 return {result,nudged:existsSync(grant+'.stop-state')};
}
test('module approval wait stops without claiming finalization or consuming nudges',async t=>{
 const {result,nudged}=await check(t,'waiting_review');assert.equal(result.decision,'stop');assert.equal(result.output.complete,false);assert.equal(result.output.needsHuman,true);assert.equal(nudged,false);
});
test('unfinished work outside a human gate still requires continuation',async t=>{
 const {result,nudged}=await check(t,'done');assert.equal(result.decision,'continue');assert.equal(result.output.complete,false);assert.equal(nudged,true);
});
test('server-finalized work is complete without a reminder',async t=>{
 const {result,nudged}=await check(t,'done',true);assert.equal(result.decision,'stop');assert.equal(result.output.complete,true);assert.equal(nudged,false);
});
