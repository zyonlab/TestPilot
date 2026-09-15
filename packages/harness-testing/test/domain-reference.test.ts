import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ABLATABLE, FakeModel } from "@testpilot/harness-core";
import { CASES_SCHEMA, ORACLE_STRICT, domainReferenceBlock } from "../src/casegen/prompts.js";
import { designCasesNode } from "../src/casegen/nodes.js";
import { MachineOracleSchema } from "../src/exec/oracle.js";
import { runGate } from "../src/casegen/gate.js";

/**
 * 领域参考是**这次运行绑定的项目数据**，不是代码里的一段。
 * 钉三件事：没绑定就没有领域段；绑定了就只多出那一段；消融开关只去掉那一段。
 */
const DATASET = resolve(__dirname, "../../../benchmark/hyperliquid-testnet/domain-reference.md");
const bundle = {
  origin: "docs/a.md",
  specText: "一个页面：列表 / 新建按钮。",
  stories: [{ id: "US-01", title: "新建一条", acceptance: ["AC-01.1 列表多出一行"] }],
};
const reply = JSON.stringify({
  cases: [{ title: "新建一条", designMethod: "equivalence", steps: ["点击新建"], expected: "列表多出一行", tier: 1, oracle: { kind: "text", value: "一行" }, key: "k", covers: [] }],
});
const ctxOf = (ablated: Set<string>) => ({ nodeId: "design", ablated, spend: () => {}, emit: () => {}, signal: new AbortController().signal });
const params = (extra: Record<string, unknown> = {}) => ({ contextTokens: 8000, perStoryMaxTokens: 6000, maxCasesPerStory: 8, oracleGuidance: "default", ...extra });
const stableOf = async (p: Record<string, unknown>, ablated = new Set<string>()) => {
  const m = new FakeModel(() => reply);
  await designCasesNode({ model: m }).run(bundle as never, p as never, ctxOf(ablated) as never);
  return m.calls[0].stable as string;
};

describe("领域参考（domain-reference）", () => {
  it("没绑定就没有领域段——代码不替任何产品补一段", async () => {
    const plain = await stableOf(params());
    expect(plain).not.toContain("DOMAIN REFERENCE");
    expect(plain).not.toMatch(/perpetual|funding|leverage/i);
  });

  it("绑定了就只多出那一段；ablate domain-reference 去掉的也只是那一段", async () => {
    const text = "列表里的每一行都要显示创建时间。";
    const plain = await stableOf(params());
    const on = await stableOf(params({ domainReference: text }));
    const off = await stableOf(params({ domainReference: text }), new Set([ABLATABLE.domainReference]));
    expect(on).toBe(plain + domainReferenceBlock(text));
    expect(off).toBe(plain);
  });

  it("按路径绑定（评测臂用）读的是同一份文件", async () => {
    const byPath = await stableOf(params({ domainReferencePath: DATASET }));
    expect(byPath).toContain(domainReferenceBlock(readFileSync(DATASET, "utf8")));
  });

  it("评测数据集里每条示例判据都合法、没有一条问接口、没有一条钉在易变读数上", () => {
    const md = readFileSync(DATASET, "utf8");
    const examples = [...md.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]!) as { expected: string; oracle: unknown });
    expect(examples.length).toBeGreaterThanOrEqual(4);
    for (const ex of examples) expect(MachineOracleSchema.safeParse(ex.oracle).success).toBe(true);
    expect(examples.map((e) => (e.oracle as { kind: string }).kind)).not.toContain("api");
    const cases = examples.map((e, i) => ({ id: `R-${i + 1}`, storyId: "S-1", title: `R-${i + 1}`, steps: ["do"], expected: e.expected, tier: 1, covers: [] }));
    const report = runGate({ stories: [{ id: "S-1", title: "s", acceptance: ["x"] }], cases } as never);
    expect(report.findings.filter((f) => f.rule === "oracle-volatile")).toEqual([]);
  });

  it("ORACLE_STRICT 教的是「判决从屏幕读」；受限解码的枚举里没有 api，其余每一种 kind 都在", () => {
    expect(ORACLE_STRICT).not.toContain('"kind":"api"');
    expect(ORACLE_STRICT).toContain("THE VERDICT IS READ FROM THE SCREEN");
    const oracle = (CASES_SCHEMA as unknown as { properties: { cases: { items: { properties: { oracle: { properties: Record<string, { enum?: readonly string[] }> } } } } } }).properties.cases.items.properties.oracle;
    expect(oracle.properties.kind.enum).not.toContain("api");
    for (const k of MachineOracleSchema.options.map((o) => o.shape.kind.value).filter((k) => k !== "api")) expect(oracle.properties.kind.enum).toContain(k);
  });
});
