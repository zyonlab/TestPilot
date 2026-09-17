import { it, expect } from "vitest";
import { locatorHints, pickLocator, locatorUsable } from "../src/exec/locators.js";

/**
 * 定位提示表（docs/v3/history/23 F-15）：探索知道每个控件的选择器，用例只带文案。
 * 这张表把两者接起来，而选择器不进用例——用例仍然是端无关的。
 */
const obs = (over: Record<string, unknown>) => ({
  id: "obs-1", targetId: "t", targetSpecId: "T-A", featureId: "f.a", status: "attempted",
  stateBefore: "/", controlsAfter: [], evidenceRefs: [], round: 1, ...over,
});

it("只收点击动作的文案与选择器，goto 与 probe 不进表", () => {
  const hints = locatorHints({ observations: [
    obs({ action: { kind: "click", target: "Balances", selector: "#tab-balances" } }),
    obs({ id: "obs-2", action: { kind: "goto", target: "/trade", selector: "" } }),
    obs({ id: "obs-3", action: { kind: "probe", target: "空提交", selector: "#submit" } }),
    obs({ id: "obs-4", action: { kind: "click", target: "", selector: "#nameless" } }),
    obs({ id: "obs-5", status: "observed_only" }),
  ] } as never);
  expect(hints).toEqual([{ label: "Balances", selector: "#tab-balances", featureId: "f.a" }]);
});

it("同一个文案取最后一次——那是最接近最终页面结构的一次", () => {
  const hints = locatorHints({ observations: [
    obs({ action: { kind: "click", target: "Cross", selector: "#old" } }),
    obs({ id: "obs-2", action: { kind: "click", target: "Cross", selector: "#new" } }),
  ] } as never);
  expect(hints).toHaveLength(1);
  expect(hints[0]!.selector).toBe("#new");
});

it("长文案排前面：执行侧按包含匹配，更具体的那个先被看到", () => {
  const hints = locatorHints({ observations: [
    obs({ action: { kind: "click", target: "Buy", selector: "#buy" } }),
    obs({ id: "obs-2", action: { kind: "click", target: "Buy / Long", selector: "#buy-long" } }),
  ] } as never);
  expect(hints.map((h) => h.label)).toEqual(["Buy / Long", "Buy"]);
});

it("只有会按下控件的动词才用提示；查看、填值都交给模型", () => {
  const hints = [{ label: "Balances", selector: "#tab" }];
  expect(pickLocator("在账户面板的标签行里点击 Balances", hints)?.selector).toBe("#tab");
  expect(pickLocator("click Balances in the tab row", hints)?.selector).toBe("#tab");
  expect(pickLocator("click the Balances tab", hints)?.selector).toBe("#tab");
  expect(pickLocator("勾选 Balances", hints)?.selector).toBe("#tab");
  expect(pickLocator("查看 Balances 区域的表头", hints)).toBeUndefined();
  expect(pickLocator("在数量输入里填入 1", hints)).toBeUndefined();
  expect(pickLocator("点击 Positions", hints)).toBeUndefined();
});

it("只看动词之后那一截——句子前半截说的是它在哪，不是点哪个", () => {
  const hints = [
    { label: "Order Book", selector: "#book" },
    { label: "Trades", selector: "#trades" },
    { label: "Market", selector: "#market" },
    { label: "Pro", selector: "#pro" },
  ];
  // 真跑里点错过的两句：取整句最长文案会点成 Order Book / Market。
  expect(pickLocator("在订单簿区域顶部的 Order Book / Trades 切换处点击 Trades", hints)?.selector).toBe("#trades");
  expect(pickLocator("在下单面板的 Market / Limit / Pro 一行里点击 Pro", hints)?.selector).toBe("#pro");
  // 动词之后没有认识的文案就交回模型，不猜。
  expect(pickLocator("点击页面左上角显示当前合约名的按钮，打开合约列表", hints)).toBeUndefined();
});

it("提示不唯一或文本已变就不用它——点错比没用上更难查", () => {
  expect(locatorUsable("Balances", 1, "Balances")).toEqual({ ok: true });
  expect(locatorUsable("Balances", 1, "  Balances  ")).toEqual({ ok: true });
  const many = locatorUsable("Balances", 13, "Balances");
  expect(many.ok).toBe(false);
  expect(many.ok === false && many.why).toContain("13");
  const stale = locatorUsable("Balances", 1, "Positions");
  expect(stale.ok).toBe(false);
  expect(stale.ok === false && stale.why).toContain("Positions");
  expect(locatorUsable("Balances", 0, "").ok).toBe(false);
});
