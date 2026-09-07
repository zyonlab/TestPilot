import { describe, expect, it } from "vitest";
import { computeFlows, computeModules, describeFlows } from "../src/exec/flows.js";
import type { StateFlowGraph } from "../src/exec/sfg.js";

/**
 * 流程是**算**出来的，不是推断出来的。
 *
 * 「从入口到终点有哪些路径」是图算法。交给模型等于把一个确定性问题变成会漏、会编、
 * 不可复现的问题——而这条流水线反复用同一条原则：能查出来的不要问模型。
 * 模型在这一层只负责命名。
 */

const edge = (from: string, to: string | undefined, target: string, ok = true) => ({
  from,
  ...(to ? { to } : {}),
  action: { kind: "click" as const, target, selector: "" },
  ok,
  walked: true,
});

/** 一张缩小版的 SauceDemo：登录 → 列表 →（详情｜购物车 → 结账）。 */
const shop: StateFlowGraph = {
  abstraction: "route+controls",
  collector: "tags-only/v1",
  plan: { asked: false, business: "", stories: [] },
  entry: "/",
  stoppedBecause: "",
  unvisited: [],
  states: [
    { id: "/", route: "/", title: "登录", controls: [] },
    { id: "/inventory.html", route: "/inventory.html", title: "Products", controls: [] },
    { id: "/inventory-item.html", route: "/inventory-item.html", title: "详情", controls: [] },
    { id: "/cart.html", route: "/cart.html", title: "Your Cart", controls: [] },
    { id: "/checkout-step-one.html", route: "/checkout-step-one.html", title: "结账", controls: [] },
  ],
  transitions: [
    { from: "/", to: "/inventory.html", action: { kind: "login", target: "登录表单", selector: "" }, ok: true, walked: true },
    edge("/inventory.html", "/inventory-item.html", "商品名"),
    edge("/inventory.html", "/cart.html", "购物车"),
    edge("/cart.html", "/checkout-step-one.html", "Checkout"),
  ],
};

describe("computeFlows", () => {
  const { flows } = computeFlows(shop);

  /**
   * 契约在 2026-08-27 换过一次，换的理由值得记在这里。
   *
   * 第一版是深度优先、**只在走不下去时才记一条流程**，于是每条流程都是一条最长链。
   * SauceDemo 那种近似线性的应用上看不出问题；PetClinic 立刻现形——它每页都有全局导航栏，
   * 图几乎全连通，DFS 产出的是**遍历顺序**而不是流程：
   * 「从入口经多屏跳转至编辑主人信息：/owners/find → /vets → /oups → /vets.xml → …」
   * 那串路径每一段都真实存在，但它不是任何人会走的路。
   *
   * 现在是广度优先：**每个可达状态都是一个终点，路径取最短**。一条流程要回答的是
   * 「怎么最快到这里」。
   */
  it("每个可达状态都是一个终点", () => {
    expect(flows.map((f) => f.endsAt).sort()).toEqual([
      "/cart.html",
      "/checkout-step-one.html",
      "/inventory-item.html",
      "/inventory.html",
    ]);
  });

  it("每条路径都是最短的那条", () => {
    const checkout = flows.find((f) => f.endsAt === "/checkout-step-one.html")!;
    expect(checkout.steps).toHaveLength(3);
  });

  it("每条流程带着走过去的动作序列——**那就是用例的步骤**", () => {
    const checkout = flows.find((f) => f.endsAt === "/checkout-step-one.html")!;
    expect(checkout.steps.map((s) => s.how)).toEqual(["登录", "点「购物车」", "点「Checkout」"]);
  });

  it("记下涉及的路由，供归模块", () => {
    const checkout = flows.find((f) => f.endsAt === "/checkout-step-one.html")!;
    expect(checkout.routes).toContain("/cart.html");
  });

  it("原地不动的边不推进流程", () => {
    // 否则同一条流程会出现无数个只差几次空点击的变体。
    const withSelfLoop: StateFlowGraph = {
      ...shop,
      transitions: [...shop.transitions, edge("/cart.html", "/cart.html", "购物车图标")],
    };
    const before = computeFlows(shop).flows.length;
    expect(computeFlows(withSelfLoop).flows).toHaveLength(before);
  });

  it("走不通的边不推进流程，但它在图里仍然留着", () => {
    const withFailure: StateFlowGraph = {
      ...shop,
      transitions: [...shop.transitions, edge("/checkout-step-one.html", undefined, "Continue", false)],
    };
    const f = computeFlows(withFailure).flows.find((x) => x.endsAt === "/checkout-step-one.html")!;
    expect(f.steps.at(-1)!.how).toBe("点「Checkout」");
  });

  it("环不会让它转不出来", () => {
    const cyclic: StateFlowGraph = {
      ...shop,
      transitions: [...shop.transitions, edge("/cart.html", "/inventory.html", "Continue Shopping")],
    };
    const { flows: f } = computeFlows(cyclic, { maxDepth: 6 });
    expect(f.length).toBeGreaterThan(0);
    for (const x of f) expect(new Set(x.path).size).toBe(x.path.length);
  });

  it("条数超限要说出来，不静默丢弃", () => {
    const wide: StateFlowGraph = {
      ...shop,
      transitions: [
        ...shop.transitions,
        ...Array.from({ length: 60 }, (_, i) => edge("/inventory.html", `/p${i}`, `商品${i}`)),
      ],
      states: [...shop.states, ...Array.from({ length: 60 }, (_, i) => ({ id: `/p${i}`, route: `/p${i}`, title: "", controls: [] }))],
    };
    const { flows: f, truncated } = computeFlows(wide, { maxFlows: 10 });
    expect(f.length).toBeLessThanOrEqual(10);
    expect(truncated).toBe(true);
  });
});

