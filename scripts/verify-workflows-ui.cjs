// Isolated browser QA, synthetic API and reviewer. No model calls or user approvals.
const fs = require('node:fs'), path = require('node:path'), { createRequire } = require('node:module');
const root = process.cwd(), serverRequire = createRequire(root + '/server/package.json');
const { build } = createRequire(createRequire(serverRequire.resolve('vitest')).resolve('vite'))('esbuild');
const puppeteer = require(root + '/packages/harness-testing/node_modules/puppeteer');
(async () => {
  const { outputFiles } = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {WorkflowRunsPage} from './src/pages/WorkflowRuns';import {useStore} from './src/lib/store';import {usePrefs} from './src/lib/prefs';usePrefs.setState({lang:'zh'});useStore.setState({activeProjectId:'qa'});createRoot(document.getElementById('root')).render(<WorkflowRunsPage/>);window.qaStore=useStore;`, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, platform: 'browser', define: { 'process.env.NODE_ENV': '"test"' }, tsconfig: root + '/tsconfig.json' });
  const css = fs.readdirSync(root + '/dist/static/css').filter(x => x.endsWith('.css')).map(x => fs.readFileSync(root + '/dist/static/css/' + x, 'utf8')).join('\n');
  const fixture = require(root + '/docs/v3/evidence/n-07/real-execution/result.json');
  let run = structuredClone(fixture.run); run.status = 'waiting_review';
  const item = fixture.artifacts.find(a => a.revision.name.startsWith('review/'));
  let review = [{ caseId: item.content.id, ...item, approval: null }], decisions = 0, starts = 0, executions = [];
  const errors = [], checks = {}, browser = await puppeteer.launch({ headless: true });
  const dir = process.env.TP_EVIDENCE_DIR || root + '/docs/v3/evidence/n-06'; fs.mkdirSync(dir, { recursive: true });
  try {
    const page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', async r => {
      const u = new URL(r.url()); const headers = { 'access-control-allow-origin': '*' };
      function json(body, status = 200) { return r.respond({ status, headers, contentType: 'application/json', body: JSON.stringify(body) }); }
      if (u.pathname.includes('workflow-runs')) {
        if (u.pathname.endsWith('/workflow-runs')) {
          if (r.method() === 'POST') { starts++; return json({ wfRunId: run.id }); }
          return json({ runs: u.pathname.includes('/projects/empty/') ? [] : [run] });
        }
        if (u.pathname.endsWith('/spend')) return json(require(root + '/docs/v3/evidence/n-17/claude-code.json'));
        if (u.pathname.endsWith('/review')) {
          if (r.method() === 'POST') { const body = JSON.parse(r.postData()); checks.approvalBoundToRevision = body.items[0].revisionId === item.revision.id; decisions++; review[0].approval = { decision: body.items[0].decision, principal: { id: 'SYNTHETIC_UI_REVIEWER' }, at: new Date().toISOString() }; return json({ results: [{ status: 'recorded' }] }); }
          return json({ cases: review, compiled:{ready:review.some(c=>c.approval?.decision==='approved')} });
        }
        if (u.pathname.endsWith('/executions')) return json({ executions });
        if (u.pathname.endsWith('/g2')) return json({ status: 'ready_to_execute', revision: run.revisions.find(r => r.kind === 'code') });
        if (u.pathname.endsWith('/execute')) { executions = fixture.executions; run.status = 'completed'; return json({ executionId: executions[0].id }); }
        if (u.pathname.endsWith('/cancel')) { run.status = 'cancelled'; return json({ status: run.status }); }
        if (u.pathname.endsWith('/resume')) { run.status = 'waiting_review'; return json({ status: run.status, checkpoint: { verified: true } }); }
        const a = fixture.artifacts.find(a => u.pathname.includes(a.revision.id)); if (a) return json(a);
        return json(run);
      }
      if (u.origin === 'http://workflow.test' && u.pathname === '/') return r.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' });
      return r.abort();
    });
    await page.setViewport({ width: 1440, height: 1100 }); await page.goto('http://workflow.test/?api=http://workflow.test'); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: outputFiles[0].text });
    const click = async text => { await page.waitForFunction(text => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === text && !b.disabled), {}, text); return page.evaluate(text => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text); if (!button) throw new Error('Button missing: ' + text); button.click(); }, text); };
    await page.waitForFunction(() => document.body.textContent.includes('用例审核'));
    checks.stages = await page.$$eval('ol[aria-label="工作流阶段"] > li', els => els.length);
    checks.selectionRequired = await page.$$eval('button', els => els.find(b => b.textContent === '批准所选版本').disabled);
    checks.noReviewerLogin = await page.evaluate(() => !document.querySelector('input[type=password]') && !document.body.textContent.includes('解锁审核'));
    await page.click('section[aria-label="用例审核"] input[type=checkbox]'); await click('批准所选版本'); await page.waitForFunction(() => document.body.textContent.includes('SYNTHETIC_UI_REVIEWER'));
    await click('生成批准版本的执行物料'); await page.waitForSelector('section[aria-label="产物详情"]');
    await click('执行已批准物料'); await page.waitForFunction(() => document.body.textContent.includes('已完成')); checks.executionShown = await page.$eval('main', e => e.textContent.includes('查看执行证据'));
    await click('查看执行证据'); await page.waitForFunction(() => document.querySelector('section[aria-label="产物详情"]')?.textContent.includes('execution/'));
    await page.waitForFunction(() => document.querySelector('section[aria-label="规划与执行成本"]')?.textContent.includes('400,000')); checks.roleSpendVisible = true;
    checks.desktopNoOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    await page.screenshot({ path: dir + '/desktop.png', fullPage: true });
    await page.setViewport({ width: 390, height: 844 }); checks.mobileNoOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth); await page.screenshot({ path: dir + '/mobile.png', fullPage: true });
    run.status = 'cancelled'; await click('刷新'); await page.waitForFunction(() => document.body.textContent.includes('验证并恢复')); await click('验证并恢复'); await page.waitForFunction(() => document.body.textContent.includes('停止工作流')); checks.resume = true;
    await page.evaluate(() => window.qaStore.setState({ activeProjectId: 'empty' })); await page.waitForSelector('textarea'); checks.emptyState = await page.$eval('main', e => e.textContent.includes('还没有工作流'));
    await page.type('textarea', 'Counter starts at zero. Increment increases it by one.'); await click('开始设计'); await page.waitForFunction(() => location.hash.includes('run=')); checks.createdOnce = starts === 1;
    checks.decisionsOnce = decisions === 1; checks.errors = errors; checks.syntheticReviewerOnly = true;
    fs.writeFileSync(dir + '/ui-checks.json', JSON.stringify(checks, null, 2)); console.log(checks);
    if (errors.length || checks.stages !== 8 || Object.values(checks).some(x => x === false)) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
