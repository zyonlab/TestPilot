import { describe, it, expect } from "vitest";
import { sumSpend } from "../src/report.js";

/**
 * 07 T-04：并发时账不能按时间窗从一份共享日志里猜。
 * 两个 runner 各写各的日志，按 runner 读就是精确的；把两份日志按时间交错拼成一份再按窗口读，
 * 就会把别人的调用算到自己头上。这里用两段人造日志把这件事钉死。
 */
const t = (s: number) => `[2026-09-07T20:00:${String(s).padStart(2, "0")}.000+08:00]`;
const ts = (s: number) => new Date(`2026-09-07T12:00:${String(s).padStart(2, "0")}.000Z`).getTime();

// runner-1 跑用例 A（0–10 秒）：2 次调用、1 次命中
const statsA = `${t(1)} total_tokens: 100, cost_ms: 500\n${t(5)} total_tokens: 200, cost_ms: 700\n`;
const cacheA = `${t(2)} cache hit, type: plan, prompt: x\n`;
// runner-2 同时跑用例 B（0–10 秒）：3 次调用、2 次未命中
const statsB = `${t(2)} total_tokens: 50, cost_ms: 100\n${t(4)} total_tokens: 50, cost_ms: 100\n${t(6)} total_tokens: 50, cost_ms: 100\n`;
const cacheB = `${t(3)} no unused cache found\n${t(7)} no unused cache found\n`;
const merge = (a: string, b: string) => (a + b).split("\n").filter(Boolean).sort().join("\n") + "\n";

describe("账按 runner 归（T-04）", () => {
  it("并发 1：按 runner 读和按窗口读是同一份账", () => {
    const byRunner = sumSpend(statsA, cacheA, ts(0), ts(10));
    const byWindow = sumSpend(statsA, cacheA, ts(0), ts(10));
    expect(byRunner).toEqual(byWindow);
    expect(byRunner).toMatchObject({ modelCalls: 2, tokens: 300, modelMs: 1200, cacheHits: 1 });
  });

  it("并发 2：共享日志按窗口读会把另一个 runner 的账算进来，按 runner 读不会", () => {
    const shared = sumSpend(merge(statsA, statsB), merge(cacheA, cacheB), ts(0), ts(10));
    const own = sumSpend(statsA, cacheA, ts(0), ts(10));
    expect(shared.modelCalls).toBe(5); // 串了：2 + 3
    expect(shared.cacheMisses).toBe(2); // 这两次未命中根本不是 A 的
    expect(own.modelCalls).toBe(2);
    expect(own.cacheMisses).toBe(0);
  });
});
