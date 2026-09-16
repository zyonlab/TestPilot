import { z } from "zod";
import { StateFlowGraphSchema } from "../exec/sfg.js";
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
   * 骨架上的位置：这条故事属于哪个用户活动。
   *
   * 故事地图（Patton）的横轴是**用户活动按叙事顺序**，纵轴是每个活动下的故事。横轴必须
   * 来自数据——扁平数组画不出地图，界面只能硬凑一个分类，而硬凑出来的横轴不是骨架。
   * 值取自规格的流程（`flowId` 指向的那条），或流程终点所在的模块。
   */
  activity: z.string().optional(),
  moduleIds: z.array(z.string().min(1)).optional(),
  /** 这条故事兑现的是哪条流程。没有对应流程的故事——比如「页脚显示社交链接」——留空。 */
  flowId: z.string().optional(),
  /**
   * **走完这条故事，就顺带走完了这几条更短的故事。**
   *
   * 2026-09-14 用户看完重跑结果提的：「一般长的用户故事会覆盖短的用户故事。
   * 这样步数会增加，同时不重要的用户故事可以减少。」
   *
   * 实测的毛病正是这个：38 条故事里一大半是展示型的短故事（「看到标记价与预言机价」
   * 「看到 24h 涨跌」），每条各自长出一个用例单元，于是 170 条用例里 22 条
   * 除了导航什么都不做——它们的判据在初始页面上就成立，通过时什么都没证明。
   *
   * 声明覆盖之后有两个后果，都是想要的：
   * - 被覆盖的故事**不再单独出用例单元**（`planUnits`），短用例随之消失；
   * - 覆盖方的用例契约会拿到被覆盖故事的验收准则编号，`acRefs` 可以引它们，
   *   于是那些展示型检查变成一条长用例路上的断言，而不是一条两步用例。
   *
   * 只允许一层：被覆盖的故事自己不能再覆盖别人（否则「哪条故事该出单元」要做传递闭包，
   * 而人在界面上也看不懂）。
   */
  subsumes: z.array(z.string().min(1)).optional(),
  /** 谁在用。「作为 X」——没有角色的条目不是用户故事，是界面事实。 */
  role: z.string().optional(),
  /** 为了什么。「以便 Z」——它是判断这条故事值不值得测的唯一依据。 */
  benefit: z.string().optional(),
  /**
   * `source` 是怎么来的。
   *
   * `located` 是拿故事的验收标准回规格里定位出来的，是事实；`claimed` 是模型自己说的、
   * 只核对过"这份文档确实存在"。两者都比空着强，但它们不是同一种可信度，而界面上
   * 显示成同一个文件名就等于宣称它们一样。
   */
  sourceBy: z.enum(["located", "claimed"]).optional(),
  /**
   * 产品模型里的功能 / 规则引用（2026-09-11，单元循环）。
   *
   * 有产品模型的 run 上，服务端按单元范围核对它们：引用不在本单元范围内的功能就拒绝。
   *
   * 和 `priority` 同一条规矩：**不给默认值**。旧 run 和没有产品模型的 run 里它们是
   * `undefined`——「没说」和「说了是空」不是一回事，补一个 `[]` 会让归档看起来像
   * 「明确声明了不关联任何功能」。
   */
  featureRefs: z.array(z.string().min(1)).optional(),
  ruleRefs: z.array(z.string().min(1)).optional(),
  /**
   * 这条故事压在生命周期的哪一段（规则包 `lifecycle` 里的阶段 id）。
   *
   * 优先级要有据可依，先得有「据」：一条故事在不在主链上是可以查的事实，
   * 不是读完标题的感觉。不在任何一段上就留空——那本身也是一句话：它是支线。
   */
  lifecycleId: z.string().min(1).optional(),
  /**
   * P0 / P1 / P2。**不给默认值**：和 `featureRefs` 同一条规矩，
   * 「没说」和「说了是 P2」不是一回事。
   *
   * 2026-09-12 之前故事上根本没有这个字段（只有用例上有），于是「从模块和生命周期
   * 拆出 P0/P1」这件事在故事这一层无处落脚。判据写在 workflowControls 的故事契约里：
   * 主链断了就是 P0，主链走得通但结果可能错是 P1，其余 P2。
   */
  priority: z.enum(["P0", "P1", "P2"]).optional(),
});
export type Story = z.infer<typeof StorySchema>;

