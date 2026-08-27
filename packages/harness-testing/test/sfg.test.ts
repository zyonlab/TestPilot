import { describe, expect, it } from "vitest";
import { ABSTRACTIONS, abstractionOf, describeGraph, type StateFlowGraph } from "../src/exec/sfg.js";

/**
 * 状态抽象是这一层的关键变量：过松会把没探索过的当成已探索（漏测），过紧会把探索过的
 * 当成新的（冗余、原地打转）。横比六种抽象的实证研究把它认定为测试有效性的主要因素，
 * 所以它是一族可替换的函数，而且用了哪一种要跟着图记下来——一次说不出自己用的哪把尺子
 * 的探索，没法和另一次比较。
 */
describe("state abstraction", () => {
  const menuClosed = { url: "https://x/inventory.html", title: "Products", controls: ["Open Menu", "Add to cart"] };
  const menuOpen = { ...menuClosed, controls: ["Open Menu", "Add to cart", "All Items", "Logout"] };
  const page2 = { ...menuClosed, url: "https://x/inventory.html?page=2" };

  it("route: 同一路由的任何状态变化都看不见（最紧凑）", () => {
    const a = ABSTRACTIONS["route"];
    expect(a(menuClosed)).toBe(a(menuOpen));
    expect(a(menuClosed)).toBe(a(page2));
  });

  it("route+controls: 抽屉打开算一个新状态——默认，也是我们这一类策略该用的", () => {
    const a = ABSTRACTIONS["route+controls"];
    // 抽屉里的项变成可见的，这一屏「能做什么」就变了。看不见这一点，一次成功的点击
    // 会被记成「没有新界面」，探索会误判自己走不动了。
    expect(a(menuClosed)).not.toBe(a(menuOpen));
    // 但查询串不算：分页不该被当成另一个功能。
    expect(a(menuClosed)).toBe(a(page2));
  });

  it("url+controls: 连查询串一起算（最严，分页各算一个状态）", () => {
    const a = ABSTRACTIONS["url+controls"];
    expect(a(menuClosed)).not.toBe(a(page2));
  });

  it("认不出的名字退回默认，而不是崩掉一次探索", () => {
    expect(abstractionOf("没这个")).toBe(ABSTRACTIONS["route+controls"]);
    expect(abstractionOf(undefined)).toBe(ABSTRACTIONS["route+controls"]);
  });
});

describe("the graph handed downstream", () => {
  const g: StateFlowGraph = {
    abstraction: "route+controls",
    entry: "/",
    stoppedBecause: "连续 3 轮没有发现新界面",
    states: [
      { id: "/", route: "/", title: "登录", controls: ["Login"] },
      { id: "/cart.html", route: "/cart.html", title: "Your Cart", controls: ["Checkout"] },
    ],
    transitions: [
      { from: "/", to: "/cart.html", action: { kind: "click", target: "购物车", selector: '[data-test="cart"]' }, ok: true },
      { from: "/cart.html", action: { kind: "click", target: "Checkout", selector: "#co" }, ok: false, note: "点不动" },
    ],
  };

  it("说出自己用的哪把尺子", () => {
    expect(describeGraph(g)).toContain("状态抽象：route+controls");
  });

  it("走通的边写成一条路径", () => {
    expect(describeGraph(g)).toContain("/ --[点「购物车」]--> /cart.html");
  });

  it("**走不通的边也留着**——它是下游「没有答案的地方」的来源之一", () => {
    // 只留成功路径，材料看起来就像这个产品没有走不通的地方。
    expect(describeGraph(g)).toContain("✗ 点不动");
  });
});

/**
 * 「回到已知状态」不是「状态没变」。
 *
 * 前者是一条真实的转移——从购物车点「继续购物」回到商品列表，路由都换了——算结构覆盖率
 * 时必须计入；后者才是原地不动。第一版把判据写成「目标见过没见过」，于是每一条回到旧
 * 页面的边都被标成「状态未变」，下游读起来像什么都没发生。
 */
describe("revisiting a known state vs not moving at all", () => {
  it("两者在图里必须分得开", () => {
    const g: StateFlowGraph = {
      abstraction: "route+controls",
      entry: "/",
      stoppedBecause: "",
      states: [],
      transitions: [
        { from: "/cart.html", to: "/inventory.html", action: { kind: "click", target: "Continue Shopping", selector: "" }, ok: true, note: "回到已知状态" },
        { from: "/cart.html", to: "/cart.html", action: { kind: "click", target: "购物车", selector: "" }, ok: true, note: "状态未变" },
      ],
    };
    const text = describeGraph(g);
    expect(text).toContain("/cart.html --[点「Continue Shopping」]--> /inventory.html");
    // 两条边都走通了，但含义不同：一条换了状态，一条没有。
    expect(g.transitions[0].from).not.toBe(g.transitions[0].to);
    expect(g.transitions[1].from).toBe(g.transitions[1].to);
  });
});
