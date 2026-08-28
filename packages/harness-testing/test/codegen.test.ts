import { describe, expect, it } from "vitest";
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
