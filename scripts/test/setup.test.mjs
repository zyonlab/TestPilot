import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const root = resolve(import.meta.dirname, '../..');
const mcpRequire = createRequire(join(root, 'packages/testpilot-mcp/package.json'));
const { Client } = mcpRequire('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = mcpRequire('@modelcontextprotocol/sdk/client/stdio.js');
const run = (...args) => spawnSync(process.execPath, [join(root, 'scripts/testpilot-setup.mjs'), ...args], { encoding: 'utf8', timeout: 30000 });
for (const entry of ['codex', 'claude-code']) test(`${entry}: preserve native config, install twice, actual MCP handshake, uninstall preserves modified skills and materials`, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'tp install with spaces '));
  const env = join(workspace, 'models.env'); writeFileSync(env, 'MIDSCENE_MODEL_NAME=fake\nMIDSCENE_MODEL_BASE_URL=http://localhost:9\nMIDSCENE_MODEL_API_KEY=SECRET_SETUP_SENTINEL\n');
  mkdirSync(join(workspace, '.codex')); writeFileSync(join(workspace, '.codex/config.toml'), 'model = "keep-native-model"\n');
  writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { unrelated: { command: 'keep-me' } } }));
  for (let n = 0; n < 2; n++) { const r = run('install', '--entry', entry, '--workspace', workspace, '--model-env', env); assert.equal(r.status, 0, r.stderr); assert(!r.stdout.includes('SECRET_SETUP_SENTINEL')); }
  const receipt = JSON.parse(readFileSync(join(workspace, '.testpilot/install.json')));
  const config = readFileSync(receipt.configPath, 'utf8'); assert(!config.includes('SECRET_SETUP_SENTINEL'));
  if (entry === 'codex') { assert(config.includes('keep-native-model')); assert.equal(config.match(/# BEGIN TESTPILOT/g).length, 1); }
  else assert.equal(JSON.parse(config).mcpServers.unrelated.command, 'keep-me');
  assert.equal(statSync(receipt.configPath).mode & 0o777, 0o600);
  const client = new Client({ name: 'setup-contract', version: '1.0.0' });
  try { await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(receipt.bin, 'testpilot-mcp')], cwd: workspace, stderr: 'pipe' })); const { tools } = await client.listTools(); assert(tools.some(t => t.name === 'register_run')); assert(tools.some(t => t.name === 'finalize_run'));
    // 单元循环的四个工具（docs/v3/history/22）：少任何一个，规划器就只能整份写入，而整份写入在开了单元的 run 上会被服务端拒绝——
    // 那时候的表现是「宿主卡在 stories 节点写不进去」，从工具清单上看不出原因。
    for (const name of ['claim_unit', 'write_unit', 'unit_status', 'merge_units']) assert(tools.some(t => t.name === name), `MCP 少了 ${name}`); }
  finally { await client.close(); }
  const skill = join(workspace, entry === 'codex' ? '.agents/skills' : '.claude/skills', 'testpilot-run-c/SKILL.md');
  writeFileSync(skill, 'User modified content'); writeFileSync(join(workspace, 'material.md'), 'User material');
  const removed = run('uninstall', '--workspace', workspace); assert.equal(removed.status, 0, removed.stderr);
  assert.equal(readFileSync(skill, 'utf8'), 'User modified content'); assert(existsSync(join(workspace, 'material.md'))); assert(!existsSync(join(receipt.bin, 'testpilot-mcp')));
  const after = readFileSync(receipt.configPath, 'utf8'); assert(!after.includes('mcp_servers.testpilot')); if (entry === 'codex') assert(after.includes('keep-native-model')); else assert.equal(JSON.parse(after).mcpServers.unrelated.command, 'keep-me');
});
test('Web setup preserves existing env, missing model doctor is actionable and secret-free', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'tp web install ')), env = join(workspace, '.env');
  assert.equal(run('install', '--entry', 'web', '--model-env', env).status, 0);
  assert.equal(statSync(env).mode & 0o777, 0o600);
  writeFileSync(env, 'PRIVATE_KEY=SECRET_SETUP_SENTINEL\n'); run('install', '--entry', 'web', '--model-env', env);
  assert.equal(readFileSync(env, 'utf8'), 'PRIVATE_KEY=SECRET_SETUP_SENTINEL\n');
  const diagnosis = run('doctor', '--entry', 'codex', '--model-env', env); assert.equal(diagnosis.status, 1); assert(!diagnosis.stdout.includes('SECRET_SETUP_SENTINEL')); assert(diagnosis.stdout.includes('MIDSCENE_MODEL_NAME'));
});
test('Penguin local agent installation preserves planner config and other MCP tools', () => {
  const home = mkdtempSync(join(tmpdir(),'tp penguin install ')), state = join(home,'data/default_project/agents/fixture/agent_state');
  mkdirSync(state,{recursive:true}); writeFileSync(join(state,'system_config.yaml'),'name: fixture\ntools:\n  shell: true\n  mcpServers:\n    - name: unrelated\n      config: {command: keep}\nsystem_prompt: |\n  Keep this native prompt.\n');
  for(let n=0;n<2;n++){const r=run('install','--entry','penguin','--agent-id','fixture','--penguin-home',home);assert.equal(r.status,0,r.stderr);}
  const config = readFileSync(join(state,'system_config.yaml'),'utf8'); assert(config.includes('name: unrelated')); assert(config.includes('Keep this native prompt.')); assert.equal(config.match(/# BEGIN TESTPILOT/g).length,1); assert(config.includes('TP_MODEL_ENV_FILE')); assert(!config.includes('TP_PLANNER_API_KEY'));
  assert.equal(run('uninstall','--workspace',state).status,0); const after=readFileSync(join(state,'system_config.yaml'),'utf8');assert(after.includes('name: unrelated'));assert(after.includes('Keep this native prompt.'));assert(!after.includes('TP_MODEL_ENV_FILE'));
});
