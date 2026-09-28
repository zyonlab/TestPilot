import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ABLATABLE, FakeModel } from "@testpilot/harness-core";
import { CASES_SCHEMA, ORACLE_STRICT, domainReferenceBlock } from "../src/casegen/prompts.js";
import { designCasesNode } from "../src/casegen/nodes.js";
import { MachineOracleSchema } from "../src/exec/oracle.js";

/**
 * 领域参考是**这次运行绑定的项目数据**，不是代码里的一段。
 * 钉三件事：没绑定就没有领域段；绑定了就只多出那一段；消融开关只去掉那一段。
 */
// 按路径绑定用的领域参考：临时写一份。原来读的 benchmark/hyperliquid-testnet/domain-reference.md 随旧数据集删了（2026-09-28，
// git 历史里还在）；现行领域参考是项目数据，示例在 examples/hyperliquid-testnet/domain-knowledge.md。
const DATASET = join(mkdtempSync(join(tmpdir(), "tp-domainref-")), "domain-reference.md");
writeFileSync(DATASET, "# 领域参考\n\n- 列表里的每一行都要显示创建时间。\n");
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

  it("ORACLE_STRICT 教的是「判决从屏幕读」；受限解码的枚举里没有 api，其余每一种 kind 都在", () => {
    expect(ORACLE_STRICT).not.toContain('"kind":"api"');
    expect(ORACLE_STRICT).toContain("THE VERDICT IS READ FROM THE SCREEN");
    const oracle = (CASES_SCHEMA as unknown as { properties: { cases: { items: { properties: { oracle: { properties: Record<string, { enum?: readonly string[] }> } } } } } }).properties.cases.items.properties.oracle;
    expect(oracle.properties.kind.enum).not.toContain("api");
    for (const k of MachineOracleSchema.options.map((o) => o.shape.kind.value).filter((k) => k !== "api")) expect(oracle.properties.kind.enum).toContain(k);
  });
});