export const DesignMethod = z.enum([
  "equivalence",
  "boundary",
  "state-transition",
  "decision-table",
  "negative",
  /**
   * 证据是一次探索，不是一张表。
   *
   * `DesignTechnique` 一开始就有 `exploratory`，而这个枚举没有——于是一条以探索章程
   * 为证据的用例填不出一致的方法标签：填 `exploratory` 被 `design_technique_mismatch`
   * 拒掉，填别的就是撒谎。2026-09-11 第二轮实测撞上一次，只能把 `design` 整个删掉，
   * 一条本来有出处的证据反而变成了「没给证据」。
   */
  "exploratory",
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

/**
 * 一条用例是在**什么场景**下跑的。和设计方法分开（21 §5）。
 *
 * 旧契约把 `negative` 混进了 `designMethod`——它不是一种设计方法，是一类场景：
 * 一条负例同样可以用边界或判定表设计出来。两者挤在一个字段里，结果是
 * 「负例占比」和「用了哪些方法」这两个数永远算不准，因为它们共用一个分母。
 * 迁移期两者并存：旧产物只有 `designMethod`，新产物应两个都给。
 */
export const ScenarioType = z.enum(["positive", "negative", "recovery", "concurrency"]);
export type ScenarioType = z.infer<typeof ScenarioType>;

/** 设计方法本身（不含 `negative`——那是场景，见 `ScenarioType`）。 */
export const DesignTechnique = z.enum(["equivalence", "boundary", "decision-table", "state-transition", "exploratory"]);
export type DesignTechnique = z.infer<typeof DesignTechnique>;

/**
 * **设计证据**：这条用例凭什么说自己用了那种方法（21 §5）。
 *
 * 为什么是判别联合而不是一团自由 JSON：方法标签是免费的，证据不是。
 * 2026-09-11 实测一批 135 条用例，方法标签 100% 都有，而 36 条 `state-transition`
 * 里 36 条说不出自己走的是哪条边——标签看起来很专业，背后什么都没有。
 * 每一支的字段都要能被确定性核对：边界点能算、判定行能对上条件、状态边能在图里找到。
 */
export const DesignEvidenceSchema = z.discriminatedUnion("technique", [
  z.object({
    technique: z.literal("equivalence"),
    /** 被划分的输入维度，如「数量」「价格」。 */
    inputDimension: z.string().min(1),
    partitionId: z.string().min(1),
    /** 这一类的判定条件，人能读、也能回头核对。 */
    predicate: z.string().min(1),
    validity: z.enum(["valid", "invalid"]),
    /** 这一类挑出来的代表值。 */
    representative: z.string().min(1),
  }).strict(),
  z.object({
    technique: z.literal("boundary"),
    /** 边界来自哪条规则——**不能自己编一个上限**。 */
    ruleId: z.string().min(1),
    dimension: z.string().min(1),
    /** 单位。数量的步长和价格的精度混用过一次，就再也说不清哪个数是什么。 */
    unit: z.string().min(1),
    bound: z.string().min(1),
    inclusivity: z.enum(["inclusive", "exclusive"]),
    /** 相邻可表示值的间隔（步长 / tick），以及它的依据。 */
    step: z.string().optional(),
    /** 实际取到的边界点，至少一个。 */
    points: z.array(z.object({ at: z.enum(["below", "at", "above"]), value: z.string().min(1) }).strict()).min(1),
  }).strict(),
  z.object({
    technique: z.literal("decision-table"),
    tableId: z.string().min(1),
    conditionIds: z.array(z.string().min(1)).min(2),
    rowId: z.string().min(1),
    /** 这一行每个条件的取值。键必须是 `conditionIds` 里的。 */
    assignment: z.record(z.string()),
    expectedOutcomeRefs: z.array(z.string().min(1)).min(1),
  }).strict(),
  z.object({
    technique: z.literal("state-transition"),
    stateModelRef: z.string().min(1),
    from: z.string().min(1),
    event: z.string().min(1),
    guard: z.string().optional(),
    to: z.string().min(1),
    /** 走过的转移 id，和 `covers` 说的必须是同一批。 */
    transitionIds: z.array(z.string().min(1)).min(1),
  }).strict(),
  z.object({
    technique: z.literal("exploratory"),
    charterRef: z.string().min(1),
    observedResultRefs: z.array(z.string().min(1)).default([]),
  }).strict(),
]);
export type DesignEvidence = z.infer<typeof DesignEvidenceSchema>;

/**
 * 风险**理由**。优先级本身仍是顶层的 `priority`，这里不重复。
 *
 * 和 21 §2 的 `risk` 略有出入：那份草案把 `priority` 也放进 risk。本仓库的
 * `priority` 已经在顶层、已经被看板/导出/执行路径读了，再放一份等于两个真值来源——
 * 迟早得到两批对不上的优先级。所以这里只放**为什么是这个优先级**：
 * 影响什么资产、失败的后果、依据哪条规则。
 */
export const RiskSchema = z.object({
  impact: z.enum(["funds-and-exposure", "authorization", "data-integrity", "availability", "information", "cosmetic"]),
  reason: z.string().min(1),
  ruleRefs: z.array(z.string().min(1)).default([]),
}).strict();

/** 一条结构化测试数据。金额与数量用十进制字符串，别用浮点。 */
export const TestDatumSchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
  unit: z.string().optional(),
  /** 这个值哪来的：规则 id、标的元数据、fixture。编出来的常数在这里露馅。 */
  source: z.string().optional(),
}).strict();

