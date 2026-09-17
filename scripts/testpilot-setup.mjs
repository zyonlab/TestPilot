#!/usr/bin/env node
/** Portable project-local setup. Never changes host model/auth or prints credential values. */
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, chmodSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), command = args[0] ?? 'doctor';
const USAGE = `Usage: node scripts/testpilot-setup.mjs <command> [options]

Commands:
  doctor     Check Node, dependencies, model env and the planner host (default)
  start      Start the API server (:5301) and the Web UI (:5300)
  install    Install TestPilot into a workspace for a host agent
  uninstall  Remove files installed by \`install\` (only unmodified ones)

Options:
  --entry <web|claude-code|codex|penguin>   Which entry to check or install (default: web)
  --workspace <dir>                          Target workspace (default: this checkout)
  --model-env <file>                         Model env file (default: server/.env)
  --agent-id <id>                            Penguin agent id (install --entry penguin)

Note: use \`node scripts/testpilot-setup.mjs ...\` rather than \`pnpm setup\` / \`pnpm doctor\`:
pnpm has built-in commands with those names that run instead of the project scripts.`;
if (['-h', '--help', 'help'].includes(command)) { console.log(USAGE); process.exit(0); }
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const entry = flag('entry', 'web'), workspace = resolve(flag('workspace', root)), envFile = resolve(flag('model-env', join(root, 'server/.env')));
if (!['web', 'codex', 'claude-code', 'penguin'].includes(entry)) throw new Error('entry must be web, codex, claude-code or penguin');
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
function envValues() { try { return { ...createRequire(join(root, 'server/package.json'))('dotenv').parse(readFileSync(envFile)), ...process.env }; } catch { return process.env; } }
function version(bin, nodeBin) { const result = spawnSync(nodeBin || bin, nodeBin ? [bin, '--version'] : ['--version'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, ...(nodeBin ? { PATH: dirname(nodeBin) + ':' + process.env.PATH } : {}) } }); return result.status === 0 ? result.stdout.trim().split('\n')[0] : null; }
const write = (path, text, mode = 0o600) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, { mode }); chmodSync(path, mode); };
if (command === 'doctor') {
  const env = envValues(), executor = !!(env.MIDSCENE_MODEL_NAME && (env.MIDSCENE_MODEL_BASE_URL || env.OPENAI_BASE_URL)), planner = !!(env.TP_PLANNER_MODEL_NAME && env.TP_PLANNER_BASE_URL);
  /**
   * Web 发起的生成由谁规划：`TP_AGENT_RUNTIME`，不设即本机 Claude Code（server/src/runtimes.ts）。
   * 以前 web 入口一律按 Penguin 检查（Node 24、TP_PLANNER_*），默认配置下照着 README 跑会被误报。
   */
  const webRuntime = entry === 'web' ? (env.TP_AGENT_RUNTIME || 'claude-code') : null;
  const needsClaude = entry === 'claude-code' || webRuntime === 'claude-code';
  const needsPenguin = entry === 'penguin' || webRuntime === 'penguin';
  const host = entry === 'codex' ? version(env.TP_CODEX_BIN || 'codex') : needsClaude ? version(env.TP_CLAUDE_BIN || 'claude') : null;
  const issues = [];
  if (Number(process.versions.node.split('.')[0]) < 22) issues.push('Use Node 22 or newer for the TestPilot server. Install dependencies with the same Node major version that starts the server.');
  if (!existsSync(join(root, 'server/node_modules/better-sqlite3'))) issues.push('Run pnpm install --frozen-lockfile in the TestPilot checkout.');
  if (!executor) issues.push('Set MIDSCENE_MODEL_NAME and MIDSCENE_MODEL_BASE_URL (or legacy OPENAI_BASE_URL) in the model env file.');
  if (webRuntime && !['claude-code', 'penguin'].includes(webRuntime)) issues.push(`TP_AGENT_RUNTIME must be claude-code or penguin (got ${webRuntime}).`);
  if (webRuntime === 'penguin' && !planner) issues.push('Set TP_PLANNER_MODEL_NAME and TP_PLANNER_BASE_URL. Initially copy the executor model profile.');
  if ((entry === 'codex' || needsClaude) && !host) issues.push(`Install the ${entry === 'codex' ? 'codex' : 'claude-code'} CLI and sign in with its native account${webRuntime ? ' (Web generation is planned by it; set TP_AGENT_RUNTIME to change that)' : ''}.`);
  if (entry === 'codex' && host && /0\.14[0-4]\./.test(host)) issues.push('This Codex CLI predates the verified 0.153.4 runtime. Upgrade the CLI or set TP_CODEX_BIN to a current installation; do not substitute the host model.');
  if (needsPenguin) {
    let node24 = env.TP_PENGUIN_NODE;
    if (!node24) { const base = join(env.HOME || '', '.nvm/versions/node'); try { node24 = join(base, readdirSync(base).filter(n => /^v(2[4-9]|[3-9]\d)\./.test(n)).sort((a,b) => b.localeCompare(a, undefined, { numeric: true }))[0], 'bin/node'); } catch {} }
    if (!node24 || !/^v(2[4-9]|[3-9]\d)\./.test(version(node24) ?? '')) issues.push('Install Node 24+ for Penguin, and set TP_PENGUIN_NODE to its executable.');
    const penguin = env.TP_PENGUIN_BIN || (node24 ? join(dirname(node24), 'penguin') : 'penguin'); if (!version(penguin, node24)) issues.push('Install @prismshadow/penguin-cli using the Penguin Node runtime, and set TP_PENGUIN_BIN.');
  }
  console.log(JSON.stringify({ entry, workspace, node: process.version, host, ...(webRuntime ? { webPlanner: webRuntime } : {}), plannerSource: webRuntime === 'penguin' ? (planner ? 'Web profile/environment' : 'missing') : 'native host', executorSource: executor ? 'environment (project settings may override)' : 'missing environment (check project settings)', credentialValuesPrinted: false, reviewer: { mode: 'local', authenticationRequired: false }, issues, ready: issues.length === 0 }, null, 2));
  if (issues.length) process.exitCode = 1;
} else if (command === 'start') {
  if (entry !== 'web') throw new Error('start supports --entry web; host planners start in their native app.');
  const children = [spawn('pnpm', ['server:dev'], { cwd: root, stdio: 'inherit' }), spawn('pnpm', ['dev'], { cwd: root, stdio: 'inherit' })];
  let stopping = false;
  const stop = code => { if (stopping) return; stopping = true; for (const c of children) c.kill('SIGTERM'); process.exitCode = code; };
  process.on('SIGINT', () => stop(0)); process.on('SIGTERM', () => stop(0));
  for (const c of children) { c.on('error', () => stop(1)); c.on('exit', code => stop(code ?? 1)); }
} else if (command === 'uninstall') {
  const receiptPath = join(workspace, '.testpilot/install.json');
  if (!existsSync(receiptPath)) throw new Error('No project-local installation receipt; no files removed.');
  const receipt = readJSON(receiptPath), retained = [];
  for (const [file, hash] of Object.entries(receipt.files ?? {})) {
    const path = resolve(workspace, file);
    if (!path.startsWith(workspace + '/')) throw new Error('Invalid installation receipt path');
    if (!existsSync(path)) continue;
    if (createHash('sha256').update(readFileSync(path)).digest('hex') === hash) rmSync(path); else retained.push(file);
  }
  const config = receipt.configPath;
  if (!resolve(config).startsWith(workspace + '/')) throw new Error('Invalid config receipt path');
  if (existsSync(config)) {
    if (['codex', 'penguin'].includes(receipt.entry)) write(config, readFileSync(config, 'utf8').replace(/\n?# BEGIN TESTPILOT\n[\s\S]*?# END TESTPILOT\n?/g, '\n'));
    else { const current = readJSON(config); if (JSON.stringify(current.mcpServers?.testpilot) === JSON.stringify(receipt.mcp)) { delete current.mcpServers.testpilot; write(config, JSON.stringify(current, null, 2) + '\n'); } else retained.push(config); }
  }
  rmSync(receiptPath); console.log(JSON.stringify({ removedInstalledUnchangedFiles: true, retainedModifiedFiles: retained, userMaterialsPreserved: true }, null, 2));
} else if (command === 'install') {
  const manifest = readJSON(join(root, 'plugins/testpilot/plugin.json'));
  if (entry === 'web') {
    if (!existsSync(envFile)) { mkdirSync(dirname(envFile), { recursive: true }); cpSync(join(root, 'server/.env.example'), envFile); chmodSync(envFile, 0o600); }
    console.log(JSON.stringify({ entry, envFile, next: ['Fill the model environment file or use project model settings.', 'pnpm server:dev', 'pnpm dev', 'Open Workflows in the Web UI.'] }, null, 2));
  } else if (entry === 'penguin') {
    const agent = flag('agent-id'); if (!agent) throw new Error('penguin install requires --agent-id after creating an agent in Penguin');
    const penguinHome = resolve(flag('penguin-home', join(process.env.HOME, '.penguin'))), project = flag('project', 'default_project');
    if (!/^[a-zA-Z0-9_-]+$/.test(agent) || !/^[a-zA-Z0-9_-]+$/.test(project)) throw new Error('Use an existing safe agent/project identifier.');
    const state = join(penguinHome, 'data', project, 'agents', agent, 'agent_state'), configPath = join(state, 'system_config.yaml');
    if (!existsSync(configPath)) throw new Error('Create the Penguin agent first; system_config.yaml is missing.');
    const before = readFileSync(configPath, 'utf8'), marker = /\n?# BEGIN TESTPILOT\n[\s\S]*?# END TESTPILOT\n?/g;
    let remainder = before.replace(marker, '\n');
    if (/name:\s*["']?testpilot["']?\s*$/m.test(remainder)) throw new Error('Existing unmanaged TestPilot MCP configuration: migrate or rename it before installing.');
    const config = { transport: 'stdio', command: process.execPath, args: [join(root, 'packages/testpilot-mcp/bin/testpilot-mcp.mjs')], cwd: root, env: { TP_RUNTIME: 'penguin', TP_MODEL_ENV_FILE: envFile, TP_SERVER_URL: flag('server', 'http://127.0.0.1:5301') }, permission: 'rw', connectTimeoutMs: 60000, timeoutMs: 600000 };
    const lines = remainder.split('\n'), toolsAt = lines.findIndex(x => /^tools:\s*$/.test(x));
    if (toolsAt < 0) throw new Error('Penguin tools section missing; inspect the native agent configuration.');
    let toolsEnd = toolsAt + 1; while (toolsEnd < lines.length && (!lines[toolsEnd].trim() || /^\s/.test(lines[toolsEnd]))) toolsEnd++;
    const mcpAt = lines.findIndex((x,i) => i > toolsAt && i < toolsEnd && /^  mcpServers:\s*(?:\[\])?\s*$/.test(x));
    let insertion = toolsEnd, prefix = '  mcpServers:\n';
    if (mcpAt >= 0) { if (lines[mcpAt].includes('[]')) lines[mcpAt] = '  mcpServers:'; insertion = mcpAt + 1; while (insertion < toolsEnd && (!lines[insertion].trim() || /^    /.test(lines[insertion]))) insertion++; prefix = ''; }
    const block = '# BEGIN TESTPILOT\n' + prefix + '    - ' + JSON.stringify({ name: 'testpilot', config }) + '\n# END TESTPILOT';
    lines.splice(insertion, 0, block);
    const result = spawnSync('bash', [join(root, 'plugins/testpilot/install.sh'), '--agent-id', agent, '--penguin-home', penguinHome, '--project', project], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Penguin skill installation failed');
    write(configPath, lines.join('\n'));
    const files = {}, inventory = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir,e.name); if(e.isDirectory()) inventory(p); else files[p.slice(state.length+1)] = createHash('sha256').update(readFileSync(p)).digest('hex'); } };
    for (const name of readdirSync(join(root,'plugins/testpilot/skills'))) inventory(join(state,'skills',name)); inventory(join(state,'hooks/testpilot'));
    write(join(state,'.testpilot/install.json'),JSON.stringify({entry,workspace:state,configPath,files,version:manifest.version},null,2));
    console.log(JSON.stringify({ entry, workspace: state, configPath, planner: 'native Penguin project model unchanged', executor: 'model env reference', uninstall: 'Use uninstall --workspace with the agent state path' }, null, 2));
  } else {
    const configDir = entry === 'codex' ? '.codex' : '.claude', skillDir = entry === 'codex' ? '.agents/skills' : '.claude/skills';
    const mcp = { command: process.execPath, args: [join(root, 'packages/testpilot-mcp/bin/testpilot-mcp.mjs')], env: { TP_RUNTIME: entry, TP_MODEL_ENV_FILE: envFile, TP_SERVER_URL: flag('server', 'http://127.0.0.1:5301'), ...(flag('project-id') ? { TP_PROJECT_ID: flag('project-id') } : {}) } };
    let configPath, configText;
    if (entry === 'codex') {
      configPath = join(workspace, configDir, 'config.toml'); const before = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
      const marker = /\n?# BEGIN TESTPILOT\n[\s\S]*?# END TESTPILOT\n?/g, remainder = before.replace(marker, '');
      if (/\[mcp_servers\.(?:testpilot|"testpilot")\]/.test(remainder)) throw new Error('Existing unmanaged mcp_servers.testpilot: merge or rename it before installing.');
      configText = remainder.trimEnd() + '\n# BEGIN TESTPILOT\n[mcp_servers.testpilot]\ncommand = ' + JSON.stringify(mcp.command) + '\nargs = ' + JSON.stringify(mcp.args) + '\nrequired = true\nstartup_timeout_sec = 60\ntool_timeout_sec = 600\n[mcp_servers.testpilot.env]\n' + Object.entries(mcp.env).map(([k,v]) => `${k} = ${JSON.stringify(v)}`).join('\n') + '\n# END TESTPILOT\n';
    } else { configPath = join(workspace, '.mcp.json'); const before = existsSync(configPath) ? readJSON(configPath) : {}; if (before.mcpServers?.testpilot && !existsSync(join(workspace, '.testpilot/install.json'))) throw new Error('Existing unmanaged TestPilot MCP server: merge or rename it before installing.'); configText = JSON.stringify({ ...before, mcpServers: { ...before.mcpServers, testpilot: mcp } }, null, 2) + '\n'; }
    const owned = existsSync(join(workspace, '.testpilot/install.json'));
    const skills = readdirSync(join(root, 'plugins/testpilot/skills'));
    for (const name of skills) if (!owned && existsSync(join(workspace, skillDir, name))) throw new Error(`Existing skill ${name}: install into a clean workspace or back up that skill before upgrading.`);
    for (const name of skills) cpSync(join(root, 'plugins/testpilot/skills', name), join(workspace, skillDir, name), { recursive: true });
    write(configPath, configText);
    const shim = join(workspace, '.testpilot/bin/testpilot-mcp');
    write(shim, '#!/usr/bin/env node\nprocess.env.TP_MODEL_ENV_FILE ??= ' + JSON.stringify(envFile) + ';\nprocess.env.TP_SERVER_URL ??= ' + JSON.stringify(mcp.env.TP_SERVER_URL) + ';\nimport(' + JSON.stringify(new URL('../packages/testpilot-mcp/bin/testpilot-mcp.mjs', import.meta.url).href) + ');\n', 0o700);
    const result = { entry, version: manifest.version, workspace, configPath, bin: dirname(shim), planner: 'native host, unchanged', executor: 'TestPilot project / environment', skills: skills.length };
    const files = {};
    const inventory = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) inventory(p); else files[p.slice(workspace.length + 1)] = createHash('sha256').update(readFileSync(p)).digest('hex'); } };
    for (const name of skills) inventory(join(workspace, skillDir, name));
    files[shim.slice(workspace.length + 1)] = createHash('sha256').update(readFileSync(shim)).digest('hex');
    write(join(workspace, '.testpilot/install.json'), JSON.stringify({ ...result, mcp, files }, null, 2)); console.log(JSON.stringify(result, null, 2));
  }
} else { console.error(`Unknown command: ${command}\n\n${USAGE}`); process.exitCode = 2; }
