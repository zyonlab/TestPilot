import { expect, it } from "vitest";
import { scopedCacheId, structureOf } from "../src/exec/cache.js";

/**
 * 缓存回放绑在「这条用例 + 它的上下文 + 首屏结构」上。
 * 2026-09-14 之前绑的是整份 DOM 与截图哈希——在实时行情页上那两样每秒都变，
 * 缓存几乎必然不命中（实测 47 → 28 次调用，而命中的三条是撞在骨架期的运气）。
 */
it("键绑在模型、意图、地址与首屏结构上", () => {
  const page = { url: "https://fixture.test", structure: "struct-a" };
  const ctx = { model: "m1", intent: "revision1" };
  const first = scopedCacheId("c1", ctx, page);
  // 上下文只看内容不看键序。
  expect(first).toBe(scopedCacheId("c1", { intent: "revision1", model: "m1" }, page));
  for (const changed of [{ ...page, url: page.url + "/v2" }, { ...page, structure: "struct-b" }])
    expect(scopedCacheId("c1", ctx, changed)).not.toBe(first);
  expect(scopedCacheId("c1", { ...ctx, model: "m2" }, page)).not.toBe(first);
  expect(scopedCacheId("c1", { ...ctx, intent: "revision2" }, page)).not.toBe(first);
  expect(scopedCacheId(undefined, ctx, page)).toBeUndefined();
});

/**
 * 结构指纹的两条性质，直接决定缓存有没有用：
 *   价格跳动不该让它变（否则永远不命中），控件增删必须让它变（否则照着点不存在的东西）。
 */
it("数字在变、控件没变 → 指纹不变；控件变了 → 指纹变", () => {
  const price = { tag: "SPAN", label: "2475.20" };
  void price; // 正文不是控件，本来就不进指纹
  const a = structureOf([{ tag: "BUTTON", label: "Positions (1)" }, { tag: "BUTTON", label: "Buy / Long" }]);
  const b = structureOf([{ tag: "BUTTON", label: "Positions (7)" }, { tag: "BUTTON", label: "Buy / Long" }]);
  expect(b, "数字变了，指纹不该变").toBe(a);

  const c = structureOf([{ tag: "BUTTON", label: "Positions (1)" }, { tag: "BUTTON", label: "Buy / Long" }, { tag: "BUTTON", label: "Close All" }]);
  expect(c, "多了一个控件，指纹必须变").not.toBe(a);

  const d = structureOf([{ tag: "BUTTON", label: "Buy / Long" }]);
  expect(d, "少了一个控件，指纹必须变").not.toBe(a);

  const e = structureOf([{ tag: "BUTTON", role: "tab", label: "Positions (1)" }, { tag: "BUTTON", label: "Buy / Long" }]);
  expect(e, "角色变了，指纹必须变").not.toBe(a);

  // DOM 顺序抖动不算变化——排序就是为了这个。
  expect(structureOf([{ tag: "BUTTON", label: "Buy / Long" }, { tag: "BUTTON", label: "Positions (1)" }])).toBe(a);
});

it("标签过长时截断，但截断点之前的差异仍然区分得开", () => {
  const long = (suffix: string) => structureOf([{ tag: "BUTTON", label: "A".repeat(40) + suffix }]);
  expect(long("X")).not.toBe(long("Y"));
  expect(structureOf([{ tag: "BUTTON", label: "A".repeat(80) }])).toBe(structureOf([{ tag: "BUTTON", label: "A".repeat(60) }]));
});

/**
 * 采不到结构就不缓存——而不是带垮这次执行，也不是退回一个凑合的键。
 *
 * 2026-09-15：给缓存键加结构指纹之后，本机四条 runner 测试全绿，CI 上三条红，
 * 其中一条正是「导航还没完成就取消」。页面正在导航时执行上下文已经销毁，
 * `page.evaluate` 会抛；CI 慢，正好撞进那个窗口。
 *
 * 这里钉的是那条判断本身：`structure` 没拿到，就没有 cacheId。
 */
it("结构采不到就没有缓存键——宁可这次不缓存，也不拿别的屏的计划来用", () => {
  const ctx = { model: "m1", intent: "r1" };
  expect(scopedCacheId(undefined, ctx, { url: "https://x.test", structure: "s" })).toBeUndefined();
  // 键的三个输入任意一个变了就是另一个键；没有「差不多就算命中」这回事。
  const base = scopedCacheId("c1", ctx, { url: "https://x.test", structure: "s" });
  expect(scopedCacheId("c2", ctx, { url: "https://x.test", structure: "s" })).not.toBe(base);
});