export const TestDataSchema = z.object({
  /** 需要哪个受控环境；没有就说没有，不要假装能跑。 */
  fixtureRef: z.string().optional(),
  accountRef: z.string().optional(),
  values: z.array(TestDatumSchema).default([]),
}).strict();

/**
 * 一条**独立**断言。
 *
 * v1 只有一个 `expected` 和一个 `oracle`：一条用例里但凡有两件事要核，就只能把它们
 * 揉进一句话，而执行时它们同生共死——一个数对了另一个错了，报出来是同一个失败。
 * 2026-09-11 实测抓到过反面：`expected` 说「只断言字段存在」，`oracle` 却断言「取值未变」，
 * 两者互相矛盾还都通过了形状校验。拆成数组之后，每条断言各自带判据、各自可判。
 */
export const AssertionSchema = z.object({
  id: z.string().min(1),
  /** 这条断言主张什么，一句能失败的话。 */
  statement: z.string().min(1),
  /** 它依据哪条产品规则。没有依据的断言说明不了产品对错。 */
  ruleRefs: z.array(z.string().min(1)).default([]),
  oracle: MachineOracleSchema.optional(),
  unit: z.string().optional(),
  /**
   * 在第几步（从 1 数）**做完之后**判这一条；不写就在全部步骤做完之后判。
   *
   * 2026-09-15 Vikunja C-S03-04：步骤是「进标签页 → 点空态里的『新建标签.』」，第一条断言
   * 「标签页显示『当前没有标签』」描述的是**第 2 步之后、第 3 步之前**那一屏——而断言统一在
   * 最后一步之后判，那时页面已经进了新建表单。一条正确的断言，因为判的时机不对而恒红。
   */
  afterStep: z.number().int().positive().optional(),
}).strict();

/**
 * 这条用例现在能走到哪一步。
 *
 * 设计完成 ≠ 能执行。缺受控账户、缺持仓 fixture 的 P0 用例必须保留并标 blocked，
 * 而不是删掉或降级——否则通过率好看了，覆盖缺口也一起消失了（21 §8 反例 7）。
 */
export const ReadinessSchema = z.object({
  design: z.enum(["candidate", "reviewed"]),
  execution: z.enum(["ready", "requires-fixture", "requires-session", "blocked", "not-executable"]),
  reason: z.string().optional(),
}).strict();

