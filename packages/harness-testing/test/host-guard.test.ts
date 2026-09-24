import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import puppeteer, { type Browser } from 'puppeteer';
import { installHostGuard, isDeniedHost } from '../src/exec/session.js';

/**
 * 2026-09-23：准备阶段从测试网点到了主网——入口检查只看第一个 URL。
 * 这里用两个主机名指同一台本机服务：127.0.0.1 是被测站，localhost 当作禁止主机。
 * 链接点击、服务端重定向、window.open 三条路都得被拦住，并留下越界记录。
 */
let server: Server, port = 0, browser: Browser;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: `http://localhost:${port}/landed` }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>${req.headers.host}${req.url}</title><a id="out" href="http://localhost:${port}/landed">out</a><a id="redir" href="/redirect">redir</a>`);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
}, 60_000);
afterAll(async () => { await browser?.close(); await new Promise(r => server?.close(r)); });

it('matches the host and its subdomains, nothing else', () => {
  expect(isDeniedHost('https://app.hyperliquid.xyz/trade', ['app.hyperliquid.xyz'])).toBe(true);
  expect(isDeniedHost('https://x.app.hyperliquid.xyz/', ['app.hyperliquid.xyz'])).toBe(true);
  expect(isDeniedHost('https://app.hyperliquid-testnet.xyz/trade', ['app.hyperliquid.xyz'])).toBe(false);
  expect(isDeniedHost('not a url', ['app.hyperliquid.xyz'])).toBe(false);
});

it('blocks link clicks, redirects and new windows to a denied host and records each', async () => {
  const violations: string[] = [];
  await installHostGuard(browser, ['localhost'], violations);
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/start`);
  await Promise.all([page.waitForNavigation({ timeout: 3000 }).catch(() => {}), page.click('#out')]);
  expect(new URL(page.url()).hostname).not.toBe('localhost');
  // 被拦的导航留在浏览器的错误页上，回到起点再试下一条路。
  await page.goto(`http://127.0.0.1:${port}/start`);
  await Promise.all([page.waitForNavigation({ timeout: 3000 }).catch(() => {}), page.click('#redir')]);
  expect(new URL(page.url()).hostname).not.toBe('localhost');
  await page.goto(`http://127.0.0.1:${port}/start`);
  const before = (await browser.pages()).length;
  await page.evaluate(p => { window.open(`http://localhost:${p}/popup`); }, port);
  await new Promise(r => setTimeout(r, 1500));
  const open = await browser.pages();
  expect(open.some(p => new URL(p.url(), 'http://x').hostname === 'localhost')).toBe(false);
  expect(open.length).toBeLessThanOrEqual(before + 1);
  expect(violations.filter(v => v.includes('/landed')).length).toBeGreaterThanOrEqual(2);
  expect(violations.some(v => v.includes('/popup'))).toBe(true);
}, 30_000);
