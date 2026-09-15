import { describe, expect, it } from "vitest";
import { charterFromRulePack, routeAllowed, validateRulePack } from "../src/domain/index.js";

/**
 * 2026-09-15 Vikunja 带规则包探索：登录后 7 屏全停在 `/`，`/projects` `/labels` `/teams` 一个没去。
 * charter 的路由门禁只认 `scope.routes`，而建 charter 时从来不传——「只在入口路由上工作」
 * 对每个产品都成立。那是给业务全在一页里的交易页定的默认，多页应用被关在门口。
 */
const packFor = (urlPatterns: string[]) => {
  const v = validateRulePack({
    schemaVersion: "product-rule-pack.v1", id: "scope-rules", version: "1", domain: "d", product: "P",
    network: "local", accountMode: "password",
    appliesTo: { urlPatterns, note: "" },
    externalCapabilities: ["session"],
    sources: [{ id: "SRC-1", kind: "observation", locator: "x", fetchedAt: "2026-09-15", note: "" }],
    modules: [{ id: "m", name: "m", parentId: null }],
    features: [{ id: "m.f", moduleId: "m", name: "f", description: "", applicability: "applicable", applicabilitySourceRefs: ["SRC-1"] }],
    targets: [{ id: "T-1", featureId: "m.f", ruleRefs: [], match: { label: ["^新项目$"], roles: [], within: [] },
      action: "activate", sideEffect: "ui-only", requires: ["session"], provides: [] }],
  });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v;
};
const charterOf = (urlPatterns: string[], entryUrl: string) => {
  const v = packFor(urlPatterns);
  return charterFromRulePack(v.pack, v.hash, { entryUrl, maxScreens: 8 });
};

describe("charter 的路由范围来自规则包", () => {
  it("包里的 urlPatterns 原样进 charter", () => {
    expect(charterOf(["^http://localhost:3456/"], "http://localhost:3456/").scope.urlPatterns).toEqual(["^http://localhost:3456/"]);
  });

  it("多页应用：包覆盖整个站点，登录后的各页都能去", () => {
    const c = charterOf(["^http://localhost:3456/"], "http://localhost:3456/");
    for (const route of ["/projects", "/labels", "/teams", "/tasks/by/upcoming"])
      expect(routeAllowed(c, "/login", route, `http://localhost:3456${route}`), route).toBe(true);
    // 站外照样不去。
    expect(routeAllowed(c, "/login", "/", "http://other.test/")).toBe(false);
  });

  it("单页产品：包只圈一页，就只在那一页上工作——行为和以前一样", () => {
    const c = charterOf(["^https://trade\\.example/trade"], "https://trade.example/trade");
    expect(routeAllowed(c, "/trade", "/trade/ETH", "https://trade.example/trade/ETH")).toBe(true);
    expect(routeAllowed(c, "/trade", "/portfolio", "https://trade.example/portfolio")).toBe(false);
  });

  it("包没写范围、或调用方拿不到完整地址，都退回旧规则：只认入口路由", () => {
    const none = charterOf([], "http://localhost:3456/");
    expect(routeAllowed(none, "/login", "/projects", "http://localhost:3456/projects")).toBe(false);
    const scoped = charterOf(["^http://localhost:3456/"], "http://localhost:3456/");
    expect(routeAllowed(scoped, "/login", "/projects")).toBe(false);
    expect(routeAllowed(scoped, "/login", "/login")).toBe(true);
  });

  it("没有 charter 时不设门", () => {
    expect(routeAllowed(undefined, "/", "/anything", "http://x.test/anything")).toBe(true);
  });
});
