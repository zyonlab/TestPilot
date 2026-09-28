import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** 暂停中的运行换执行模型（2026-09-26：执行模型服务额度用完，402）：只换执行器，规划器不动。 */
let dir: string, db: typeof import('../src/db.js'), svc: typeof import('../src/runService.js'), snap: typeof import('../src/modelSnapshots.js');
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tp-rebind-')); vi.stubEnv('TP_DATA_DIR', dir);
  vi.stubEnv('MIDSCENE_MODEL_NAME', 'old-exec'); vi.stubEnv('MIDSCENE_MODEL_BASE_URL', 'https://old.test/v1'); vi.stubEnv('MIDSCENE_MODEL_API_KEY', 'old-key');
  db = await import('../src/db.js'); svc = await import('../src/runService.js'); snap = await import('../src/modelSnapshots.js');
});
afterAll(() => { svc.runLedger().close(); db.db.close(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
it('swaps only the executor of a run and keeps the planner binding', () => {
  const project = db.createProject('Rebind', 'http://localhost:9876').id;
  const run = svc.registerHostRun(project, { runtime: 'codex', externalId: 'rebind', idempotencyKey: 'rebind', materials: [{ name: 'm.md', text: 'x' }] }).runId;
  expect(snap.snapshotExecutor(run, project)).toMatchObject({ model: 'old-exec', endpoint: 'https://old.test/v1' });
  vi.stubEnv('MIDSCENE_MODEL_NAME', 'new-exec'); vi.stubEnv('MIDSCENE_MODEL_BASE_URL', 'https://new.test/v1'); vi.stubEnv('MIDSCENE_MODEL_API_KEY', 'new-key');
  const change = snap.rebindRunExecutor(run, project);
  expect(change.before.model).toBe('old-exec'); expect(change.after.model).toBe('new-exec');
  expect(JSON.stringify(change)).not.toContain('new-key');
  expect(snap.snapshotExecutor(run, project)).toMatchObject({ model: 'new-exec', endpoint: 'https://new.test/v1', apiKey: 'new-key' });
  expect(() => snap.rebindRunExecutor(run, 'other-project')).toThrow();
});
