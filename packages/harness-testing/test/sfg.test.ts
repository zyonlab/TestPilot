import { describe, expect, it } from "vitest";
import { ABSTRACTIONS, abstractionOf, describeGraph, type StateFlowGraph, pathOf } from "../src/exec/sfg.js";
import { BAD_VALUES, LOOKUP_SUBMIT } from "../src/exec/interactive.js";

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
    expect(abstractionOf("没这个")).toBe(ABSTRACTIONS["route+controls/norm"]);
    expect(abstractionOf(undefined)).toBe(ABSTRACTIONS["route+controls/norm"]);
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
      { from: "/", to: "/cart.html", action: { kind: "click", target: "购物车", selector: '[data-test="cart"]' }, ok: true, walked: true },
      { from: "/cart.html", action: { kind: "click", target: "Checkout", selector: "#co" }, ok: false, walked: true, note: "点不动" },
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
        { from: "/cart.html", to: "/inventory.html", action: { kind: "click", target: "Continue Shopping", selector: "" }, ok: true, walked: true, note: "回到已知状态" },
        { from: "/cart.html", to: "/cart.html", action: { kind: "click", target: "购物车", selector: "" }, ok: true, walked: true, note: "状态未变" },
      ],
    };
    const text = describeGraph(g);
    expect(text).toContain("/cart.html --[点「Continue Shopping」]--> /inventory.html");
    // 两条边都走通了，但含义不同：一条换了状态，一条没有。
    expect(g.transitions[0].from).not.toBe(g.transitions[0].to);
    expect(g.transitions[1].from).toBe(g.transitions[1].to);
  });
});

/**
 * API 端点不是界面。
 *
 * PetClinic 的兽医列表页链到 `/vets.xml` 与 `/vets.json`——同一份数据的 API 表示，不是一屏。
 * 跟过去，图里就多两个「状态」，规格里就多两条关于 XML 的规则，而它们对界面测试毫无意义。
 * 判据用扩展名是因为它**查得出来**：一个 `.json` 结尾的地址不会是给人看的页面。
 */
describe("addresses that are not screens", () => {
  const NOT_A_SCREEN = /\.(json|xml|csv|pdf|zip|png|jpe?g|gif|svg|ico|txt|rss|atom)(\?|$)/i;

  it("认出数据端点", () => {
    for (const p of ["/vets.xml", "/vets.json", "/report.pdf", "/data.csv?page=2"])
      expect(NOT_A_SCREEN.test(p)).toBe(true);
  });

  it("不误伤正常页面", () => {
    for (const p of ["/owners/1/edit", "/vets", "/owners/find", "/inventory.html", "/checkout-step-one.html"])
      expect(NOT_A_SCREEN.test(p)).toBe(false);
  });
});

/**
 * 走过的边与只看见的边，图里要分得开。
 *
 * 探索按地址全局记「去过没去过」，所以一个页面只会被从某一处进入一次——图里因此只留下
 * 遍历实际走的那条边，**退化成一棵生成树**。PetClinic 每页都有全局导航栏，最短路径在
 * 生成树上算出来还是遍历顺序：「访问错误演示页：/owners/find → /vets → /oups」。
 *
 * 所以每一屏上看得见的链接都补成边。但要标出来：**确认了链接存在，没有确认它真的跳到
 * 那里**。两者混作一谈，图就在声称一些没验证过的事。
 */
describe("edges we walked vs edges we only saw", () => {
  const g: StateFlowGraph = {
    abstraction: "route+controls",
    entry: "/",
    stoppedBecause: "",
    states: [
      { id: "/", route: "/", title: "首页", controls: [] },
      { id: "/vets", route: "/vets", title: "兽医", controls: [] },
    ],
    transitions: [
      { from: "/", to: "/vets", action: { kind: "goto", target: "/vets", selector: "" }, ok: true, walked: true },
      { from: "/vets", to: "/", action: { kind: "goto", target: "/", selector: "" }, ok: true, walked: false },
    ],
  };

  it("只看见的边在摘要里标出来", () => {
    const text = describeGraph(g);
    expect(text).toContain("（未走过·仅见链接）");
  });

  it("走过的边不带那个标记", () => {
    const walked = describeGraph(g).split("\n").find((l) => l.includes("/ --[") && l.includes("/vets"))!;
    expect(walked).not.toContain("未走过");
  });
});

/**
 * 做实验：故意把表单空着提交。
 *
 * 遍历永远走不到校验状态——通往它们的边需要有人**故意**造一个坏输入。实测在 PetClinic 上，
 * 13 条黄金清单未覆盖的 7 条里有 5 条是这一类（必填校验、格式校验、搜不到的提示）。
 * 那不是「覆盖还不够高」，是黑盒遍历的**结构性缺口**。
 *
 * 只做最保守的一种：**空着提交**。它不需要知道任何字段该填什么，而绝大多数表单对空提交
 * 都有话说。填坏值（电话填字母、日期填昨天）需要知道字段语义，那是下一步的事。
 */
