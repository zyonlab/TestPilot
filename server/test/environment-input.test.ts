import { describe, expect, it } from "vitest";
import { environmentPatch } from "../src/environmentInput.js";

/**
 * 2026-09-16 真实数据损坏：只发 `{name, vars}` 去给 Vikunja 加两个变量，
 * 这个被测对象的地址与三步登录流程当场被清空，接口还回 200。
 * 根因是路由把缺席的字段补成空值，`upsertEnvironment` 的「没给就沿用已存的」永远轮不到。
 */
describe("环境保存：没说的字段不出现在 patch 里", () => {
  it("只给变量时，地址、登录、默认标记都不在 patch 里", () => {
    const patch = environmentPatch({ vars: { A: "1" } });
    expect(patch).toEqual({ vars: { A: "1" } });
    expect("baseUrl" in patch).toBe(false);
    expect("login" in patch).toBe(false);
    expect("isDefault" in patch).toBe(false);
  });

  it("显式发空值才是置空", () => {
    expect(environmentPatch({ baseUrl: "" })).toMatchObject({ baseUrl: "" });
    expect(environmentPatch({ login: {} })).toMatchObject({ login: {} });
    expect(environmentPatch({ isDefault: false })).toMatchObject({ isDefault: false });
  });

  it("视口只收合法的数，视觉阈值的 0 有意义", () => {
    expect("viewport" in environmentPatch({ viewport: {} })).toBe(false);
    expect("viewport" in environmentPatch({ viewport: "1024x720" })).toBe(false);
    expect(environmentPatch({ viewport: { width: "1440.4", height: 900 } })).toMatchObject({ viewport: { width: 1440, height: 900 } });
    expect(environmentPatch({ visualThresholdPct: 0 })).toMatchObject({ visualThresholdPct: 0 });
    expect("visualThresholdPct" in environmentPatch({ visualThresholdPct: 101 })).toBe(false);
  });

  it("环境画像：给了才带，前提名去空白", () => {
    expect(environmentPatch({ capabilities: [" session ", "", "wallet"], injectWallet: true }))
      .toMatchObject({ capabilities: ["session", "wallet"], injectWallet: true });
    expect(environmentPatch({ name: "x" } as never)).toEqual({});
  });
});
