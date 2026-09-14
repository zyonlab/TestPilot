/** Continue immutable native-generated fixture runs. Review automation is synthetic, never human gold. */
import { config } from 'dotenv';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
if (!process.argv.includes('--real')) throw new Error('--real is required');
const root = resolve(import.meta.dirname, '../..'), sourcePath = resolve(process.argv[process.argv.indexOf('--source') + 1]);
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
config({ path: join(root, 'server/.env'), quiet: true } as any);
process.env.TP_DATA_DIR = join(source.privateWorkspace, 'data'); process.env.TP_PROCESSES = '1';
const db = await import('../src/db.js'), service = await import('../src/runService.js');
const procs = await import('../src/procs.js'), execution = await import('../src/workflowExecution.js');
const runId = source.runId, projectId = source.run.revisions[0].projectId;
const out = resolve(process.env.TP_EVIDENCE_DIR ?? join(root, `docs/v3/evidence/n-13/${source.runtime}`)); mkdirSync(out, { recursive: true });
const app = express(); app.use(express.json({ limit: '16mb' }));
app.get('/', (_req,res) => res.type('html').send('<!doctype html><html><title>Counter</title><body style="font:28px system-ui;padding:72px"><h1>Counter</h1><p>count: <span data-testid="count">0</span></p><button style="font:24px system-ui;padding:20px" onclick="document.querySelector(\'[data-testid=count]\').textContent=++window.count">Increment</button> <button style="font:24px system-ui;padding:20px" onclick="window.count=0;document.querySelector(\'[data-testid=count]\').textContent=0">Reset</button><script>window.count=0</script></body></html>'));
app.use('/api/projects/:projectId/workflow-runs', (await import('../src/runRoutes.js')).runRouter());
const http = app.listen(0,'127.0.0.1'); await once(http,'listening');
const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`, api = `${url}/api/projects/${projectId}/workflow-runs/${runId}`;
db.updateProject(projectId, { targetUrl: url });
let passed = false, failure: string | undefined, badInputStatus: number | undefined;
const request = async (path: string, body?: unknown) => {
 const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
 if (!r.ok) throw new Error(`http_${r.status}:${await r.text()}`); return r;
};
try {
 const invalid = await fetch(api + '/review', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-agent' }, body: JSON.stringify({ __actor: 'human', items: [] }) }); badInputStatus = invalid.status;
 if (badInputStatus !== 403) throw new Error('agent_review_not_rejected');
 const review = await (await request(api + '/review')).json() as any;
 await request(api + '/review', { items: review.cases.map((c:any) => ({ caseId: c.caseId, revisionId: c.revision.id, decision: 'approved' })), note: 'SYNTHETIC AUTOMATED INTEGRATION REVIEW; not user review or human gold' });
 const code = await (await request(api + '/stages/g2', {})).json() as any; if (code.status !== 'ready_to_execute') throw new Error('code_gate_blocked');
 await procs.startProcesses(() => {});
 const started = await (await request(api + '/stages/execute', { codeRevision: code.revision.id, idempotencyKey: 'native-original-cases-labelled-fixture-v3' })).json() as any;
 const deadline = Date.now() + 600_000; let row:any;
 while (Date.now() < deadline) { row = execution.listWorkflowExecutions(runId,projectId).find((r:any) => r.id === started.executionId); if (row?.status !== 'running') break; await new Promise(r => setTimeout(r,300)); }
 passed = row?.status === 'passed'; if (!passed) failure = row?.status ?? 'execution_timeout';
} catch (e) { failure = (e as Error).message.slice(0,400); }
finally {
 if (!passed) await execution.cancelWorkflowExecutions(runId,projectId);
 await procs.supervisor.stopAll(); http.closeAllConnections(); await new Promise<void>(r => http.close(() => r()));
 const run = service.runLedger().getRun(runId,projectId);
 writeFileSync(join(out,'result.json'), JSON.stringify({ passed,failure,badInputStatus,runtime:source.runtime,originalGeneration:sourcePath.slice(root.length+1),runId, humanReviewEvidence:false, reviewMechanism:'actual HTTP local operator action without login; automated fixture', run, executions:execution.listWorkflowExecutions(runId,projectId),artifacts:run.revisions.map(r=>service.runLedger().readRevision(r.id,projectId)) },null,2));
 service.runLedger().close(); db.db.close();
}
console.log(JSON.stringify({runtime:source.runtime,passed,failure,badInputStatus,evidence:out})); process.exit(passed ? 0 : 1);
