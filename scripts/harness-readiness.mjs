#!/usr/bin/env node
/** Opt-in architectural readiness checks. Nonzero means blocked, not a winning candidate. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) {
  console.error('Usage: node scripts/harness-readiness.mjs [--output path.json]');
  process.exit(2);
}
const temp = mkdtempSync(join(tmpdir(), 'tp-readiness-report-'));
try {
  const raw = join(temp, 'vitest.json'), observed = join(temp, 'observations.json');
  const run = spawnSync('pnpm', ['--filter', 'testpilot-server', 'exec', 'vitest', 'run', '--config', 'audit/vitest.config.ts', '--reporter=json', `--outputFile=${raw}`], {
    cwd: repo, env: { ...process.env, TP_AUDIT_OBSERVATIONS: observed }, encoding: 'utf8', timeout: 120_000,
  });
  let report, observations;
  try { report = JSON.parse(readFileSync(raw, 'utf8')); observations = JSON.parse(readFileSync(observed, 'utf8')); }
  catch {
    console.error('Readiness audit did not finish; no readiness conclusion.');
    console.error(run.error?.message ?? run.stderr ?? 'missing evidence');
    process.exitCode = 2;
  }
  if (report && observations) {
    const checks = report.testResults.flatMap(file => file.assertionResults.map(item => ({
      id: item.title.split(' ')[0], requirement: item.title, status: item.status,
    })));
    const blocked = checks.some(c => c.status === 'failed');
    const expectedIds = ['R01', 'R02', 'R03', 'R04', 'C01', 'C02'];
    const complete = !run.error && run.status === (blocked ? 1 : 0)
      && checks.length === expectedIds.length
      && expectedIds.every(id => checks.filter(c => c.id === id).length === 1 && Object.hasOwn(observations, id))
      && checks.every(c => ['passed', 'failed'].includes(c.status))
      && (report.numRuntimeErrorTestSuites ?? 0) === 0;
    const evidence = {
      schemaVersion: 1, at: new Date().toISOString(),
      commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
      branch: spawnSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
      sourceHashes: Object.fromEntries(['server/src/evals.ts', 'server/src/reviewPrincipal.ts', 'packages/testpilot-mcp/src/host/api.ts', 'packages/testpilot-mcp/src/host/tools.ts', 'packages/testpilot-mcp/src/host/registry.ts', 'server/audit/evaluation-readiness.audit.ts', 'server/audit/vitest.config.ts', 'scripts/harness-readiness.mjs'].map(path => [path, createHash('sha256').update(readFileSync(join(repo, path))).digest('hex')])),
      status: !complete ? 'incomplete' : blocked ? 'blocked' : 'checks-passed',
      scope: 'Six isolated contract checks; passing does not establish end-to-end model quality or authorize release.',
      tests: checks, observations,
    };
    if (args[1]) { const out = resolve(args[1]); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n'); }
    console.log(JSON.stringify(evidence, null, 2));
    process.exitCode = !complete ? 2 : blocked ? 1 : run.status === 0 ? 0 : 2;
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
