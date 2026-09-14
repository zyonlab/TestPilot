import { describe, expect, it } from "vitest";
import { settleOn } from "../src/exec/pageReady.js";

/** 用一串量好的读数假扮一个页面：每次 evaluate 取下一帧。 */
function pageOf(frames: Array<{ n: number; len: number; res: number }>) {
  let i = 0;
  return { evaluate: async <T,>(fn: () => T) => { void fn; return (frames[Math.min(i++, frames.length - 1)] as unknown) as T; } };
}

describe("settleOn", () => {
  /**
   * 2026-09-13 在 hyperliquid-testnet 量到的真实时间线（每 500ms 一帧）：
   * 骨架期 DOM 一动不动，而资源计数每轮涨四到六条；`Order Book` 在 5309ms 才出现，
   * 文本 302 → 1220 → 1740。旧判据在 4749ms 就说 settled，视觉模型于是对着骨架
   * 说「页面上不存在 Order Book 标签」——一条记在产品头上的失败。
   */
  it("DOM 不动但还在取数据时，不算画完", async () => {
    const page = pageOf([
      { n: 17, len: 127, res: 65 },
      { n: 17, len: 302, res: 71 },
      { n: 17, len: 302, res: 76 }, // 旧判据在这里就 settled 了
      { n: 17, len: 302, res: 80 },
      { n: 28, len: 1220, res: 85 },
      { n: 28, len: 1740, res: 87 },
      { n: 28, len: 1740, res: 90 },
      { n: 28, len: 1740, res: 92 },
      { n: 28, len: 1740, res: 92 },
      { n: 28, len: 1740, res: 93 },
    ]);
    const r = await settleOn(page, { minMs: 0, maxMs: 12_000 });
    expect(r.settled).toBe(true);
    expect(r.textLen).toBe(1740);
    expect(r.controls).toBe(28);
  });

  it("画完之后的行情轮询不会让它一直等下去", async () => {
    // 每轮 +1 条资源（价格轮询），DOM 不动——这就是稳了。
    const page = pageOf([
      { n: 28, len: 1740, res: 97 },
      { n: 28, len: 1740, res: 98 },
      { n: 28, len: 1740, res: 99 },
      { n: 28, len: 1740, res: 100 },
    ]);
    const r = await settleOn(page, { minMs: 0, maxMs: 12_000 });
    expect(r.settled).toBe(true);
  });

  it("一直空白就说没稳，不假装", async () => {
    const page = pageOf([{ n: 0, len: 0, res: 0 }]);
    const r = await settleOn(page, { minMs: 0, maxMs: 1_600 });
    expect(r).toMatchObject({ settled: false, controls: 0, textLen: 0 });
  });
});
