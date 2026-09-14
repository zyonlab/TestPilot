import { describe, expect, it } from "vitest";
import { normalizeCase, normalizeOracle } from "../src/casegen/normalizeOracle.js";
import { MachineOracleSchema } from "../src/exec/oracle.js";

describe("normalizeOracle（扁平全必填 schema → zod 的形状）", () => {
  it("text 带占位符 → 只剩 kind/value，zod 过", () => {
    const o = normalizeOracle({ kind: "text", value: "Order price cannot be more than 80% away", op: "eq", url: "-", method: "GET", body: "-", path: "-", settleMs: 0 });
    expect(o).toEqual({ kind: "text", value: "Order price cannot be more than 80% away" });
    expect(MachineOracleSchema.safeParse(o).success).toBe(true);
  });
  it("api 完整保留，占位 body 去掉，值仍是字符串（比较时 sameValue 会转数）", () => {
    const o = normalizeOracle({ kind: "api", value: "0.001", op: "eq", url: "${env.INFO_URL}", method: "POST", body: "-", path: "assetPositions[position.coin=BTC].position.szi", settleMs: 2500 });
    expect(o).toEqual({ kind: "api", url: "${env.INFO_URL}", method: "POST", path: "assetPositions[position.coin=BTC].position.szi", op: "eq", value: "0.001", settleMs: 2500 });
    expect(MachineOracleSchema.safeParse(o).success).toBe(true);
  });
  it("count 留 op 与 n；delta 留 direction；none → 没有 oracle", () => {
    expect(normalizeOracle({ kind: "count", value: "row", op: "gte", n: 3, url: "-", method: "GET", path: "-", settleMs: 0 })).toEqual({ kind: "count", value: "row", op: "gte", n: 3 });
    expect(normalizeOracle({ kind: "delta", value: "Balance", direction: "decreased", by: 0, url: "-", method: "GET", path: "-", op: "eq", settleMs: 0 })).toEqual({ kind: "delta", value: "Balance", direction: "decreased" });
    expect(normalizeCase({ title: "t", tier: 3, oracle: { kind: "none", value: "-", url: "-", method: "GET", path: "-", op: "eq", settleMs: 0 } })).toEqual({ title: "t", tier: 3 });
  });
});

import { SpecRuleSchema } from "../src/casegen/types.js";
describe("规格规则的可选字段：null 与没给同义（2026-09-08 runinfra）", () => {
  it("about / altitude / source 为 null 时通过，解析成 undefined", () => {
    const r = SpecRuleSchema.parse({ id: "R-1", text: "t", evidence: "e", about: null, altitude: null, source: null });
    expect(r.about).toBeUndefined();
    expect(r.altitude).toBeUndefined();
  });
});
