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