describe("probing a form on purpose", () => {
  const g: StateFlowGraph = {
    abstraction: "route+controls",
    entry: "/owners/new",
    stoppedBecause: "",
    states: [
      { id: "/owners/new", route: "/owners/new", title: "New Owner", controls: [] },
      { id: "/owners/new#1", route: "/owners/new", title: "New Owner", controls: [] },
    ],
    transitions: [
      {
        from: "/owners/new",
        to: "/owners/new#1",
        action: { kind: "probe", target: "Add Owner（空表单）", selector: "#submit", input: "" },
        ok: true,
        walked: true,
      },
    ],
  };

  it("在图里读得出这是一次实验，而不是一次普通点击", () => {
    expect(describeGraph(g)).toContain("空着提交「Add Owner」");
  });

  it("校验态是同一路由的另一个状态——路由没变，能做的事变了", () => {
    // 这正是 `route+controls` 这把尺子该抓住的：地址一样，屏幕不一样。
    expect(g.states[0].route).toBe(g.states[1].route);
    expect(g.states[0].id).not.toBe(g.states[1].id);
  });
});

describe("哈希路由（单页应用）", () => {
  it("`#/` 开头的哈希是路由的一部分", () => {
    const a = ABSTRACTIONS["route+controls"];
    const s = (url: string) => a({ url, controls: ["搜索"] });
    expect(s("http://x/#/search")).not.toBe(s("http://x/#/basket"));
    expect(s("http://x/#/search")).toBe(s("http://x/#/search"));
  });
  it("纯锚点不是路由——否则同页目录跳转会炸出假状态", () => {
    const a = ABSTRACTIONS["route+controls"];
    const s = (url: string) => a({ url, controls: ["搜索"] });
    expect(s("http://x/docs#intro")).toBe(s("http://x/docs#usage"));
  });
  it("整个购物站不会被压成一个路由", () => {
    const a = ABSTRACTIONS.route;
    const seen = new Set(
      ["/#/", "/#/search", "/#/basket", "/#/login", "/#/register"].map((p) =>
        a({ url: `http://x${p}`, controls: [] }),
      ),
    );
    expect(seen.size).toBe(5);
  });
  it("pathOf 去查询串但留哈希路由", () => {
    expect(pathOf("http://x/p?a=1#/x?b=2")).toBe("/p#/x");
    expect(pathOf("http://x/p?a=1")).toBe("/p");
  });
});

describe("角标数字不该炸出新状态", () => {
  const norm = ABSTRACTIONS["route+controls/norm"];
  const strict = ABSTRACTIONS["route+controls"];
  const cart = (n: number) => ({
    url: "http://x/#/search",
    controls: ["button: 加入购物车", `button: 购物车\n${n}`],
  });
  it("购物车从 0 加到 5，仍是同一个状态", () => {
    expect(new Set([0, 1, 2, 5].map((n) => norm(cart(n)))).size).toBe(1);
  });
  it("严格那把尺子照旧把它们算成四个——两把尺子都留着才能消融", () => {
    expect(new Set([0, 1, 2, 5].map((n) => strict(cart(n)))).size).toBe(4);
  });
  it("归一化的是数字不是控件：控件变了照样算新状态", () => {
    expect(norm(cart(0))).not.toBe(
      norm({ url: "http://x/#/search", controls: ["button: 结算", "button: 购物车\n0"] }),
    );
  });
  it("分页这种真的换了界面的，靠路由/查询串照样分得开", () => {
    const a = ABSTRACTIONS["url+controls"];
    expect(a({ url: "http://x/p?page=1", controls: ["下一页"] })).not.toBe(
      a({ url: "http://x/p?page=2", controls: ["下一页"] }),
    );
  });
});

describe("做实验的三个等价类", () => {
  it("坏值表覆盖每一种有格式的字段", () => {
    for (const k of ["email", "tel", "number", "password", "url", "date"]) {
      expect(BAD_VALUES[k]?.malformed).toBeTruthy();
      expect(BAD_VALUES[k]?.unmatched).toBeTruthy();
    }
  });
  it("纯文本没有「格式非法」——填什么都不算格式错", () => {
    expect(BAD_VALUES.text!.malformed).toBe("");
    expect(BAD_VALUES.text!.unmatched).toBeTruthy();
  });
  it("查不到的邮箱用 RFC 2606 保留域，永远解析不到真实主机", () => {
    expect(BAD_VALUES.email!.unmatched).toMatch(/\.invalid$/);
    expect(BAD_VALUES.url!.unmatched).toMatch(/\.invalid$/);
  });
  it("只有查询/登录表单允许「填查不到的值」——别的表单会真的写库", () => {
    for (const ok of ["Find Owner", "Search", "查找主人", "Log in", "登录", "Filter"])
      expect(LOOKUP_SUBMIT.test(ok)).toBe(true);
    for (const no of ["Add Owner", "Update Owner", "Register", "Submit", "保存", "新增宠物"])
      expect(LOOKUP_SUBMIT.test(no)).toBe(false);
  });
});