export const TextCaseSchema = z.object({
  id: z.string().min(1),
  storyId: z.string().min(1),
  title: z.string().min(1),
  designMethod: DesignMethod,
  precondition: z.array(z.string()).default([]),
  steps: z.array(z.string().min(1)).min(1),
  /**
   * 坏了要付多大代价。**不是**这条用例有多难写。
   *
   * 此前设计节点根本不产出它——提示词的返回格式里没有这个键，模型从没被问过。后果一路
   * 往下传：看板 P0/P1/P2 三列恒空 → 批准时只能默认 P1 → 导出的文件名全是 `p1-*` →
   * 「先跑 P0 冒烟」这条本该最有用的路径不存在 → 执行记录为了有东西显示，
   * 把 graphs.ts 里那个占位的 P2 画成了真徽章。
   *
   * 可选而不是给默认值：给默认值等于替模型答一遍，而「它没说」和「它说是 P1」
   * 在复核时是两件事。
   */
  priority: z.enum(["P0", "P1", "P2"]).optional(),
  /**
   * 把产品放回去的动作。
   *
   * 看板有这一列、导出器有 teardown 分支，只有生成侧一直没产出过——于是一批「新增主人」
   * 的用例反复跑，每跑一遍留一条 John Doe，冻结基线从 10 个 owner 涨到 13 个。
   * 一条留下记录的用例会毒化它自己以后的每一次运行：第二次跑面对的产品和第一次不同，
   * 而这个差别一直看不见，直到某个计数断言毫无道理地挂掉。
   */
  postSteps: z.array(z.string().min(1)).default([]),
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
  /**
   * 这条用例走了哪些转移（`from->to`）。
   *
   * 它把用例挂回产品模型上，于是覆盖率有了**来自产品本身**的分母：一共 M 条转移，
   * 覆盖了几条。人写的黄金清单回答「测的是不是该测的东西」，这个数回答「够不够」。
   * 说不出任何一条的用例单独计数——它多半没在验证一次变化，而是在描述一屏。
   */
  covers: z.array(z.string()).default([]),
  /**
   * 这条用例是对着材料的**哪几段**写出来的：`retrieve_spec` 返回的 chunk id
   * （`docs/spec.md#7`）或探索观察的段 id。**出处锚点**——六职责盘点里此前空着的那一格。
   *
   * 为什么是 id 不是引文：一段引文可以被编出来，一个 id 只能是工具返回过的。
   * 写盘 hook 与 `design.cases` 节点都用 `checkProvenance` 对着**这次运行真正取到的段**核对，
   * 对不上的 id 不是「引用错了」，是这条断言查不到出处——survey-02 里 66 条断言只有
   * 4 条查得到出处，就是因为这个字段以前不存在，出处只活在模型的措辞里。
   *
   * 默认空数组而不是必填：A 臂的旧运行没有它，读回来不该炸；**要不要为空由门禁与 hook 决定**，
   * 形状层只保证它是一组字符串。
   */
  sourceRefs: z.array(z.string()).default([]),
  /** 与 Story 同义：这条用例验证的功能与规则（单元循环写入时按故事范围核对）。同样不给默认值。 */
  featureRefs: z.array(z.string().min(1)).optional(),
  ruleRefs: z.array(z.string().min(1)).optional(),

  /* ---- v2 设计证据（2026-09-11，docs/v3/history/21 §2 与 §5）。
   *
   * 八个字段全部 `optional()`，一个默认值都不给。理由和 `priority` 那条一样，
   * 而且在这里更要紧：这些字段是**证据**，给默认值等于替设计者答一遍，
   * 让「没给证据」和「给了空证据」在归档里长得一模一样。旧产物读出来是 undefined，
   * 界面显示为未提供，blob 一个字节都不改。
   */

  /** 这条用例兑现故事里的哪几条验收标准。 */
  acRefs: z.array(z.string().min(1)).optional(),
  /** 它覆盖哪几个测试条件（先有条件与覆盖项，再有用例）。 */
  conditionRefs: z.array(z.string().min(1)).optional(),
  /** 场景类型，和设计方法分开。见 `ScenarioType`。 */
  scenarioType: ScenarioType.optional(),
  /** 设计证据。声称用了某种方法，就要拿得出这一支要求的东西。 */
  design: DesignEvidenceSchema.optional(),
  /** 为什么是这个优先级：影响什么、后果是什么、依据哪条规则。 */
  risk: RiskSchema.optional(),
  /** 结构化测试数据：值、单位、出处、需要的 fixture。 */
  testData: TestDataSchema.optional(),
  /** 拆开的独立断言。给了它，`expected` 仍然是给人读的那一句。 */
  assertions: z.array(AssertionSchema).min(1).optional(),
  /** 设计就绪与执行就绪分开记。 */
  readiness: ReadinessSchema.optional(),
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
  /**
   * 探索来的材料带着它走过的那张状态转移图。
   *
   * 文档来的材料没有这一项——图是「看产品」才有的东西。下游据此可以做原文做不到的事：
   * 按路径推流程、按转移算结构覆盖率。放在 schema 里而不是塞进正文，是因为它是**结构**，
   * 而结构一旦拍成文本，下游就只能再解析一次，且解析得对不对没人检查。
   */
  graph: StateFlowGraphSchema.optional(),
});
export type SpecMaterial = z.infer<typeof SpecMaterialSchema>;

