/** Backfill factual host summaries and original execution request receipts; no re-estimated prices. */
import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{resolve,join,dirname}from'node:path';
const root=resolve(import.meta.dirname,'../..');const sourcePath=resolve(process.argv[2]),hostPath=join(dirname(sourcePath),'host.json');const source=JSON.parse(readFileSync(sourcePath,'utf8')),host=JSON.parse(readFileSync(hostPath,'utf8'));process.env.TP_DATA_DIR=join(source.privateWorkspace,'data');
const spend=await import('../src/roleSpend.js');
if(host.runtime==='codex')for(const [i,u]of host.usage.entries())spend.recordHostSummary(source.runId,'codex',`${host.sessionId}:historical-turn-${i+1}`,u,null);
if(host.runtime==='claude-code')for(const [i,r]of host.result.entries())spend.recordHostSummary(source.runId,'claude-code',`${host.sessionId}:historical-result-${i+1}`,r.usage,host.model??null,r.total_cost_usd);
const projectId=source.run.revisions[0].projectId;const report=spend.runRoleSpend(source.runId,projectId);const out=join(root,'docs/v3/evidence/n-17');mkdirSync(out,{recursive:true});writeFileSync(join(out,`${source.runtime}.json`),JSON.stringify({source:sourcePath.slice(root.length+1),hostSource:hostPath.slice(root.length+1),importedAt:new Date().toISOString(),...report},null,2));console.log(JSON.stringify({runId:source.runId,roles:report.roles}));
(await import('../src/runService.js')).runLedger().close();(await import('../src/db.js')).db.close();
