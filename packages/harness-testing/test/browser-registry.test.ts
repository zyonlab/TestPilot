import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sweepOrphanBrowsers, trackBrowser } from '../src/exec/browserRegistry.js';

// 2026-09-27：runner 被 SIGKILL 后它起的 Chrome 留着，10 个孤儿吃光内存。下一个 runner 启动时接手关掉。
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tp-browsers-')); vi.stubEnv('TP_BROWSER_REGISTRY_DIR', dir); });
afterEach(() => vi.unstubAllEnvs());

it('tracks a launched browser and forgets it when it disconnects', () => {
  let onGone: () => void = () => {};
  trackBrowser({ process: () => ({ pid: 4242 }), once: (_e, fn) => { onGone = fn; } });
  expect(readdirSync(dir)).toEqual([`${process.pid}.json`]);
  onGone();
  expect(readdirSync(dir)).toEqual([]);
});

it('closes only live browsers of a runner that is gone, never a reused pid', () => {
  writeFileSync(join(dir, '111.json'), JSON.stringify([501, 502, 503]));   // 主人 111 已不在
  writeFileSync(join(dir, '222.json'), JSON.stringify([601]));             // 主人 222 还活着
  const killed: number[] = [];
  const io = {
    alive: (pid: number) => [222, 501, 502, 601].includes(pid),
    isBrowser: (pid: number) => pid !== 502,                               // 502 被系统复用成了别的进程
    kill: (pid: number) => { killed.push(pid); },
  };
  expect(sweepOrphanBrowsers(io)).toBe(1);
  expect(killed).toEqual([501]);
  expect(readdirSync(dir).sort()).toEqual(['222.json']);
});
