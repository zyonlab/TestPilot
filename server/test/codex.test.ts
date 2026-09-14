import { expect, it } from 'vitest';
import { codexArgs, codexSessionId } from '../src/codex.js';
import { getRuntime, isRuntimeName, runtimeModelCapabilities } from '../src/runtimes.js';
it('adds a required MCP server and isolated workspace without changing the native planner or auth', () => {
  const args = codexArgs('/tmp/codex fixture', { TP_RUN_GRANT_FILE: '/tmp/private grant.json', TP_RUNTIME: 'codex' });
  expect(args).toContain('workspace-write'); expect(args).toContain('--json');
  expect(args).not.toContain('--model'); expect(args).not.toContain('--ignore-user-config'); expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  const config = args.find(x => x.startsWith('mcp_servers.testpilot='))!;
  expect(config).toContain('"required"=true'); expect(config).toContain('"TP_RUN_GRANT_FILE"="/tmp/private grant.json"');
  expect(config).not.toMatch(/TP_PLANNER_|OPENAI_API_KEY|MIDSCENE_MODEL_API_KEY/);
});
it('dispatches Codex with the same registration, watch and decision contracts', () => {
  expect(codexSessionId({ type: 'thread.started', thread_id: 'session-native' })).toBe('session-native');
  expect(codexSessionId({ type: 'turn.completed' })).toBeUndefined();
  expect(isRuntimeName('codex')).toBe(true); expect(getRuntime('codex').name).toBe('codex');
  expect(runtimeModelCapabilities.codex).toMatchObject({ adapterImplemented: true, managedPlannerConfig: false, generationEntry: 'skill-stages' });
});
