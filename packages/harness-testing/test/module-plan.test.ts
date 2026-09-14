import { it, expect } from "vitest";
import { checkModulePlan, leafModules, type ModuleProposal, type StoryRef } from "../src/domain/modulePlan.js";

/**
 * 模块树机检（docs/v3/24 §7）。每条断言对应 2026-09-11 双臂对照里真实抓到的一处缺陷。
 */
const codes = (f: ReturnType<typeof checkModulePlan>) => f.map((x) => x.code);

it("假层级：id 带点号却没有 parentId —— 机器臂 7 个模块 7 个中招", () => {
  const modules: ModuleProposal[] = [
    { id: "market.header", evidence: ["o#1"] },
    { id: "trade.panel", evidence: ["o#1"] },
  ];
  const f = checkModulePlan({ modules });
  expect(codes(f).filter((c) => c === "module_fake_hierarchy")).toHaveLength(2);
  // 不先抓这一条，下面所有「叶子」都是假的：一棵全是根的树，每个节点都是叶子。
  expect(leafModules(modules)).toHaveLength(2);
  expect(codes(f)).toContain("module_tree_is_a_list");
});

it("id 前缀和 parentId 说的不是同一个父模块", () => {
  const f = checkModulePlan({ modules: [
    { id: "market", evidence: ["o#1"] },
    { id: "order", evidence: ["o#1"] },
    { id: "market.depth", parentId: "order", evidence: ["o#1"] },
  ] });
  expect(codes(f)).toContain("module_id_parent_mismatch");
});

it("材料的每一段都要有落点：没人引用的段逐段报出来", () => {
  const sections = ["o#1", "o#2", "d#13"];
  const f = checkModulePlan({
    modules: [{ id: "market", evidence: ["o#2"] }],
    stories: [{ id: "s1", moduleIds: ["market"], evidence: ["o#2"] }],
    sections,
  });
  const unclaimed = f.filter((x) => x.code === "material_section_unclaimed").map((x) => x.sectionId);
  // d#13 是「预测市场是另一套风控模型」那一段——机器臂整段没认领，于是把预测市场整个漏掉了。
  expect(unclaimed).toEqual(["o#1", "d#13"]);
});

it("没给 sections 就不查落点——查不了的东西不装作查过", () => {
  const f = checkModulePlan({ modules: [{ id: "m", evidence: ["o#1"] }] });
  expect(codes(f)).not.toContain("material_section_unclaimed");
});

it("引用了材料里不存在的段", () => {
  const f = checkModulePlan({ modules: [{ id: "m", evidence: ["o#9"] }], sections: ["o#1"] });
  expect(codes(f)).toContain("module_evidence_unknown");
});

it("叶子扇出：叶子和故事接近 1:1 就不是树，并点名一条故事都没有的叶子", () => {
  const modules: ModuleProposal[] = [
    { id: "market", evidence: ["o#1"] },
    { id: "market.a", parentId: "market", evidence: ["o#1"] },
    { id: "market.b", parentId: "market", evidence: ["o#1"] },
    { id: "market.c", parentId: "market", evidence: ["o#1"] },
  ];
  const stories: StoryRef[] = [
    { id: "s1", moduleIds: ["market.a"] },
    { id: "s2", moduleIds: ["market.b"] },
  ];
  const f = checkModulePlan({ modules, stories });
  expect(codes(f)).toContain("leaf_fanout_too_low");
  expect(f.filter((x) => x.code === "leaf_without_story").map((x) => x.moduleId)).toEqual(["market.c"]);
});

it("扇出够了就不报——每个叶子两条故事", () => {
  const modules: ModuleProposal[] = [
    { id: "m", evidence: ["o#1"] },
    { id: "m.a", parentId: "m", evidence: ["o#1"] },
    { id: "m.b", parentId: "m", evidence: ["o#1"] },
  ];
  const stories: StoryRef[] = [
    { id: "s1", moduleIds: ["m.a"] }, { id: "s2", moduleIds: ["m.a"] },
    { id: "s3", moduleIds: ["m.b"] }, { id: "s4", moduleIds: ["m.b"] },
  ];
  const f = checkModulePlan({ modules, stories });
  expect(codes(f)).not.toContain("leaf_fanout_too_low");
  expect(codes(f)).not.toContain("leaf_without_story");
});

it("没有故事时不算扇出——别对着空集下结论", () => {
  const f = checkModulePlan({ modules: [{ id: "m", evidence: ["o#1"] }, { id: "m.a", parentId: "m", evidence: ["o#1"] }] });
  expect(codes(f)).not.toContain("leaf_fanout_too_low");
});

it("环、指向不存在的父、故事挂在不存在的模块上", () => {
  const f = checkModulePlan({
    modules: [{ id: "a", parentId: "b", evidence: ["o#1"] }, { id: "b", parentId: "a", evidence: ["o#1"] }],
    stories: [{ id: "s1", moduleIds: ["nope"] }],
  });
  expect(codes(f)).toContain("module_cycle");
  expect(codes(f)).toContain("story_module_unknown");
  expect(checkModulePlan({ modules: [{ id: "a", parentId: "ghost", evidence: ["o#1"] }] }).map((x) => x.code))
    .toContain("module_parent_unknown");
});

it("材料段可以显式声明不在范围内——要的是给个交代，不是每段都变成模块", () => {
  const sections = ["o#1", "d#14"];
  const base = { modules: [{ id: "m", evidence: ["o#1"] }], sections };
  expect(checkModulePlan(base).filter((f) => f.code === "material_section_unclaimed").map((f) => f.sectionId)).toEqual(["d#14"]);
  const declared = checkModulePlan({ ...base, outOfScope: [{ sectionId: "d#14", reason: "写用例的规矩，不是产品的一块" }] });
  expect(declared.map((f) => f.code)).not.toContain("material_section_unclaimed");
});

it("声明不在范围内却说不出理由，和漏掉一样", () => {
  const f = checkModulePlan({ modules: [{ id: "m", evidence: ["o#1"] }], sections: ["o#1", "d#14"],
    outOfScope: [{ sectionId: "d#14", reason: "  " }] });
  expect(f.map((x) => x.code)).toContain("out_of_scope_without_reason");
  expect(f.map((x) => x.code)).toContain("material_section_unclaimed");
});

it("声明了一个材料里不存在的段", () => {
  const f = checkModulePlan({ modules: [{ id: "m", evidence: ["o#1"] }], sections: ["o#1"],
    outOfScope: [{ sectionId: "ghost#9", reason: "x" }] });
  expect(f.map((x) => x.code)).toContain("out_of_scope_unknown_section");
});

it("「界面上看不到」不是范围外的理由——那是覆盖缺口", () => {
  const sections = ["d#6", "d#14"];
  const f = checkModulePlan({ modules: [{ id: "m", evidence: ["d#6"] }], sections, outOfScope: [
    { sectionId: "d#14", reason: "写用例的规矩，不描述任何产品行为" },
    { sectionId: "d#6", reason: "ADL 在界面上无直接展示，属于后台风控" },
  ] });
  const gaps = f.filter((x) => x.code === "out_of_scope_is_actually_a_gap").map((x) => x.sectionId);
  expect(gaps).toEqual(["d#6"]);
  // 说得出「不描述产品行为」的那条不被点到。
  expect(gaps).not.toContain("d#14");
});
