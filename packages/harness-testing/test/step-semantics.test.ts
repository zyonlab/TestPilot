import { describe, expect, it } from "vitest";
import { isOpenQuestion, navigationTarget } from "../src/exec/stepSemantics.js";

describe("纯导航步骤由执行器直接跳转", () => {
  const here = "http://localhost:3456/";
  it("整步就是「打开 同源地址」才算", () => {
    expect(navigationTarget("打开 http://localhost:3456/login", here)).toBe("http://localhost:3456/login");
    expect(navigationTarget("访问 /projects", here)).toBe("http://localhost:3456/projects");
    expect(navigationTarget("Open http://localhost:3456/teams.", here)).toBe("http://localhost:3456/teams");
  });
  it("带着别的动作的、外站的、不是地址的，都交回模型", () => {
    expect(navigationTarget("打开 http://localhost:3456/ 并点击左侧导航里的「项目」", here)).toBeUndefined();
    expect(navigationTarget("打开 https://other.test/", here)).toBeUndefined();
    expect(navigationTarget("打开项目详情页", here)).toBeUndefined();
    expect(navigationTarget("点击「打开」按钮", here)).toBeUndefined();
  });
});

describe("开放问题不是判决", () => {
  it("只认显式标记", () => {
    expect(isOpenQuestion("开放问题：规则包称首页有 6 条任务——这是一条待确认线索，不作为失败判据")).toBe(true);
    expect(isOpenQuestion("【待确认：界面观察不到】退出入口未采到")).toBe(true);
    expect(isOpenQuestion("待确认：My Open Tasks 是否应出现")).toBe(true);
  });
  it("普通断言、只是提到「确认」两个字的，照常判", () => {
    expect(isOpenQuestion("页面给出标题必填之类的提示（文案未采到，需人工或视觉判定）")).toBe(false);
    expect(isOpenQuestion("点击确认后弹窗关闭")).toBe(false);
  });
});
