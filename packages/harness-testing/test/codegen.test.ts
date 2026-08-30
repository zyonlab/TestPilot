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

/**
 * 提示词说清楚 ≠ 模型照做。
 *
 * `CODEGEN_STABLE` 里明令禁止目标式动作，可此前没有任何一条规则去校验它——实测产出里
 * 就有 18 句。规律很清晰：**凡是有门禁的要求模型就照做，凡是没有的就漂**。
 */
describe("门禁②：目标式动作", () => {
  const withAction = (text: string) => ({
    origin: "t",
    cases: [{ id: "c1", storyId: "S-01" }],
    fragments: [],
    failed: [],
    code: [
      {
        caseId: "c1",
        title: "c1",
        code: `await agent.aiAction('${text}');`,
        actions: [
          { kind: "action" as const, text },
          { kind: "assert" as const, text: "页面显示 X" },
        ],
        uses: [],
        params: [],
      },
    ],
  });

  it("挑出「导航到某某页面」这类目标——驱动模型拆不动它时，失败会被报成产品坏了", () => {
    const g = runCodeGate(withAction("click the navigation link or menu item that leads to the owners list page") as never, {});
    const f = g.findings.find((x) => x.rule === "goal-action");
    expect(f?.severity).toBe("warn");
    expect(String(f?.args?.action)).toContain("leads to");
  });

  it("一次具体交互不报——一个经常误报的门禁会被关掉，然后它什么也保护不了", () => {
    const g = runCodeGate(withAction('Click the "FIND OWNERS" link in the navigation bar') as never, {});
    expect(g.findings.some((x) => x.rule === "goal-action")).toBe(false);
  });
});

describe("门禁②：同一个目标被写成几种话", () => {
  const two = (a: string, b: string) => ({
    origin: "t",
    cases: [
      { id: "c1", storyId: "S-01" },
      { id: "c2", storyId: "S-01" },
    ],
    fragments: [],
    failed: [],
    code: [
      { caseId: "c1", title: "c1", code: "", actions: [{ kind: "action" as const, text: a }, { kind: "assert" as const, text: "x" }], uses: [], params: [] },
      { caseId: "c2", title: "c2", code: "", actions: [{ kind: "action" as const, text: b }, { kind: "assert" as const, text: "x" }], uses: [], params: [] },
    ],
  });

  it("同一条故事里，同一个引号里的目标有两种写法就报", () => {
    const g = runCodeGate(
      two('Click the "FIND OWNERS" link in the navigation bar', 'click the "FIND OWNERS" link') as never,
      {},
    );
    const f = g.findings.find((x) => x.rule === "wording-drift");
    expect(f?.args?.target).toBe("find owners");
    expect(f?.args?.n).toBe(2);
  });

  it("目标不同的两句不报——第一版按关键词重合度分组，把「点查找链接」和「点提交按钮」并成了一组", () => {
    const g = runCodeGate(two('Click the "FIND OWNERS" link', 'Click the "Add Owner" link') as never, {});
    expect(g.findings.some((x) => x.rule === "wording-drift")).toBe(false);
  });
});
