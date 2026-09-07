import { describe, expect, it } from "vitest";
import { diffScreens, maskVolatile } from "../src/exec/interactive.js";

/**
 * 一次动作让页面**哪里变了**——这一维此前完全不存在。
 *
 * 缺了它，下游拿到的是 N 张完整屏幕转储，没有任何"点了 X 之后 Y 出现了"的因果标注，
 * 只能从整屏文字里抓字面。实测（demo.binance.com，2026-09-01）抓出来的是
 * 「显示 0.01000%」「显示 05:40:16」两条"规格规则"，以及照它们产出的两条
 * 下一次跑必然失败的用例。
 */
describe("掩码只吃易变读数，不吃真实变化", () => {
  it("倒计时、资金费率、大额行情算不上变化", () => {
    expect(maskVolatile("Countdown 05:40:16")).toBe(maskVolatile("Countdown 05:40:15"));
    expect(maskVolatile("Funding 0.01000%")).toBe(maskVolatile("Funding 0.01001%"));
    expect(maskVolatile("24h Vol 1,406,924.3214")).toBe(maskVolatile("24h Vol 1,398,001.9982"));
  });

  it("「余额 0 → 100」这类真实变化必须留下来", () => {
    expect(maskVolatile("Avbl 0 USDT")).not.toBe(maskVolatile("Avbl 100 USDT"));
    expect(maskVolatile("Positions(0)")).not.toBe(maskVolatile("Positions(1)"));
  });
});

describe("diffScreens", () => {
  const S = (controls: string[], states: string[], text: string) => ({ controls, states, text });

  it("只有行情在跳时，判定为没有变化", () => {
    const a = S(["div: Limit"], ["div: Limit#selected=true"], "Funding 0.01000%\nCountdown 05:40:16");
    const b = S(["div: Limit"], ["div: Limit#selected=true"], "Funding 0.01002%\nCountdown 05:40:15");
    const d = diffScreens(a, b);
    expect(d.changed).toBe(false);
    expect(d.textAdded).toEqual([]);
  });

  it("切换标签页：控件文案没变，但状态变了——这正是老签名看不见的那一维", () => {
    const a = S(["div: Limit", "div: Market"], ["div: Limit#selected=true", "div: Market#selected=false"], "x");
    const b = S(["div: Limit", "div: Market"], ["div: Limit#selected=false", "div: Market#selected=true"], "x");
    const d = diffScreens(a, b);
    expect(d.controlsAdded).toEqual([]);
    expect(d.controlsRemoved).toEqual([]);
    expect(d.stateChanged).toHaveLength(2);
    expect(d.stateChanged.join(" ")).toContain("Market");
    expect(d.changed).toBe(true);
  });

  it("面板换掉：新控件出现、旧控件消失", () => {
    const a = S(["div: Price", "div: Size"], [], "下单区");
    const b = S(["div: Trigger Price", "div: Size"], [], "条件单区");
    const d = diffScreens(a, b);
    expect(d.controlsAdded).toContain("div: Trigger Price");
    expect(d.controlsRemoved).toContain("div: Price");
    expect(d.changed).toBe(true);
  });

  it("没有 states 时照样能算控件与文本的差", () => {
    const a = { controls: ["a: 首页"], text: "一" };
    const b = { controls: ["a: 首页", "a: 关于"], text: "一\n二" };
    const d = diffScreens(a, b);
    expect(d.controlsAdded).toEqual(["a: 关于"]);
    expect(d.textAdded).toEqual(["二"]);
  });
});