/**
 * 一条规则：标准规格的最小单位。
 *
 * 有 id，所以故事可以引用它；有 `evidence`，所以「这条规则凭什么这么写」有得查——
 * 它记的是材料里的原话。一条没有出处的规则，和模型顺手编的一句话在下游是分不清的。
 */
/**
 * 一条流程：路径由图算出来，名字与目的由模型给。
 *
 * 分开的理由是它们的性质不同——路径是**事实**（走过就有），名字与目的是**判断**
 * （对用户意味着什么，图上看不出来）。混在一起，模型顺手编一条路径就没人拦得住。
 */
export const SpecFlowSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  purpose: z.string().default(""),
  /** 走完这条流程的动作序列。由 `computeFlows` 填，模型改不动。 */
  steps: z.array(z.string()).default([]),
  /**
   * 这条流程走过的转移 id（`from->to`），与 `steps` 一一对应。
   *
   * 用例要靠它声明自己验证了哪条转移，而**声明要能对上，规格里就得先写出这些 id**——
   * 第一版只渲染了人读的「登录 → 点购物车」，却要求用例引用 `from->to`：要求写了，
   * 数据没给，于是 35 条用例里只有 11 条填得出来。
   */
  transitions: z.array(z.string()).default([]),
  endsAt: z.string().default(""),
});
export type SpecFlow = z.infer<typeof SpecFlowSchema>;

/**
 * **模块**：故事图的骨架。
 *
 * 路由的聚类是算出来的事实（`computeModules`），名字是判断——和流程同一个分工。
 * 它存在的理由只有一个：故事图的横轴必须比故事**粗**。此前活动直接取流程名，而流程
 * 和故事近乎一一对应，于是七列里六列只有一个故事——那不是图，是把列表横过来排了一行。
 */
export const SpecModuleSchema = z.object({
  parentId: z.string().min(1).nullable().optional(),
  kind: z.enum(["module","submodule","function"]).optional(),
  id: z.string().min(1),
  name: z.string().default(""),
  /** 属于这个模块的流程 id。由 `computeModules` 填，模型改不动。 */
  flowIds: z.array(z.string()).default([]),
  routes: z.array(z.string()).default([]),
});
export type SpecModule = z.infer<typeof SpecModuleSchema>;

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
  source: z.string().nullish().transform((v) => v ?? undefined),
  /**
   * 海拔。只有屏幕规则的规格是一份屏幕清单，不是规格——由它推出的用例只能检查
   * 「屏幕还是不是原来的样子」。
   */
  // 2026-09-08：runinfra 的 qwen3-8-27b 在约束解码下对不知道的可选字符串给 `null` 而不是省略，
  // 整份规格因为 14 条 `about: null` 被拒。可选就是可选：null 与没给同义。
  altitude: z.enum(["screen", "flow", "domain"]).nullish().transform((v) => v ?? undefined),
  /** 它约束的是哪一屏或哪一条流程。 */
  about: z.string().nullish().transform((v) => v ?? undefined),
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
  /** 这个产品有哪些流程。路径算出来，名字模型给。 */
  flows: z.array(SpecFlowSchema).default([]),
  /** 这个产品分几块。聚类算出来，名字模型给。故事图的横轴就是它。 */
  modules: z.array(SpecModuleSchema).default([]),
  /**
   * 每一屏的业务名。屏是图上的事实，名字才交给模型——和流程、模块同一条分工。
   *
   * 没有它，产品地图只能按 URL 命名节点：13 屏时还能读，几百个 URL 时是一团谁也读不了的网。
   * 只留图上真有的 id：模型编一个不存在的屏出来，那个名字无处可挂，
   * 却会让「这个产品有几屏」这个数悄悄多一个。
   */
  screens: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  /** 材料里没有答案的地方：够不到的界面、缺凭证、没提到的规则。 */
  unknowns: z.array(z.string()).default([]),
  /** 材料从哪来，逐份列出。 */
  origin: z.string().default("inline"),
  derivedFrom: SpecProvenance.optional(),
});
export type SpecDoc = z.infer<typeof SpecDocSchema>;

