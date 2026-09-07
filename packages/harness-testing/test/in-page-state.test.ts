import { describe, expect, it } from "vitest";
import { ABSTRACTIONS, abstractionNameOf, DEFAULT_ABSTRACTION } from "../src/exec/sfg.js";

/**
 * 同一条 route 上的页内状态，能不能被认成两屏。
 *
 * 实测由来（demo.binance.com 合约页，2026-09-01）：Limit / Market / Conditional 是
 * `div role=tab`，切换时**控件文案集合一个字都不变**，只有 `aria-selected` 挪了位置。
 * 老的五把尺子只吃 controls，于是每一次成功的切换都被判成"没有新界面"，
 * 连续三次（dryLimit 默认 3）探索就结束了——这正是整页只拿到一个状态的机制。
 */
describe("页内状态要能被签名看见", () => {
  const controls = [
    "div: Limit",
    "div: Market",
    "div: Conditional",
    "input[text]: Size",
  ];
  const limitActive = {
    url: "https://demo.binance.com/en/futures/BTCUSDT",
    controls,
    states: [
      "div: Limit#selected=true",
      "div: Market#selected=false",
      "div: Conditional#selected=false",
      "input[text]: Size",
    ],
  };
  const marketActive = {
    ...limitActive,
    states: [
      "div: Limit#selected=false",
      "div: Market#selected=true",
      "div: Conditional#selected=false",
      "input[text]: Size",
    ],
  };

  it("老尺子判成同一屏——这是今天的行为，留下来当对照", () => {
    const f = ABSTRACTIONS["route+controls/norm"]!;
    expect(f(limitActive)).toBe(f(marketActive));
  });

  it("新尺子判成两屏", () => {
    const f = ABSTRACTIONS["route+controls+state/norm"]!;
    expect(f(limitActive)).not.toBe(f(marketActive));
  });

  it("新尺子照样把数字归一——否则订单簿每秒都在造新状态", () => {
    const f = ABSTRACTIONS["route+controls+state/norm"]!;
    const a = { url: "/x", controls: [], states: ["div: 78,131.7#cls:active"] };
    const b = { url: "/x", controls: [], states: ["div: 78,142.0#cls:active"] };
    expect(f(a)).toBe(f(b));
  });

  it("没给 states 时退回只看 controls，老调用方行为不变", () => {
    const f = ABSTRACTIONS["route+controls+state/norm"]!;
    const g = ABSTRACTIONS["route+controls/norm"]!;
    const s = { url: "/x", controls: ["a: 首页", "button: 提交"] };
    expect(f(s)).toBe(g(s));
  });

  /**
   * 这一条钉的是一个正在发生的谎：挑函数时回落到 `route+controls/norm`，
   * 写进图的却是 `route+controls`。一张说不出自己用了哪把尺子的图，没法和另一张比较。
   */
  it("图上记的抽象名字必须是实际生效的那一个", () => {
    expect(abstractionNameOf(undefined)).toBe(DEFAULT_ABSTRACTION);
    expect(abstractionNameOf(undefined)).toBe("route+controls/norm");
    expect(abstractionNameOf("不存在的尺子")).toBe(DEFAULT_ABSTRACTION);
    expect(abstractionNameOf("route+controls+state/norm")).toBe("route+controls+state/norm");
  });
});
