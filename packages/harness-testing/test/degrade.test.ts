import { describe, expect, it } from "vitest";
import { classifyDegrade } from "../src/codegen/degrade.js";

/** T-16：把判据改弱的「修复」要被叫出来；正当的改动不能误报。 */
const base = { id: "C-1", expected: "页面显示「Invalid username or password」", tier: 1 as const, oracle: { kind: "text" as const, value: "Invalid username or password" } };

describe("自愈退化", () => {
  it("text 判据改成空 / 去掉：degraded", () => {
    expect(classifyDegrade(base, { ...base, oracle: { kind: "text", value: "" } }).map((f) => f.kind)).toContain("oracle-weakened");
    expect(classifyDegrade(base, { ...base, oracle: undefined }).map((f) => f.kind)).toContain("oracle-removed");
  });
  it("api eq → exists、api → text、tier 1 → 3、expected 丢字面量、用例删除：各自被叫出来", () => {
    const api = { ...base, oracle: { kind: "api" as const, url: "${env.U}", method: "POST" as const, body: "{}", path: "a.b", op: "eq" as const, value: 1 } };
    expect(classifyDegrade(api, { ...api, oracle: { ...api.oracle, op: "exists", value: undefined } }).map((f) => f.kind)).toContain("oracle-weakened");
    expect(classifyDegrade(api, { ...api, oracle: { kind: "text", value: "ok" } }).map((f) => f.kind)).toContain("oracle-weakened");
    expect(classifyDegrade(base, { ...base, tier: 3 }).map((f) => f.kind)).toContain("tier-dropped");
    expect(classifyDegrade(base, { ...base, expected: "登录被拒绝" }).map((f) => f.kind)).toContain("expected-vague");
    expect(classifyDegrade(base, undefined).map((f) => f.kind)).toEqual(["case-removed"]);
  });
  it("正当的改动不报：换个更严的判据、改步骤文案、新增用例", () => {
    expect(classifyDegrade(base, { ...base, oracle: { kind: "api", url: "${env.U}", method: "POST", body: "{}", path: "a", op: "eq", value: 1 } })).toEqual([]);
    expect(classifyDegrade(base, { ...base, steps: [{ text: "点击 Sign in 按钮（右上角）" }] })).toEqual([]);
    expect(classifyDegrade(undefined, base)).toEqual([]);
  });
});
