import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let dir: string, database: typeof import('../src/db.js'), policy: typeof import('../src/intentPolicy.js'), service: typeof import('../src/runService.js');
let caseId: string, projectId: string;
beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), 'tp-intent-')); vi.stubEnv('TP_DATA_DIR', dir);
  database = await import('../src/db.js'); policy = await import('../src/intentPolicy.js'); service = await import('../src/runService.js');
  projectId = database.createProject('Intent', 'http://localhost').id;
  caseId = database.createCase({ projectId, title: 'Exact balance', steps: [{ text: 'Click submit' }], expected: 'Balance is 10', oracle: { kind: 'count', selector: '.balance', op: 'eq', value: 10 } as never }).id;
});
afterAll(() => { database.db.close(); service.runLedger().close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
it('never derives human identity from __actor and freezes all assertion changes, even eq numeric replacement', () => {
  const p = policy.requestPrincipal({ headers: { authorization: 'Bearer fixture-run-token' } }); expect(p.kind).toBe('agent');
  const before = database.getCase(caseId)!;
  for (const patch of [{ expected: 'Something is present' }, { oracle: { ...before.oracle, value: 999 } }, { oracle: { ...before.oracle, op: 'exists' } }, { oracle: null }, { projectId: 'changed' }]) {
    expect(() => policy.assertCaseMutation(caseId, { ...patch, __actor: 'human' }, 'PATCH', p)).toThrow('test_intent_frozen');
  }
  expect(() => policy.assertCaseMutation(caseId, {}, 'DELETE', p)).toThrow('human_review_required');
  expect(() => policy.assertCaseMutation(caseId, { steps: [{ text: 'Click the Submit button' }] }, 'PATCH', p)).not.toThrow();
  expect(policy.requestPrincipal({ headers: {} }).kind).toBe('human');
});
it('routes versioned human edits to a new review revision and detects direct projection tampering', async () => {
  vi.stubEnv('MIDSCENE_MODEL_NAME', 'fixture'); vi.stubEnv('MIDSCENE_MODEL_BASE_URL', 'https://fixture.test/v1'); vi.stubEnv('MIDSCENE_MODEL_API_KEY', 'fixture-key');
  const runId = service.registerHostRun(projectId, { runtime: 'codex', externalId: 'intent', idempotencyKey: 'intent', materials: [{ name: 'counter.md', text: 'Counter increments from 0 to 1.' }] }).runId;
  const stages = await import('../src/runStages.js'), approvals = await import('../src/approvedRuns.js'), delivery = await import('../src/decisionDelivery.js');
  stages.loadRunInstructions(runId, projectId); const ref = stages.retrieveRunSpec(runId, projectId, { query: 'Counter', budgetTokens: 2000 }).chunks[0].id;
  const stories = [{ id: 's1', title: 'Counter', acceptance: [] }]; stages.writeRunStage(runId, projectId, 'stories', { stories });
  stages.writeRunStage(runId, projectId, 'cases', { stories, cases: [{ id: 'c1', storyId: 's1', title: 'Increment', designMethod: 'boundary', tier: 3, key: 'zero-one', sourceRefs: [ref], steps: ['Click Increment'], expected: 'Counter is 1', assertions: [{id:'a1',statement:'Counter is 1',afterStep:1,oracle:{kind:'text',value:'Counter is 1'}}] }] });
  stages.gateRun(runId, projectId); stages.finalizeRun(runId, projectId);
  const first = approvals.reviewRevisions(runId, projectId)[0]; const human = { kind: 'human' as const, id: 'UNIT_FIXTURE' };
  approvals.decideRevisions(runId, projectId, { items: [{ caseId: first.caseId, revisionId: first.revision.id, decision: 'approved' }] }, human); await delivery.flushDecisionDelivery();
  const board = database.listCases(projectId).find(c => c.sourceRunId === runId)!;
  expect(() => delivery.assertBoardApproval(board)).not.toThrow();
  expect(delivery.exportApprovedCases([board])[0]).toMatchObject({assertions:[{id:"a1",afterStep:1,oracle:{kind:"text",value:"Counter is 1"}}]});
  expect(() => policy.assertCaseMutation(board.id, { expected: 'changed' }, 'PATCH', human)).toThrow('review_revision_required');
  expect(() => policy.assertCaseMutation(board.id, {}, 'DELETE', human)).toThrow('withdraw_versioned_approval_required');
  policy.assertCaseMutation(board.id, { steps: [{ text: 'Click the Increment button' }] }, 'PATCH', { kind: 'agent', id: 'repair' });
  database.updateCase(board.id, { steps: [{ text: 'Click the Increment button' }] });
  expect(() => delivery.assertBoardApproval(database.getCase(board.id)!)).not.toThrow();
  database.updateCase(board.id, { expected: 'changed directly in DB' });
  expect(() => delivery.assertBoardApproval(database.getCase(board.id)!)).toThrow('approved_case_content_changed');
  expect(() => delivery.exportApprovedCases([database.getCase(board.id)!])).toThrow('approved_case_content_changed');
});
it('allows local operator actions without login and rejects explicit agent credentials before legacy handlers', async () => {
  const express = (await import('express')).default;
  const app = express(); app.use(express.json()); app.use('/api', policy.intentPolicy);
  let mutations = 0;
  app.use('/api', (_req, res) => { mutations++; res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const { port } = server.address() as import('node:net').AddressInfo;
  async function send(path: string, body: object, method = 'PATCH', auth: string | null = 'fixture-run-token') {
    return fetch(`http://127.0.0.1:${port}/api/${path}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
  }
  try {
    for (const body of [{ oracle: null }, { oracle: null, __actor: 'human' }]) expect((await send(`cases/${caseId}`, body)).status).toBe(403);
    expect((await send(`cases/${caseId}`, {}, 'DELETE')).status).toBe(403);
    expect((await send('review/legacy/approve', { __actor: 'human' }, 'POST')).status).toBe(403);
    expect((await send('gold/domain', { action: 'freeze', by: 'human' }, 'POST')).status).toBe(403);
    expect(mutations).toBe(0);
    expect((await send(`cases/${caseId}`, { expected: 'local edit' }, 'PATCH', null)).status).toBe(200);
    for (const path of ['review/legacy/approve', 'cases/'+caseId+'/baselines/approve', 'cases/'+caseId+'/perf-baseline/approve', 'gold/domain']) {
      expect((await send(path, {}, 'POST', null)).status).toBe(200);
    }
    expect(mutations).toBe(5);
    expect((await send('gold', {file:{id:'candidate'}}, 'POST')).status).toBe(200);
    expect((await send('gold/domain', {action:'freeze'}, 'POST')).status).toBe(403);
    expect(mutations).toBe(6);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
