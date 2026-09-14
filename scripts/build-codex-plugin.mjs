#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), src = join(root, 'plugins/testpilot'), out = join(root, 'plugins/testpilot-codex');
const source = JSON.parse(readFileSync(join(src, 'plugin.json'), 'utf8')), check = process.argv.includes('--check');
const files = new Map();
files.set('.codex-plugin/plugin.json', JSON.stringify({ name: 'testpilot-codex', version: source.version.replace(/^(\d+)-(\d+)-(\d+)\.(\d+)$/, (_, y, m, d, n) => `${Number(y)}.${Number(m)}.${Number(d)}+skill.${n}`), description: 'Versioned test design, human review and Midscene execution using the host planner.', author: { name: 'TestPilot' }, skills: './skills/', mcpServers: './.mcp.json', interface: { displayName: 'TestPilot', shortDescription: 'Design, review and execute traceable tests.', longDescription: 'Use your Codex planner with TestPilot domain skills and a separate Midscene executor. Requires a running TestPilot server and the testpilot-mcp command.', developerName: 'TestPilot', category: 'Developer Tools', capabilities: [], defaultPrompt: ['Use TestPilot to design tests from this project’s requirements.'] } }, null, 2) + '\n');
// The installer supplies this command on PATH. No repository layout assumptions in a cached plugin.
files.set('.mcp.json', JSON.stringify({ mcpServers: { testpilot: { command: 'testpilot-mcp', env: { TP_RUNTIME: 'codex' } } } }, null, 2) + '\n');
function copy(dir, prefix) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const rel = `${prefix}/${entry.name}`; if (entry.isDirectory()) copy(join(dir, entry.name), rel); else files.set(rel, readFileSync(join(dir, entry.name), 'utf8')); } }
copy(join(src, 'skills'), 'skills');
for (const [name, text] of files) { const path = join(out, name); if (check) { if (!existsSync(path) || readFileSync(path, 'utf8') !== text) throw new Error(`codex_plugin_drift: ${name}`); } else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); } }
console.log(`${check ? 'Verified' : 'Built'} Codex plugin ${source.version}: ${files.size} files`);
