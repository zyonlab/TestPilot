import { z } from "zod";
import { MachineOracleSchema } from "../exec/oracle.js";

/**
 * Stage-one artifacts: what a person reads and reviews, before anything becomes code.
 *
 * Deliberately end-agnostic — the same text case must be able to become a web, iOS or
 * Android case later, so nothing here mentions selectors, pages or devices.
 */

export const StorySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** Verbatim acceptance criteria from the spec: what "done" means for this story. */
  acceptance: z.array(z.string()).default([]),
  /** Which requirement this came from, when the material had ids. */
  requirementId: z.string().optional(),
  /**
   * Which document it came from, when the material was several.
   *
   * Not decoration: a spec assembled from a business document and a UI document will
   * quietly produce stories from the first one only, and without this field that shows up
   * much later as a coverage number nobody can explain.
   */
  source: z.string().optional(),
  /**
   * `source` 是怎么来的。
   *
   * `located` 是拿故事的验收标准回规格里定位出来的，是事实；`claimed` 是模型自己说的、
   * 只核对过"这份文档确实存在"。两者都比空着强，但它们不是同一种可信度，而界面上
   * 显示成同一个文件名就等于宣称它们一样。
   */
  sourceBy: z.enum(["located", "claimed"]).optional(),
});
export type Story = z.infer<typeof StorySchema>;

export const DesignMethod = z.enum([
  "equivalence",
  "boundary",
  "state-transition",
  "decision-table",
  "negative",
]);
export type DesignMethod = z.infer<typeof DesignMethod>;

/**
 * How hard the verdict is. The distribution is reported with every batch, because
 * "66 cases" means two completely different things depending on which tier they are.
 *   1 assert     a program can settle it: this text, this number
 *   2 invariant  a relation: the list is one shorter, the total equals the parts
 *   3 judge      a model looks at the screen and says whether it looks right
 */
export const OracleTier = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type OracleTier = z.infer<typeof OracleTier>;

export const TextCaseSchema = z.object({
  id: z.string().min(1),
  storyId: z.string().min(1),
  title: z.string().min(1),
  designMethod: DesignMethod,
  precondition: z.array(z.string()).default([]),
  steps: z.array(z.string().min(1)).min(1),
  /** One concrete, checkable outcome. The pass/fail oracle. */
  expected: z.string().min(1),
  /**
   * The same outcome in a form a program can settle, when there is one.
   *
   * `expected` is what a person reads; this is what the runner checks. Without it a case
   * claiming tier 1 still gets its verdict from a model looking at a screenshot, which is
   * how the tier ended up being a label with nothing behind it.
   */
  oracle: MachineOracleSchema.optional(),
  tier: OracleTier,
  /**
   * Dedupe triple: which transition, which parameters, what is asserted. Two cases with
   * the same key are the same case wearing different words.
   */
  key: z.string().min(1),
});
export type TextCase = z.infer<typeof TextCaseSchema>;

/**
 * 规格是**怎么来的**——这不是元数据，它决定下游断言能说明什么。
 *
 * - `document`：人写的。它表达的是**意图**，所以一条对着它写的用例挂了，可能意味着
 *   「产品错了」。
 * - `exploration`：从跑着的产品上看出来的。它表达的是**现状**，所以对着它写的用例
 *   只能发现「产品变了」（回归），**永远不可能发现「产品错了」**——观察不可能反驳被观察者。
 * - `codebase`：从代码里推的。介于两者之间：代码是实现，不是意图，但它比界面多出
 *   分支与边界这些从外面看不见的东西。（尚未实现。）
 *
 * 把这个字段丢掉，一套完全建立在观察之上的绿色套件，就会被读成「产品是对的」。
 */
export const SpecProvenance = z.enum(["document", "exploration", "codebase"]);
export type SpecProvenance = z.infer<typeof SpecProvenance>;

/**
 * **材料**：还没被整理过的东西。
 *
 * 用户给的文档是材料，探索得来的观察记录是材料，以后从代码库抽出来的也是材料。
 * 它们的形态千差万别——一份 PRD、一段会议纪要、一屏界面文字——所以没有一个下游节点
 * 应该直接吃它们：那等于让每一个下游都去处理"用户这次给的是什么格式"。
 *
 * 材料只往一个地方去：`spec.compose`。
 */
export const SpecMaterialSchema = z.object({
  text: z.string().min(1),
  /** Where it came from, so a story can be traced back to a file. */
  origin: z.string().default("inline"),
  // 可选而不是给默认值：这个字段是后加的，此前的每一份材料都没有它。让读的人写一次
  // `?? "document"`，比让 zod 悄悄替他决定要好——那正是需要他想一下的地方。
  derivedFrom: SpecProvenance.optional(),
});
export type SpecMaterial = z.infer<typeof SpecMaterialSchema>;

/**
 * 一条规则：标准规格的最小单位。
 *
 * 有 id，所以故事可以引用它；有 `evidence`，所以「这条规则凭什么这么写」有得查——
 * 它记的是材料里的原话。一条没有出处的规则，和模型顺手编的一句话在下游是分不清的。
 */
