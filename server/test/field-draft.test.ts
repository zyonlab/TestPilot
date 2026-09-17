import { describe, expect, it } from "vitest";
import { ProductRulePackSchema } from "@testpilot/harness-testing/domain";
import { FIELDS, RULE_PACK_EXAMPLE, RULE_PACK_REQUIRED, isFieldId, shrinkWarnings } from "../src/fieldDraft.js";
import { checkField } from "../src/chat.js";

/**
 * 字段起草面。钉的是「**判定在回路里**」这一条——抽屉能省人工的全部理由就在这儿：
 * 模型写，字段自己的校验器判，拒收理由原样回到对话上让它改。
 * 一旦判定退化成模型自评，这个抽屉产出的就是一份读起来完整、每条都无从核对的东西，
 * 而那比空着更糟：它看上去已经填好了。
 */

const source = (kind: string) => ({ id: "SRC-1", kind, locator: "x", fetchedAt: "2026-09-15", note: "" });
const pack = (over: Record<string, unknown> = {}) => ({
  schemaVersion: "product-rule-pack.v1",
  id: "vikunja-rules", version: "1", domain: "task-management", product: "Vikunja",
  network: "local", accountMode: "password",
  sources: [source("observation")],
  modules: [{ id: "task", name: "任务", parentId: null }],
  features: [{ id: "task.create", moduleId: "task", name: "新建任务", description: "",
    applicability: "applicable", applicabilitySourceRefs: ["SRC-1"] }],
  ...over,
});
const rule = (over: Record<string, unknown> = {}) => ({
  id: "R-1", featureIds: ["task.create"], claimType: "observed",
  statement: "新建任务后它出现在列表里", appliesWhen: "任务列表页", sourceRefs: ["SRC-1"],
  riskFloor: "P1", constants: {},
  verification: { kind: "ui-state", expect: { controlsPresent: [], stateChanged: [], textPresent: ["新建"] } },
  ...over,
});

describe("字段登记表", () => {
  it("每个字段的 valueKey 都在它自己的 schema 里", () => {
    // 对不上的症状不是校验失败，是**取出来的永远是 undefined**：模型写了值，
    // 而我们照着一个不存在的键去拿，于是每一轮都被当成「它只是在提问」。
    for (const spec of Object.values(FIELDS)) {
      const props = (spec.schema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(props), `${spec.id} 的 schema 里没有 ${spec.valueKey}`).toContain(spec.valueKey);
      expect(Object.keys(props), `${spec.id} 的 schema 里没有 reply`).toContain("reply");
    }
  });

  it("提示词里报的必填栏，和校验器真正要的那几栏是同一组", () => {
    // 两边错开的症状是「模型每次都少写一栏」，看起来像模型笨，其实是我们没告诉它。
    const shape = ProductRulePackSchema.shape as Record<string, { isOptional?: () => boolean }>;
    const required = Object.keys(shape).filter((k) => !shape[k].isOptional?.());
    expect([...RULE_PACK_REQUIRED].sort()).toEqual(required.sort());
    for (const k of RULE_PACK_REQUIRED) expect(FIELDS.rulePack.instruction).toContain(k);
  });

  /**
   * 提示词里那份样例，必须是**真的过得了校验的一份包**。
   *
   * 第一次真跑（Vikunja，2026-09-15）回了 39 条错，全是形状错：features 写成字符串、
   * rule 上挂 moduleId、verification.kind 编了一个不存在的取值。那时提示词只报了顶层
   * 字段名，形状一个字没说。样例是补那个洞的；样例本身要是不合法，补的就是另一个洞。
   */
  it("提示词里那份样例，自己先过一遍校验", () => {
    const v = FIELDS.rulePack.validate(RULE_PACK_EXAMPLE);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(FIELDS.rulePack.instruction).toContain('"product-rule-pack.v1"');
    // 样例是形状，不是内容——它带着领域倾向的话，换个产品就等于塞进别人的领域观念。
    expect(FIELDS.rulePack.instruction).toMatch(/Copy the shape, not the content/);
  });

  it("isFieldId 只认登记过的字段", () => {
    expect(isFieldId("rulePack")).toBe(true);
    expect(isFieldId("toString")).toBe(false);
    expect(isFieldId(undefined)).toBe(false);
  });
});

