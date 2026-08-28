import { describe, expect, it } from "vitest";
import { runCodeGate } from "../src/codegen/gate.js";
import { codegenVariable, CODEGEN_STABLE } from "../src/codegen/prompts.js";

describe("判决归程序时，代码不该再写 aiAssert", () => {
  it("有机器判据的用例，材料里要明说判决由程序下", () => {
    const v = codegenVariable({
      title: "空姓氏搜索返回全部主人",
      steps: ["清空姓氏输入框", "点 Find Owner"],
      expected: "列表显示 10 条",
      oracle: { kind: "count", value: "Owner", op: "eq", n: 10 },
    });
    expect(v).toContain("VERDICT: decided by a program");
    expect(v).toContain("no aiAssert");
  });

  it("没有机器判据的用例不带这一句——那时模型判屏就是唯一的判决方式", () => {
    const v = codegenVariable({
      title: "页面看起来正常",
      steps: ["打开首页"],
      expected: "布局没有错乱",
    });
    expect(v).not.toContain("VERDICT");
  });

  it("提示词里写清了为什么：aiAssert 跑在判据之前，能把程序的结论否掉", () => {
    expect(CODEGEN_STABLE).toContain("VERDICT: decided by a program");
    expect(CODEGEN_STABLE).toContain("veto");
  });
});

describe("门禁②：有机器判据时，代码里没有断言不算缺陷", () => {
  const codeCase = (id: string) => ({
    caseId: id,
    title: id,
    code: "await agent.aiAction('点一下');",
    actions: [{ kind: "action" as const, text: "点一下" }],
    uses: [],
    params: [],
  });
  const bundle = (ids: string[]) => ({
    origin: "t",
    cases: [],
    fragments: [],
    failed: [],
    code: ids.map(codeCase),
  });

  it("有判据的用例不再被 no-assertion 拦住——断言在判据里，不在代码里", () => {
    const g = runCodeGate(bundle(["c1"]) as never, {}, () => ({ kind: "text", value: "x" }));
    expect(g.findings.filter((f) => f.rule === "no-assertion")).toHaveLength(0);
  });

  it("没有判据、代码里也不断言的，仍然要拦——那不是测试，是一次访问", () => {
    const g = runCodeGate(bundle(["c2"]) as never, {}, () => undefined);
    const f = g.findings.filter((x) => x.rule === "no-assertion");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("block");
  });

  it("不传 oracleOf 时行为不变——老调用点不受影响", () => {
    const g = runCodeGate(bundle(["c3"]) as never, {});
    expect(g.findings.some((x) => x.rule === "no-assertion")).toBe(true);
  });
});
