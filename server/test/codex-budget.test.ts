import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), watch: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../src/penguin.js', () => ({ REPO_ROOT: '/nonexistent', defaultWorkspace: () => '', newRunId: () => '', readRun: vi.fn(), writeDecisions: vi.fn(), watchRun: mocks.watch }));
vi.mock('../src/roleSpend.js', () => ({ recordHostSummary: vi.fn() }));
vi.mock('../src/runtime/skill-launch.js', () => ({ prepareSkillLaunch: () => ({}), generationMessage: () => 'test' }));
import { startRun, watchRun, cancelRun } from '../src/codex.js';
let dir = '';
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); if (dir) rmSync(dir, { recursive: true, force: true }); });
async function launch(id: string, wallMs: number) {
 vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), 'tp-codex-budget-'));
 const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn() });
 mocks.spawn.mockReturnValue(child);
 const starting = startRun({ runId: id, workspace: dir, generationMode: 'pipeline', budget: { wallMs, plannerCalls: 100, executorCalls: 100 } });
 child.stdout.emit('data', JSON.stringify({ type: 'thread.started', thread_id: 'native-test' }) + '\n');
 const started = await starting;
 watchRun({ ...started, onDone: vi.fn() });
 return { child, options: mocks.watch.mock.calls[0][0] };
}
it('honors the allocated budget beyond ten minutes and preserves timeout reason and signal', async () => {
 const { child, options } = await launch('long-budget', 1_200_000);
 expect(options.timeoutMs).toBe(1_200_000);
 await vi.advanceTimersByTimeAsync(600_001);
 expect(child.kill).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(599_999);
 expect(child.kill).toHaveBeenCalledWith('SIGTERM');
 child.emit('close', null, 'SIGTERM');
 expect(options.errorOf()).toContain('codex_budget_exhausted');
 expect(JSON.parse(readFileSync(join(dir, 'runs/long-budget/codex-exit.json'), 'utf8'))).toMatchObject({ code: null, signal: 'SIGTERM', error: 'codex_budget_exhausted: exceeded 1200000 ms' });
});
it('distinguishes explicit cancellation from unexpected process failure', async () => {
 const { child, options } = await launch('cancel-budget', 1_200_000);
 cancelRun('cancel-budget'); child.emit('close', null, 'SIGTERM');
 expect(options.errorOf()).toBe('codex_cancelled');
});
it('records abnormal exit codes without reporting a missing session', async () => {
 const { child, options } = await launch('failed-budget', 1_200_000);
 child.emit('close', 2, null);
 expect(options.errorOf()).toBe('codex_run_failed: exit 2');
});
