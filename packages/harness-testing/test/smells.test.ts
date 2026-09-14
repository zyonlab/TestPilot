import { describe, expect, it } from "vitest";
import { SMELL_RULES, scanSmells, smellsOf } from "../src/casegen/smells.js";

const r = (id: string, text: string) => ({ id, text });

describe("需求异味", () => {
  it("主观语言：好不好由读的人说了算", () => {
    expect(smellsOf(r("R-1", "页面正确显示主人列表")).map((s) => s.ruleId)).toContain("subjective");
    expect(smellsOf(r("R-2", "给出合理的错误提示")).map((s) => s.ruleId)).toContain("subjective");
  });

  it("模糊副词：把一条断言变成一个倾向", () => {
    expect(smellsOf(r("R-1", "通常在两秒内返回")).map((s) => s.ruleId)).toContain("vague-adverb");
  });

  it("开放式列举：没说完的清单", () => {
    expect(smellsOf(r("R-1", "显示姓名、地址等信息")).map((s) => s.ruleId)).toContain("open-ended");
  });

  it("没有比较对象的比较级", () => {
    expect(smellsOf(r("R-1", "加载更快")).map((s) => s.ruleId)).toContain("comparative-no-ref");
  });

  it("指代不明", () => {
    expect(smellsOf(r("R-1", "显示相应的提示")).map((s) => s.ruleId)).toContain("vague-pronoun");
  });

  it("不可验证的措辞", () => {
    expect(smellsOf(r("R-1", "确保用户能够正常提交")).map((s) => s.ruleId)).toContain("non-verifiable");
  });

  it("写得清楚的规则一条异味都不该报——误报会让人不再看它", () => {
    const clean = [
      r("R-1", "空着提交「Add Owner」后，firstName 字段下方显示「must not be empty」"),
      r("R-2", "搜索不存在的姓氏后，页面显示「has not been found」"),
      r("R-3", "主人列表的表头依次是 Name、Address、City、Telephone、Pets"),
    ];
    expect(scanSmells(clean).smells).toEqual([]);
  });

  it("命中的那个词要报出来——人判断误报要靠它", () => {
    const s = smellsOf(r("R-1", "页面正确显示"))[0]!;
    expect(s.hit).toBe("正确显示".slice(0, 2));
    expect(s.where).toBe("R-1");
  });

  it("比率按「有异味的规则占比」算，不按条数——条数会被规格长度带偏", () => {
    const rep = scanSmells([r("R-1", "正确地合理地显示"), r("R-2", "显示「Pets」")]);
    expect(rep.ratio).toBe(0.5);
  });

  it("空规格不崩，比率是 0", () => {
    expect(scanSmells([]).ratio).toBe(0);
  });

  it("每条规则都有人话说明和一个词表", () => {
    for (const rule of SMELL_RULES) {
      expect(rule.what.length).toBeGreaterThan(6);
      expect(rule.re.source.length).toBeGreaterThan(4);
    }
  });
});

describe("「正确」的两种用法，只有一种是异味", () => {
  it("质量声明是异味：正确显示 / 正确地处理", () => {
    expect(smellsOf(r("R-1", "正确显示主人列表")).map((s) => s.ruleId)).toContain("subjective");
    expect(smellsOf(r("R-2", "正确地处理提交")).map((s) => s.ruleId)).toContain("subjective");
  });

  it("条件不是异味：不正确时拒绝——这是一个具体的判断条件", () => {
    // 第一版在人写的需求文档上 5 处命中里 4 处是这种，80% 误报。
    // 一个误报这么高的检查器比没有更糟：人会学会无视它，连带无视那 20% 真的。
    expect(smellsOf(r("R-1", "凭证不正确时拒绝登录")).map((s) => s.ruleId)).not.toContain("subjective");
    expect(smellsOf(r("R-2", "密码不正确时，停留在登录页")).map((s) => s.ruleId)).not.toContain("subjective");
    expect(smellsOf(r("R-3", "无论密码是否正确")).map((s) => s.ruleId)).not.toContain("subjective");
  });

  it("「清晰」这类仍然是异味", () => {
    expect(smellsOf(r("R-1", "错误提示清晰且不误导")).map((s) => s.ruleId)).toContain("subjective");
  });
});