export const SpecRuleSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  /** 材料里支持这条规则的原话。整理者不许自己造。 */
  evidence: z.string().default(""),
  /**
   * 这条 `evidence` 在哪份文档里查到的。
   *
   * **不是模型填的**——整理节点拿这句原话回材料里定位，查到才有值。所以它有三种含义：
   * 有值 = 原话确实在那份材料里；无值且 evidence 为空 = 整理者没给出处；
   * 无值但 evidence 有内容 = 那句"原话"在材料里查不到，也就是它不是原话。
   */
  source: z.string().optional(),
});
export type SpecRule = z.infer<typeof SpecRuleSchema>;

/**
 * **标准规格**：整个下游唯一认的那份东西。
 *
 * 不管材料是用户的文档、探索得来的观察，还是以后从代码库抽的，到这里都被整理成同一个形状。
 * 这不是格式洁癖：下游（拆故事、设计用例、追溯、门禁）此前是直接吃原始文档的，
 * 于是「用户这次给的是什么格式」这个问题被复制到了每一个节点里。
 *
 * 三件事是这个形状的要点：
 * - `rules` 有 id 且带出处 —— 故事能引用规则，规则能指回材料原话。
 * - `unknowns` 是**必须**有的一节 —— 一份不写自己盲区的规格读起来像是完整的，
 *   而由它衍生的一切都会继承这个错觉。
 * - `derivedFrom` 一路带下去 —— 见 `SpecProvenance`：它决定断言能说明什么。
 */
export const SpecDocSchema = z.object({
  title: z.string().default(""),
  /** 整理后的规格全文（markdown）。下游读它，人也读它。 */
  text: z.string().min(1),
  rules: z.array(SpecRuleSchema).default([]),
  /** 材料里没有答案的地方：够不到的界面、缺凭证、没提到的规则。 */
  unknowns: z.array(z.string()).default([]),
  /** 材料从哪来，逐份列出。 */
  origin: z.string().default("inline"),
  derivedFrom: SpecProvenance.optional(),
});
export type SpecDoc = z.infer<typeof SpecDocSchema>;

export const StoryBundleSchema = z.object({
  origin: z.string().default("inline"),
  /** 这批故事背后的规格是怎么来的——一路带到用例上，因为它改变断言的含义。 */
  derivedFrom: SpecProvenance.optional(),
  /**
   * 规格全文，跟着故事一起往下走。
   *
   * `design.cases` 需要它，但它的输入类型是 `stories`——所以在这个字段出现之前，规格只能靠
   * 图上的一个参数传，而那个参数**建图时填不出来**（建图时只有文件路径，内容要等节点运行时
   * 才读）。结果是它一直是空串：**全部 21 次历史运行里，写用例的那个节点从没见过规格**，
   * 只看得见故事的标题和验收标准。出处（`origin` / `derivedFrom`）本来就是这样一路带下去的，
   * 规格本身跟着走是同一个做法。
   */
  specText: z.string().optional(),
  stories: z.array(StorySchema).min(1),
});
export type StoryBundle = z.infer<typeof StoryBundleSchema>;

export const CaseBundleSchema = z.object({
  origin: z.string().default("inline"),
  derivedFrom: SpecProvenance.optional(),
  stories: z.array(StorySchema).default([]),
  cases: z.array(TextCaseSchema).default([]),
});
export type CaseBundle = z.infer<typeof CaseBundleSchema>;

/** Gate ① output: the same bundle, plus what the gate thought of it. */
export const GateFindingSchema = z.object({
  caseId: z.string().optional(),
  rule: z.string(),
  severity: z.enum(["warn", "info"]),
  message: z.string(),
});
export type GateFinding = z.infer<typeof GateFindingSchema>;

export const GateReportSchema = z.object({
  score: z.number().min(0).max(1),
  findings: z.array(GateFindingSchema),
  stats: z.object({
    cases: z.number(),
    tiers: z.record(z.string(), z.number()),
    /** The tier each case can actually deliver, from its oracle (or 3, if it has none). */
    tiersBacked: z.record(z.string(), z.number()).default({}),
    methods: z.record(z.string(), z.number()),
    negativeRatio: z.number(),
    orphans: z.number(),
    duplicates: z.number(),
  }),
});
export type GateReport = z.infer<typeof GateReportSchema>;

export const GatedBundleSchema = CaseBundleSchema.extend({ gate: GateReportSchema });
export type GatedBundle = z.infer<typeof GatedBundleSchema>;

/** Edge kinds — the canvas connects on these, not on the schemas. */
export const KIND = {
  /** 未整理的材料：文档原文、观察记录、（以后）代码摘要。 */
  material: "spec-material",
  /** 整理后的标准规格。下游只认这个。 */
  spec: "spec",
  stories: "stories",
  cases: "cases",
  gatedCases: "gated-cases",
} as const;
