import { describe, expect, it } from "vitest";
import { scoreStructural, transitionId, type StructuralModel } from "../src/eval/structural.js";

/**
 * 结构覆盖率的意义在于**分母来自产品本身**。
 *
 * 语义覆盖问「测的是不是该测的东西」，分母是人手抽的清单——它永远回答不了「够不够」，
 * 因为清单有多全没人说得清。转移图给的分母是走出来的：一共 M 条转移，覆盖了几条。
 *
 * 但它不是北极星：实证结论是代码覆盖与缺陷发现能力**弱相关**，所以它与语义覆盖、
 * 缺陷检出三个数并排，谁也不取代谁。
 */
const model: StructuralModel = {
  states: [{ id: "/" }, { id: "/inv" }, { id: "/cart" }, { id: "/checkout" }],
  transitions: [
    { from: "/", to: "/inv", ok: true, action: { kind: "login", target: "登录" } },
    { from: "/inv", to: "/cart", ok: true, action: { kind: "click", target: "购物车" } },
    { from: "/cart", to: "/checkout", ok: true, action: { kind: "click", target: "Checkout" } },
    // 走不通的边：记在图里是为了说明「这条路走不过去」，不该进分母。
    { from: "/checkout", ok: false, action: { kind: "click", target: "Finish" } },
  ],
};

describe("structural coverage", () => {
  it("走不通的边不进分母——否则覆盖率永远到不了 1，而那个缺口说明不了用例的任何事", () => {
    const r = scoreStructural(model, [{ covers: ["/->/inv", "/inv->/cart", "/cart->/checkout"] }]);
    expect(r.totals.transitions).toBe(3);
    expect(r.transitionCoverage).toBe(1);
  });

  it("0-switch：覆盖的转移 ÷ 走得通的转移", () => {
    const r = scoreStructural(model, [{ covers: ["/->/inv"] }]);
    expect(r.transitionCoverage).toBeCloseTo(1 / 3, 3);
  });

  it("1-switch：相邻转移对都走过才算", () => {
    const one = scoreStructural(model, [{ covers: ["/->/inv"] }]);
    expect(one.pairCoverage).toBe(0);
    const two = scoreStructural(model, [{ covers: ["/->/inv", "/inv->/cart"] }]);
    // 两条相邻的边都覆盖了，它们组成的那一对才算覆盖。
    expect(two.pairCoverage).toBeGreaterThan(0);
  });

  it("**没被覆盖的转移要列出来**——它们是查得出来的洞", () => {
    const r = scoreStructural(model, [{ covers: ["/->/inv"] }]);
    expect(r.uncovered).toEqual(["/cart->/checkout", "/inv->/cart"]);
  });

  it("一条转移都说不出的用例单独计数——它没在验证一次变化", () => {
    const r = scoreStructural(model, [{ id: "c1", covers: [] }, { id: "c2", covers: ["/->/inv"] }]);
    expect(r.silent).toBe(1);
  });

  it("声称覆盖一条图上没有的转移，不算数", () => {
    // 否则用例只要写一句「我覆盖了下单流程」，覆盖率就能刷到 1。
    const r = scoreStructural(model, [{ covers: ["/->/nowhere"] }]);
    expect(r.transitionCoverage).toBe(0);
    expect(r.silent).toBe(1);
  });

  it("状态覆盖跟着被覆盖的转移走", () => {
    const r = scoreStructural(model, [{ covers: ["/->/inv"] }]);
    expect(r.stateCoverage).toBe(0.5);
  });

  it("空图不崩，返回 0 而不是 NaN", () => {
    const r = scoreStructural({ states: [], transitions: [] }, []);
    expect(r.transitionCoverage).toBe(0);
    expect(r.stateCoverage).toBe(0);
  });

  it("转移 id 是稳定的", () => {
    expect(transitionId({ from: "/a", to: "/b" })).toBe("/a->/b");
  });
});