describe("规则包草稿的判定", () => {
  it("一份站得住的包过得去", () => {
    expect(FIELDS.rulePack.validate(pack({ rules: [rule()] }))).toEqual({ ok: true, errors: [] });
  });

  it("引用了没声明的来源 → 拒收，且理由指到那一条", () => {
    const v = FIELDS.rulePack.validate(pack({ rules: [rule({ sourceRefs: ["SRC-NOPE"] })] }));
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toContain("/rules/0/sourceRefs/0");
    expect(v.errors.join("\n")).toContain("SRC-NOPE");
  });

  /**
   * 这条是这个设计的支点：探索看到的东西撑不起「产品**应该**如此」。
   * 所以起草出来的规则一律 observed，而这句话不是靠嘱咐——`validateRulePack` 会拒。
   */
  it("只有观察来源时，normative 被拒", () => {
    const v = FIELDS.rulePack.validate(pack({ rules: [rule({ claimType: "normative" })] }));
    expect(v.ok).toBe(false);
    expect(v.errors.join("\n")).toContain("normative");
    // 换成人提供的产品文档就过得去——升级这一步是人做的判断，不是模型自己说了算。
    expect(FIELDS.rulePack.validate(
      pack({ sources: [source("official-doc")], rules: [rule({ claimType: "normative" })] }),
    ).ok).toBe(true);
  });

  it("拒收理由原样进 issues，一条都不概括", () => {
    const draft = checkField(pack({ rules: [rule({ sourceRefs: ["A"] }), rule({ id: "R-2", featureIds: ["nope"] })] }), FIELDS.rulePack);
    expect(draft.kind).toBe("field");
    expect(draft.valid).toBe(false);
    expect(draft.target).toBe("rulePack");
    expect(draft.issues.length).toBeGreaterThanOrEqual(2);
    // 「有 3 个问题」这种概括会让模型下一轮没有东西可改。
    for (const issue of draft.issues) expect(issue).toMatch(/：/);
  });
});

describe("领域知识草稿的判定", () => {
  it("空的不算草稿，长得离谱的也不算", () => {
    expect(FIELDS.domainKnowledge.validate("  ").ok).toBe(false);
    expect(FIELDS.domainKnowledge.validate("看板上一列是一个状态。").ok).toBe(true);
    expect(FIELDS.domainKnowledge.validate("x".repeat(60_001)).ok).toBe(false);
  });
});

/**
 * 改一处顺手重写全篇，是这条链路上最难看见的一种坏——重写出来的那份**完全合法**。
 *
 * 2026-09-15 真跑拍下来的：让它把 5 个 target 的 sideEffect 从 navigation 改成合法取值，
 * 它回「其余字段未动」，而 features 从 8 条变成了 5 条。校验器一个字都不会说，
 * 因为一份 5 个功能的包本来就成立。
 */
describe("这一版比上一版少了什么", () => {
  it("数组缩了就说出来，涨了和没变都不说", () => {
    const before = { features: [1, 2, 3], rules: [1], targets: [1, 2] };
    expect(shrinkWarnings(before, { features: [1], rules: [1, 2], targets: [1, 2] })).toEqual([
      "features：3 → 1，少了 2 条",
    ]);
    expect(shrinkWarnings(before, before)).toEqual([]);
  });

  it("整栏没了也算少", () => {
    expect(shrinkWarnings({ rules: [1, 2] }, {})).toEqual(["rules：上一版有 2 条，这一版没有了"]);
    // 上一版本来就是空的，这一版没有这一栏——没少什么，不用惊动人。
    expect(shrinkWarnings({ rules: [] }, {})).toEqual([]);
  });

  it("没有上一版时不评判", () => {
    expect(shrinkWarnings(undefined, { rules: [] })).toEqual([]);
    expect(shrinkWarnings("字符串字段没有条数可言", "更短")).toEqual([]);
  });

  it("checkField 把它挂在 warnings 上，而不是混进 issues 里拦下来", () => {
    const prev = pack({ rules: [rule(), rule({ id: "R-2" })] });
    const next = pack({ rules: [rule()] });
    const draft = checkField(next, FIELDS.rulePack, prev);
    // 正经的修改也会删东西，所以它照样过得去——只是人看得见少了什么。
    expect(draft.valid).toBe(true);
    expect(draft.issues).toEqual([]);
    expect(draft.warnings).toEqual(["rules：2 → 1，少了 1 条"]);
  });
});