describe("computeModules", () => {
  it("按路由前缀确定性聚类，不问模型", () => {
    const { flows } = computeFlows(shop);
    const mods = computeModules(shop, flows);
    const ids = mods.map((m) => m.id);
    expect(ids).toContain("checkout");
    expect(ids).toContain("cart");
    // inventory.html 与 inventory-item.html 是同一段前缀，归一组。
    const inv = mods.find((m) => m.id === "inventory")!;
    expect(inv.routes.sort()).toEqual(["/inventory-item.html", "/inventory.html"]);
  });

  it("流程归到**终点**所在的模块——流程是以「做完了什么」命名的", () => {
    const { flows } = computeFlows(shop);
    const mods = computeModules(shop, flows);
    expect(mods.find((m) => m.id === "checkout")!.flowIds.length).toBe(1);
  });
});

describe("describeFlows", () => {
  it("给模型的是结构，不是页面正文", () => {
    const { flows, truncated } = computeFlows(shop);
    const text = describeFlows(flows, computeModules(shop, flows), truncated);
    expect(text).toContain("登录 → 点「购物车」 → 点「Checkout」");
    expect(text).toContain("模块（按路由前缀聚类）");
  });
});

/**
 * 同终点收敛。
 *
 * 到同一个地方常有好几条路——绕不绕商品详情页都能进结账。全列出来，骨架上就是一堆只差
 * 几步的近似重复，人读不下去；全丢掉，又等于说这个产品只有一条路。取最短的为主、
 * 其余记个数：信息不丢，列表能看。
 */
describe("collapsing near-duplicate paths", () => {
  const twoWays: StateFlowGraph = {
    ...shop,
    transitions: [...shop.transitions, edge("/inventory-item.html", "/cart.html", "购物车")],
  };

  it("同一个终点只出一条流程", () => {
    const { flows } = computeFlows(twoWays);
    expect(flows.filter((f) => f.endsAt === "/checkout-step-one.html")).toHaveLength(1);
  });

  it("到同一个地方还有别的走法时，记个数而不是再列一条", () => {
    // 全都列出来，骨架上就是一堆只差几步的近似重复，人读不下去；全丢掉，
    // 又等于说这个产品只有一条路。
    const { flows } = computeFlows(twoWays);
    // 商品详情页也能进购物车 —— 购物车因此有第二条走法。
    expect(flows.find((f) => f.endsAt === "/cart.html")!.variants).toBeGreaterThan(0);
  });

  it("主流程取最短的那条", () => {
    const { flows } = computeFlows(twoWays);
    const f = flows.find((x) => x.endsAt === "/checkout-step-one.html")!;
    // 直接从列表进购物车，而不是绕商品详情页。
    expect(f.steps.map((s) => s.how)).toEqual(["登录", "点「购物车」", "点「Checkout」"]);
  });

  it("只换了页内状态的终点被标出来，并排在换了路由的后面", () => {
    // 打开一个抽屉不是「做完了一件事」。不过滤掉——它仍是可达状态、仍要算覆盖——只是标出来。
    const withDrawer: StateFlowGraph = {
      ...shop,
      states: [...shop.states, { id: "/cart.html~1", route: "/cart.html", title: "", controls: [] }],
      transitions: [...shop.transitions, edge("/cart.html", "/cart.html~1", "Open Menu")],
    };
    const { flows } = computeFlows(withDrawer);
    const drawer = flows.find((f) => f.endsAt === "/cart.html~1")!;
    expect(drawer.inPage).toBe(true);
    const checkout = flows.find((f) => f.endsAt === "/checkout-step-one.html")!;
    // 换了路由的排前面。
    expect(flows.indexOf(checkout)).toBeLessThan(flows.indexOf(drawer));
  });
});
