import { describe, expect, it } from "vitest";
import { settleOn } from "../src/exec/interactive.js";

/**
 * 「页面好了没」这件事，判据是**它不再长**，不是**过了多少秒**。
 *
 * 实测由来（2026-09-01）：`demo.binance.com/en/futures/BTCUSDT` 在导航后 1.5 秒时
 * innerText 和可见控件数都还是 0。探索器按固定 1.5 秒读页面，读到空的，
 * 顺着 DOM 里的链接走去了 /en/login，交出一份讲登录流程的材料——
 * 而项目指的是合约交易。**它没有报错，只是给了一份关于另一个产品的完整材料。**
 */
describe("等页面安定", () => {
  /** 一个会逐渐"长出来"的假页面：前 n 次采样是空的，之后才有内容。 */
  const growing = (emptyProbes: number, finalN = 40) => {
    let i = 0;
    return {
      evaluate: async <T,>(): Promise<T> => {
        const k = i++;
        const n = k < emptyProbes ? 0 : finalN;
        return { n, len: n * 20 } as unknown as T;
      },
    };
  };

  it("客户端渲染的页面：等到它真的长出来", async () => {
    const r = await settleOn(growing(4), { minMs: 0, maxMs: 8000 });
    expect(r.settled).toBe(true);
    expect(r.controls).toBe(40);
  });

  it("一直是空的：不假装安定，如实说没安定", async () => {
    const r = await settleOn(
      { evaluate: async <T,>(): Promise<T> => ({ n: 0, len: 0 }) as unknown as T },
      { minMs: 0, maxMs: 1600 },
    );
    expect(r.settled).toBe(false);
    expect(r.controls).toBe(0);
  });

  it("已经稳定的页面不必等满上限", async () => {
    const began = Date.now();
    const r = await settleOn(
      { evaluate: async <T,>(): Promise<T> => ({ n: 12, len: 300 }) as unknown as T },
      { minMs: 0, maxMs: 10_000 },
    );
    expect(r.settled).toBe(true);
    expect(Date.now() - began).toBeLessThan(3000);
  });

  it("evaluate 抛错时按空页面处理，不把异常冒出去打断探索", async () => {
    const r = await settleOn(
      { evaluate: async () => { throw new Error("页面已经关了"); } },
      { minMs: 0, maxMs: 1200 },
    );
    expect(r.settled).toBe(false);
  });
});

/**
 * 走出被测应用的是**一整段路**，不是一个地址。
 *
 * 实测（demo.binance.com，2026-09-01）：期货页上挂着几百个 `/en/trade/<PAIR>` 链接，
 * 每一个点进去都被弹到 accounts.binance.com。只记住"这个地址"的话，下一轮去试下一个
 * 交易对——7 轮预算全花在同一件已经知道结果的事上，最后交出「2 屏 / 14 个地址看见了
 * 但一次都没进去」。这里钉的是"撞两次就划掉整段"这条判据本身。
 */
describe("走出被测应用后按路段跳过", () => {
  // 与 interactive.ts 里的 sectionOf 同一套：只吃掉最后一段，别把整站折成 "/"。
  const sectionOf = (href: string): string => {
    const p = new URL(href, "https://x").pathname;
    const cut = p.replace(/\/+$/, "").lastIndexOf("/");
    return cut > 0 ? p.slice(0, cut) : p;
  };

  it("同一段下的不同地址归到同一个路段", () => {
    expect(sectionOf("/en/trade/BTC_USDT")).toBe("/en/trade");
    expect(sectionOf("/en/trade/1INCH_USDT")).toBe("/en/trade");
    expect(sectionOf("/en/futures/BTCUSDT")).toBe("/en/futures");
  });

  it("顶层路径不会被折成根——否则撞一次就把整站划掉", () => {
    expect(sectionOf("/about")).toBe("/about");
    expect(sectionOf("/")).toBe("/");
  });

  it("撞满容忍次数才划掉整段，第一次不算", () => {
    const hits = new Map<string, number>();
    const TOL = 2;
    const hit = (h: string) => hits.set(sectionOf(h), (hits.get(sectionOf(h)) ?? 0) + 1);
    const skipped = (h: string) => (hits.get(sectionOf(h)) ?? 0) >= TOL;

    hit("/en/trade/BTC_USDT");
    expect(skipped("/en/trade/ETH_USDT")).toBe(false); // 一次不能定论
    hit("/en/trade/ETH_USDT");
    expect(skipped("/en/trade/1INCH_USDT")).toBe(true); // 两次之后整段跳过
    expect(skipped("/en/futures/BTCUSDT")).toBe(false); // 别的段不受影响
  });
});
