import { describe, expect, it } from "vitest";
import { checkStories, checkStory } from "../src/casegen/storyQuality.js";

const ok = {
  id: "S-01",
  title: "用户搜索不存在的姓氏时知道没找到",
  role: "诊所前台",
  benefit: "不必怀疑是自己输错了",
  acceptance: ["Given 在查找主人页 / When 填入 zzzznotaproduct 并提交 / Then 页面显示「has not been found」"],
};

describe("用户故事质量（对照 QUS）", () => {
  it("写得好的故事一条都不该报——误报会让人不再看它", () => {
    expect(checkStory(ok)).toEqual([]);
  });

  it("良构：说不出谁想要、能得到什么，那不是故事是界面事实", () => {
    expect(checkStory({ ...ok, role: "", benefit: "" }).map((f) => f.criterion)).toContain("well-formed");
  });

  it("原子：一条故事讲两件事，验收标准会互相牵扯", () => {
    const f = checkStory({ ...ok, title: "用户能搜索主人并且能编辑主人信息" });
    expect(f.map((x) => x.criterion)).toContain("atomic");
    expect(f.find((x) => x.criterion === "atomic")?.hit).toBe("并且");
  });

  it("最小：夹带实现细节——故事说要什么，不说怎么做", () => {
    const f = checkStory({ ...ok, acceptance: ["Then 通过 selector #lastName 定位输入框并检查"] });
    expect(f.map((x) => x.criterion)).toContain("minimal");
  });

  it("可测：没有验收标准就没法说它什么时候算做到了", () => {
    expect(checkStory({ ...ok, acceptance: [] }).map((f) => f.criterion)).toContain("testable");
  });

  it("可测：验收标准没有「当…则…」结构的是描述不是判据", () => {
    expect(checkStory({ ...ok, acceptance: ["主人列表页面"] }).map((f) => f.criterion)).toContain("testable");
  });

  it("只要有一条验收标准写成了判据，就不算不可测——不能因为其中一条松就全否", () => {
    const f = checkStory({ ...ok, acceptance: ["一句描述", ok.acceptance[0]!] });
    expect(f.map((x) => x.criterion)).not.toContain("testable");
  });

  it("完整句：一个词组是功能名，不是一件事", () => {
    expect(checkStory({ ...ok, title: "登录" }).map((f) => f.criterion)).toContain("full-sentence");
  });

  it("唯一：标题重复的故事复核时会被当成两件事各看一遍", () => {
    const r = checkStories([ok, { ...ok, id: "S-02" }]);
    expect(r.findings.filter((f) => f.criterion === "unique")).toHaveLength(1);
  });

  it("比率按「有问题的故事占比」算——条数会被故事数量带偏", () => {
    const r = checkStories([ok, { ...ok, id: "S-02", title: "登录" }]);
    expect(r.ratio).toBe(0.5);
  });

  it("空输入不崩", () => {
    expect(checkStories([]).ratio).toBe(0);
  });
});

describe("空洞的角色也不算良构", () => {
  it("「用户」不是一个角色，它是「有人」的同义词", () => {
    const f = checkStory({ ...ok, role: "用户" });
    expect(f.map((x) => x.criterion)).toContain("well-formed");
    expect(f.find((x) => x.criterion === "well-formed")?.hit).toBe("用户");
  });

  it("具体的角色才算——不同的人要的东西不一样，故事的价值全在那个差别上", () => {
    expect(checkStory({ ...ok, role: "诊所前台" })).toEqual([]);
    expect(checkStory({ ...ok, role: "第一次来的访客" })).toEqual([]);
  });

  it("英文的空洞角色一样不算", () => {
    expect(checkStory({ ...ok, role: "the user" }).map((x) => x.criterion)).toContain("well-formed");
  });
});
