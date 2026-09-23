import { recordHostSummary } from './roleSpend.js';
/** Native Codex CLI adapter. Planning/auth remain the host's; MCP validates all TestPilot stages. */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generationMessage, prepareSkillLaunch } from './runtime/skill-launch.js';
import { configuredRunBudget } from './runBudget.js';
import { REPO_ROOT, defaultWorkspace, newRunId, readRun, writeDecisions, watchRun as sharedWatchRun, type StartRunInput, type StartedRun } from './penguin.js';
export { readRun, writeDecisions };
const live = new Map<string, { child: ChildProcess; state: 'running' | 'idle' | 'gone'; wallMs: number; stopReason?: string }>();
export const codexBin = () => process.env.TP_CODEX_BIN || 'codex';
export function codexSessionId(line: Record<string, unknown>) { return line.type === 'thread.started' && typeof line.thread_id === 'string' ? line.thread_id : undefined; }
// Values become individual argv entries, never shell source. Only credential file paths are passed.
const toml = (value: unknown): string => Array.isArray(value) ? `[${value.map(toml).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).map(([k,v]) => `${JSON.stringify(k)}=${toml(v)}`).join(',')}}` : JSON.stringify(value);
export function codexArgs(workspace: string, env: Record<string, string>) {
  return ['-a', 'never', 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', workspace,
    '-c', `mcp_servers.testpilot=${toml({ command: process.execPath, args: [join(REPO_ROOT, 'packages/testpilot-mcp/bin/testpilot-mcp.mjs')], cwd: REPO_ROOT, env, required: true, startup_timeout_sec: 60, tool_timeout_sec: 600, default_tools_approval_mode: 'approve' })}`, '-'];
}
export function cancelRun(runId: string, reason = 'codex_cancelled') { const run = live.get(runId); if (!run || run.state !== 'running') return false; run.stopReason ??= reason; run.child.kill('SIGTERM'); setTimeout(() => { if (run.state === 'running') run.child.kill('SIGKILL'); }, 5000).unref(); return true; }
export function isRunning(runId: string) { return live.get(runId)?.state === 'running'; }
export async function startRun(input: StartRunInput = {}): Promise<StartedRun> {
  if (input.models) throw new Error('codex_managed_planner_unsupported');
  const workspace = input.workspace ?? defaultWorkspace(), runId = input.runId ?? newRunId(), materialsDir = input.materialsDir ?? join(workspace, 'materials'), outDir = join(workspace, 'runs', runId);
  if (isRunning(runId)) throw new Error('codex_run_already_active');
  mkdirSync(outDir, { recursive: true });
  const stageEnv = input.generationMode === 'pipeline' ? { TP_GENERATION_MODE: 'pipeline' } : prepareSkillLaunch({ runId, scopeProjectId: input.scopeProjectId, runtime: 'codex', materialsDir, limit: input.limit, ablate: input.ablate });
  // Repository-local skills avoid changing global Codex configuration or the host's planner.
  for (const name of ['testpilot-run-c', 'testpilot-stories', 'testpilot-design']) {
    const source = join(REPO_ROOT, 'plugins/testpilot/skills', name);
    if (existsSync(source)) cpSync(source, join(workspace, '.agents/skills', name), { recursive: true, force: true });
  }
  const env = { ...stageEnv, TP_RUNTIME: 'codex', TP_RUNS_DIR: join(workspace, 'runs'), TP_SERVER_URL: process.env.TP_SERVER_URL ?? `http://127.0.0.1:${process.env.PORT ?? 5301}`,
    ...(input.scopeProjectId ? { TP_PROJECT_ID: input.scopeProjectId } : {}), ...(input.envRef ? { TP_ENV_ID: input.envRef } : {}),
    ...(existsSync(join(REPO_ROOT, 'server/.env')) ? { TP_MODEL_ENV_FILE: join(REPO_ROOT, 'server/.env') } : {}) };
  const childEnv = { ...process.env };
  // TestPilot's Web planner and executor must not override the native Codex planner.
  for (const key of Object.keys(childEnv)) if (/^(TP_PLANNER_|MIDSCENE_)/.test(key)) delete childEnv[key];
  const budget = input.budget ?? configuredRunBudget();
  const child = spawn(codexBin(), codexArgs(workspace, env), { cwd: workspace, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const item: NonNullable<ReturnType<typeof live.get>> = { child, state: 'running', wallMs: budget.wallMs }; live.set(runId, item);
  const tracePath = join(outDir, 'codex-events.jsonl'); let buffer = '', stderr = '', nativeSessionId = ''; let turn = 0;
  const deadline = setTimeout(() => cancelRun(runId, `codex_budget_exhausted: exceeded ${budget.wallMs} ms`), budget.wallMs); deadline.unref();
  const sessionId = await new Promise<string>((resolve, reject) => {
    let ready = false;
    const startup = setTimeout(() => { cancelRun(runId, 'codex_start_timeout'); reject(new Error('codex_start_timeout')); }, Math.min(60_000, budget.wallMs)); startup.unref();
    child.stdout!.on('data', data => {
      buffer += data.toString(); let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!raw.trim()) continue;
        appendFileSync(tracePath, raw + '\n', { mode: 0o600 });
        try { const event = JSON.parse(raw), id = codexSessionId(event);
          if (event.type === 'turn.completed' && event.usage && nativeSessionId && input.scopeProjectId) recordHostSummary(runId, 'codex', `${nativeSessionId}:${++turn}`, event.usage);
          if (id && !ready) { nativeSessionId = id; ready = true; clearTimeout(startup); writeFileSync(join(outDir, 'host-identity.json'), JSON.stringify({ runtime: 'codex', sessionId: id, plannerSource: 'host', model: null, modelIdentityEvidence: 'not_reported_in_exec_events', budget: { wallMs: budget.wallMs, nativePlannerCallLimit: 'host_controlled' } })); resolve(id); }
        } catch { /* Preserve original event for inspection. */ }
      }
    });
    child.stderr!.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
    child.on('error', () => { clearTimeout(startup); clearTimeout(deadline); item.state = 'gone'; item.stopReason = 'codex_spawn_failed'; reject(new Error('codex_spawn_failed')); });
    child.on('close', (code, signal) => {
      clearTimeout(startup); clearTimeout(deadline); item.state = code === 0 ? 'idle' : 'gone';
      if (!item.stopReason && code !== 0) item.stopReason = `codex_run_failed: ${signal ?? `exit ${code}`}`;
      writeFileSync(join(outDir, 'codex-exit.json'), JSON.stringify({ code, signal, ...(item.stopReason || code !== 0 ? { error: item.stopReason ?? `codex_run_failed: ${signal ?? `exit ${code}`}` } : {}) }));
      if (!ready) { writeFileSync(join(outDir, 'codex-start-error.txt'), stderr, { mode: 0o600 }); reject(new Error('codex_initialization_failed')); }
      setTimeout(() => { if (live.get(runId) === item) live.delete(runId); }, 120_000).unref();
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(input.message ?? generationMessage({ materialsDir, outDir, limit: input.limit, generationMode: input.generationMode, ablate: input.ablate }));
  });
  return { sessionId, workspace, runId, outDir };
}
export function watchRun(opts: Parameters<typeof sharedWatchRun>[0]) {
  sharedWatchRun({ ...opts, timeoutMs: live.get(opts.runId)?.wallMs ?? opts.timeoutMs, errorOf: () => live.get(opts.runId)?.stopReason, stateOf: () => live.get(opts.runId)?.state ?? 'gone', onDone: result => { if (result.status !== 'done') cancelRun(opts.runId); opts.onDone(result); } });
}