export const StoryBundleSchema = z.object({
  origin: z.string().default("inline"),
  /** 规格里的流程。故事挂在它上面，用例引用它的转移 id——一路带下去。 */
  flows: z.array(SpecFlowSchema).default([]),
  /** 规格里的模块。故事的 `activity` 按它确定性回填，所以要一路带下去。 */
  modules: z.array(SpecModuleSchema).default([]),
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
  /** 规格里的流程，一路带下来——门禁要拿它校验用例声称覆盖的转移真的存在。 */
  flows: z.array(SpecFlowSchema).default([]),
  cases: z.array(TextCaseSchema).default([]),
});
export type CaseBundle = z.infer<typeof CaseBundleSchema>;


/**
 * 一条 finding 挑的是哪个字段的毛病。界面据此把光标送过去。
 *
 * 不是所有规则都指得出一个字段（「这批用例全是正常路径」说的是整批），指不出就留空——
 * 硬填一个会让「去改」按钮跳到一个跟它无关的输入框。
 */
export const FindingFieldSchema = z.enum([
  "title",
  "steps",
  "expected",
  "precondition",
  "designMethod",
  "covers",
]);
export type FindingField = z.infer<typeof FindingFieldSchema>;

/** Gate ① output: the same bundle, plus what the gate thought of it. */
export const GateFindingSchema = z.object({
  caseId: z.string().optional(),
  rule: z.string(),
  severity: z.enum(["warn", "info"]),
  message: z.string(),
  /**
   * 句子里要填的洞。
   *
   * 领域层**只产 rule + args**，一句给人看的话都不拼。此前这里拼死的那句英文过了河就是
   * 一个常量：中文界面上原样显示 `[oracle-vague] assertion names no observable phenomenon`，
   * 没有 key 也就没法译、没法配「为什么」和「怎么改」。`message` 仍然生成，
   * 因为报告、评测与日志要一句能读的话——但界面不该拿它当唯一的来源。
   */
  args: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  field: FindingFieldSchema.optional(),
});
export type GateFinding = z.infer<typeof GateFindingSchema>;

export const GateReportSchema = z.object({
  score: z.number().min(0).max(1),
  /**
   * 这个分是怎么来的：分母、把分拖下来的是哪几条、以及那条算式本身。
   *
   * 门禁的判决是这条流水线上最硬的一个结论，而它此前只给一个百分比——
   * 一个 58% 说不出「差在哪」，人只能自己去 findings 里数。分数不该是个神谕。
   */
  scoreBasis: z
    .object({
      /** 分母：参与打分的用例数。 */
      cases: z.number(),
      /** 分子那一半：被至少一条 warn 点到的用例 id。它们就是把分拖下来的那几条。 */
      flagged: z.array(z.string()),
      /**
       * 另一个因子：动作型验收准则有几条、其中哪几条没有用例真的去做。
       * 可选是为了读得动 design-gate-v1 时期存下来的报告——那时分数里没有这一半。
       */
      acceptance: z.object({ actionable: z.number(), uncovered: z.array(z.string()) }).optional(),
      /** 算式，写成人能念出来的一句。 */
      formula: z.string(),
    })
    .optional(),
  findings: z.array(GateFindingSchema),
  stats: z.object({
    cases: z.number(),
    tiers: z.record(z.string(), z.number()),
    /** The tier each case can actually deliver, from its oracle (or 3, if it has none). */
    tiersBacked: z.record(z.string(), z.number()).default({}),
    methods: z.record(z.string(), z.number()),
    negativeRatio: z.number(),
    /** 判它够不够的那条线。和比例一起给，界面才说得出「达标了没有」。 */
    minNegativeRatio: z.number().optional(),
    /** 这批故事有几条、其中几条挂在流程上——故事地图能不能画的前提。 */
    stories: z.number().optional(),
    storiesAnchored: z.number().optional(),
    /** 有多少条用例说得出自己走了哪条转移——结构覆盖率能不能算的前提。 */
    casesCovering: z.number().optional(),
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
