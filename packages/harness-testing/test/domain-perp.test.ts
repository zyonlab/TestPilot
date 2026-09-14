import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ABLATABLE, FakeModel } from "@testpilot/harness-core";
import { CASES_SCHEMA, DOMAIN_PERP, ORACLE_STRICT } from "../src/casegen/prompts.js";
import { designCasesNode } from "../src/casegen/nodes.js";
import { MachineOracleSchema } from "../src/exec/oracle.js";
import { runGate } from "../src/casegen/gate.js";

/**
 * 07 T-10 / T-13：领域 REFERENCE 是一臂——开关真的开关；文件里每条规则的判据示例合法、且没有一条钉在易变读数上。
 */
const REF = resolve(__dirname, "../../../plugins/testpilot/skills/testpilot-design/REFERENCE-domain-perp.md");

const bundle = {
  origin: "docs/a.md",
  specText: "合约交易页：下单面板 Size / Price / Leverage / Place Order。",
  stories: [{ id: "US-01", title: "市价开多", acceptance: ["AC-01.1 持仓量等于输入的数量"] }],
};
const reply = JSON.stringify({
  cases: [{ title: "市价开多 0.001", designMethod: "boundary", steps: ["输入 0.001", "点击 Place Order"], expected: "接口里 BTC 持仓的 szi 等于 0.001", tier: 1, oracle: { kind: "text", value: "0.001" }, key: "perp|open|0.001", covers: [] }],
});
const ctxOf = (ablated: Set<string>) => ({ nodeId: "design", ablated, spend: () => {}, emit: () => {}, signal: new AbortController().signal });
const params = { contextTokens: 8000, perStoryMaxTokens: 6000, maxCasesPerStory: 8, oracleGuidance: "default" };

describe("领域 REFERENCE 臂（domain-perp）", () => {
  it("默认带着那一段；ablate domain-perp 之后提示词里没有它——而且只差这一段", async () => {
    const on = new FakeModel(() => reply);
    await designCasesNode({ model: on }).run(bundle as never, params as never, ctxOf(new Set()) as never);
    const off = new FakeModel(() => reply);
    await designCasesNode({ model: off }).run(bundle as never, params as never, ctxOf(new Set([ABLATABLE.domainPerp])) as never);
    expect(on.calls[0].stable).toContain("PERPETUAL-FUTURES");
    expect(off.calls[0].stable).not.toContain("PERPETUAL-FUTURES");
    expect(on.calls[0].stable).toBe(off.calls[0].stable + DOMAIN_PERP);
  });

  it("REFERENCE-domain-perp.md 里每条示例判据都合法、每条规则都带示例", () => {
    const md = readFileSync(REF, "utf8");
    const rules = md.split("\n").filter((l) => /^### \d+\./.test(l)).length;
    const examples = [...md.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]) as { expected: string; oracle: unknown });
    /**
     * 2026-09-13：下限从 8 降到 4，因为这份文件的**职责换了**。
     *
     * 它原来自己列着十条合约不变量（步长、80% 价格带、杠杆分档…）——那是领域业务知识
     * 放错了地方：对每个项目都下发，还和规则包里的同名规则各自漂移。那批事实已经搬进
     * 规则包（各 fixture 的 rules.json 里的 rules），而且一进去就被校验拦了两次：
     * domain-reference 只能支撑假设、没有产品来源的假设不能自称 P0——
     * 它们在散文里被当成事实用了很久。
     *
     * 这份文件现在只留**通用的翻译手法**：领域规则怎么变成屏幕上的判据。
     * 手法本身仍然要有示例、示例仍然要合法、仍然一条都不许钉在易变读数上——
     * 下面那几条断言是这份文件真正的价值，一条没动。
     */
    expect(rules).toBeGreaterThanOrEqual(4);
    expect(examples.length).toBe(rules);
    // 职责换了之后，它必须把正本指向规则包，否则就又变回一份自说自话的散文。
    expect(md).toMatch(/规则包|rules/);
    expect(md).toContain("hypothesis");
    for (const ex of examples) {
      expect(typeof ex.expected).toBe("string");
      expect(MachineOracleSchema.safeParse(ex.oracle).success).toBe(true);
    }
    /**
     * **一条也不能问被测产品自己的接口**（2026-09-12 用户口径）。
     *
     * 这一条以前是反的：断言「资金与仓位类的示例全是 api，至少 8 条」。这个产品产出的是
     * 端到端 UI 测试——判决必须在屏幕上，接口说成功而屏幕上没有那一行，用例会通过而产品是坏的。
     */
    const kinds = examples.map((e) => (e.oracle as { kind: string }).kind);
    expect(kinds.filter((k) => k === "api")).toEqual([]);
    for (const k of kinds) expect(["text", "noText", "count", "delta", "url"]).toContain(k);
  });

  it("没有一条示例钉在易变读数上（oracle-volatile 零命中）", () => {
    const md = readFileSync(REF, "utf8");
    const examples = [...md.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]) as { expected: string });
    const cases = examples.map((e, i) => ({
      id: `R-${i + 1}`, storyId: "S-1", title: `R-${i + 1}`, priority: "P1" as const, priorityReason: "x", preconditions: [], steps: ["do"],
      expected: e.expected, tier: 1 as const, method: "equivalence" as const, covers: [],
    }));
    const report = runGate({ stories: [{ id: "S-1", title: "s", actor: "a", benefit: "b", acceptance: ["x"], module: "m" }], cases } as never);
    expect(report.findings.filter((f) => f.rule === "oracle-volatile")).toEqual([]);
  });

  it("ORACLE_STRICT 教的是「判决从屏幕读」，不再教接口判据", () => {
    expect(ORACLE_STRICT).not.toContain('"kind":"api"');
    expect(ORACLE_STRICT).toContain("THE VERDICT IS READ FROM THE SCREEN");
    /**
     * schema 里 `api` 这个分支**还在**：执行层要跑得动旧用例（`fixtures/hyperliquid-testnet`
     * 那 8 条全是接口判据）。拦住新用例的是门禁的 `oracle-offsite` 与受限解码的枚举，
     * 不是把类型删掉——删类型会让旧归档读不回来，而那是另一件事。
     */
    expect(MachineOracleSchema.safeParse({ kind: "api", url: "${env.U}", method: "POST", body: "{}", path: "[coin=BTC].limitPx", op: "eq", value: 40000, settleMs: 2500 }).success).toBe(true);
  });

  /**
   * 受限解码的枚举是**发得出什么**的唯一闸门。
   *
   * 2026-09-08 这条测试是反过来立的：zod 认得的每一种 kind 都必须在枚举里，
   * 否则领域臂产出 0 条 api（模型根本发不出来）。2026-09-12 口径改了之后，
   * 同一个机制反过来用：`api` **必须不在**枚举里，模型才发不出接口判据。
   * 其余每一种（屏幕上的那几种）仍然必须在，理由和当年一样。
   */
  it("约束解码的枚举里没有 api，其余每一种 kind 都在", () => {
    const oracle = (CASES_SCHEMA as unknown as { properties: { cases: { items: { properties: { oracle: { properties: Record<string, { enum?: readonly string[] }> } } } } } }).properties.cases.items.properties.oracle;
    expect(oracle.properties.kind.enum).not.toContain("api");
    const screenKinds = MachineOracleSchema.options.map((o) => o.shape.kind.value).filter((k) => k !== "api");
    for (const k of screenKinds) expect(oracle.properties.kind.enum).toContain(k);
    for (const op of ["eq", "gte", "lte"]) expect(oracle.properties.op.enum).toContain(op);
  });
});
