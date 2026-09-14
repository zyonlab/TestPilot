import { describe, expect, it } from "vitest";
import { runGate } from "../src/casegen/gate.js";
import { MachineOracleSchema, evaluateOracle, describeOracle } from "../src/exec/oracle.js";

/**
 * 把上一批"满分但下次必挂"的用例钉成红的那一枪。
 *
 * 实测（wf-mtiimlwn，demo.binance.com 合约页，2026-09-01）：20 条用例、门禁 score 1、
 * 10 条 finding 里没有一条提到「验证入口页 Funding 数值」「验证入口页 Countdown 数值」
 * 这两条——而它们断言的是每秒都在变的读数，下一次跑必然失败。
 *
 * 这一条不红，就说明门禁仍然看不见这次事故。
 */
const caseOf = (id: string, expected: string) => ({
  id,
  storyId: "S-1",
  title: id,
  priority: "P1" as const,
  priorityReason: "x",
  preconditions: ["打开合约页"],
  steps: ["观察入口页"],
  expected,
  tier: 1 as const,
  method: "equivalence" as const,
  covers: [],
});

const bundleOf = (...cases: ReturnType<typeof caseOf>[]) => ({
  stories: [{ id: "S-1", title: "s", actor: "a", benefit: "b", acceptance: ["x"], module: "m" }],
  cases,
});

const rulesOf = (b: Parameters<typeof runGate>[0]) =>
  runGate(b as never).findings.map((f) => f.rule);

describe("断言钉在易变值上要被拦下", () => {
  it("倒计时", () => {
    expect(rulesOf(bundleOf(caseOf("TC-1", "入口页显示倒计时 05:40:16")) as never)).toContain("oracle-volatile");
  });

  it("带小数的资金费率", () => {
    expect(rulesOf(bundleOf(caseOf("TC-2", "Funding 显示为 0.01000%")) as never)).toContain("oracle-volatile");
  });

  it("千分位大额行情", () => {
    expect(rulesOf(bundleOf(caseOf("TC-3", "24h Vol(USDT) 等于 110,510,941,835.01")) as never)).toContain(
      "oracle-volatile",
    );
  });

  /**
   * 2026-09-01 真实运行把这条规则的第一版证伪了。
   *
   * 那一版还匹配 `funding rate` / `24h high` / `last price` 这些**词**，
   * 于是 6 条告警全是误报——它们断言的是「页面显示 X 字段」，那是字段存在，
   * 完全正当，而且正是提示词约束生效之后模型该写的样子。
   * 所以规则收窄成只认字面量。这一组反向用例把它钉住。
   */
  it("断言字段存在不是错——哪怕字段名里带着易变的词", () => {
    for (const ok of [
      '页面显示 "Funding (8h) / Countdown" 字段。',
      '页面显示 "24h High" 字段。',
      '页面显示 "24h Vol(USDT)" 字段。',
      '图表视图显示 "Last Price" 选项',
      "入口页显示资金费率与下次结算倒计时",
    ])
      expect(rulesOf(bundleOf(caseOf("TC-field", ok)) as never)).not.toContain("oracle-volatile");
  });

  /** 反向：正当的数字断言不许被误伤，否则这条规则会被人关掉。 */
  it("正当的数字断言不报警", () => {
    for (const ok of [
      "可用余额等于 5000 USDT",
      "订单列表出现 1 条记录",
      "错误提示显示「数量必须大于 0」",
      "切换到条件单后出现触发价字段",
      "杠杆调整为 20x 后保证金模式仍为全仓",
    ])
      expect(rulesOf(bundleOf(caseOf("TC-ok", ok)) as never)).not.toContain("oracle-volatile");
  });

  it("报出来的是 warn，会把满分拉下来", () => {
    const r = runGate(bundleOf(caseOf("TC-5", "入口页显示 Countdown 05:40:16")) as never);
    const f = r.findings.find((x) => x.rule === "oracle-volatile");
    expect(f?.severity).toBe("warn");
    expect(f?.field).toBe("expected");
  });
});

/**
 * tier 3 的 `{"kind":"none"}`：三处清单曾经互相打架（docs/v3/24 §33）。
 *
 * skill 明写「tier 3 写 {"kind":"none"}」、受限解码的枚举里也有 none，
 * 而校验 schema 的 union 里没有——模型照着写，校验一律
 * `Invalid discriminator value` 拒收（实测 75 条用例里 4 条 tier 3 全挂）。
 * 反过来红线禁止的 `api` 校验反而放行。
 */
describe("tier 3 的 none 判据", () => {
  it("schema 认它，而且它不冒充机器判据", () => {
    const parsed = MachineOracleSchema.safeParse({ kind: "none" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // 求值时明说「没量到」，不是 pass——skipped 与 pass 不是一回事。
    const v = evaluateOracle(parsed.data, { url: "http://x", text: "随便什么", title: "" } as never);
    expect(v.status).toBe("unobservable");
    expect(describeOracle(parsed.data)).toContain("没有机器判据");
  });
});
