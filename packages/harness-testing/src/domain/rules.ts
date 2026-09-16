import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJSON } from "@testpilot/harness-core/run-contracts";

/**
 * 产品规则包（ProductRulePack v1）。
 *
 * 这是 docs/v3/history/20 §4、21 §2 说的那份「领域/产品规则在 source 之前绑定」的东西。
 * 内置的 REFERENCE-domain-perp.md 是通用参考，**不是**这个：那份文件下发给了两个 run，
 * 但两个 run 的项目知识版本都是 0——模型收到了一段散文，服务端没有一条可以核对的规则。
 *
 * 这里的每条规则都带 claimType（要求 / 观察 / 假设）、sourceRefs 和一个**代码能判**的
 * verification；探索回执和产品模型对着它们算，而不是对着模型的自述算。
 */
export const DomainIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/);

export const SourceRefSchema = z
  .object({
    id: DomainIdSchema,
    kind: z.enum(["official-doc", "product-spec", "fixture-contract", "domain-reference", "observation"]),
    /** URL 或仓库相对路径。 */
    locator: z.string().min(1),
    /** 行号范围、章节、锚点——精确到能再找到那一段。 */
    fragment: z.string().optional(),
    version: z.string().optional(),
    /** 文档取回的时间。`observation` 用 `observedAt`——它记的是「什么时候看见的」，不是「什么时候取的文」。 */
    fetchedAt: z.string().optional(),
    observedAt: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const ClaimTypeSchema = z.enum(["normative", "observed", "hypothesis"]);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;
export const RiskLevelSchema = z.enum(["P0", "P1", "P2"]);
export const ApplicabilitySchema = z.enum(["applicable", "not_applicable", "unresolved"]);
export type Applicability = z.infer<typeof ApplicabilitySchema>;

export const ModuleDefSchema = z
  .object({ id: DomainIdSchema, name: z.string().min(1), parentId: DomainIdSchema.nullable().default(null) })
  .strict();
export type ModuleDef = z.infer<typeof ModuleDefSchema>;

export const FeatureDefSchema = z
  .object({
    id: DomainIdSchema,
    moduleId: DomainIdSchema,
    name: z.string().min(1),
    description: z.string().default(""),
    /** 适用性和「验证了没有」是两个字段：一个功能可以适用但未验证，也可以不适用但被观察到。 */
    applicability: ApplicabilitySchema.default("unresolved"),
    applicabilitySourceRefs: z.array(DomainIdSchema).default([]),
  })
  .strict();
export type FeatureDef = z.infer<typeof FeatureDefSchema>;

/**
 * 激活一个目标之后，界面**应该**出现什么。全部是正则源串，对着 SFG 边上的 effect 判：
 * `controlsPresent` 对 after 状态的控件 display；`stateChanged` 对 effect.stateChanged 每一行
 * （形状 `button[button]: Isolated: pressed=false → pressed=true`）；`textPresent` 对 effect.textAdded。
 */
export const UiExpectationSchema = z
  .object({
    controlsPresent: z.array(z.string()).default([]),
    stateChanged: z.array(z.string()).default([]),
    textPresent: z.array(z.string()).default([]),
  })
  .strict();
export type UiExpectation = z.infer<typeof UiExpectationSchema>;

export const RuleVerificationSchema = z.discriminatedUnion("kind", [
  /** 探索阶段就能判：激活目标后核对 UI 期望。 */
  z.object({ kind: z.literal("ui-state"), expect: UiExpectationSchema }).strict(),
  /** 要执行阶段的独立判据（接口 / 账本）才能判；探索只能记 not_explorable。 */
  z.object({ kind: z.literal("api"), note: z.string().min(1) }).strict(),
  /** 产品规则本身还没确定，不能编一个期望出来。 */
  z.object({ kind: z.literal("open-question"), question: z.string().min(1) }).strict(),
]);

export const RuleSchema = z
  .object({
    id: DomainIdSchema,
    featureIds: z.array(DomainIdSchema).min(1),
    claimType: ClaimTypeSchema,
    statement: z.string().min(1),
    appliesWhen: z.string().default(""),
    sourceRefs: z.array(DomainIdSchema).default([]),
    riskFloor: RiskLevelSchema.optional(),
    unit: z.string().optional(),
    /** 常数必须写成十进制字符串并可追到来源；`"step": "0.001"`。 */
    constants: z.record(z.string()).default({}),
    verification: RuleVerificationSchema,
  })
  .strict();
export type Rule = z.infer<typeof RuleSchema>;

/** 探索目标：领域核查清单映射到「页面上应该有这么一个控件」。 */
export const ExplorationTargetSpecSchema = z
  .object({
    id: DomainIdSchema,
    featureId: DomainIdSchema,
    ruleRefs: z.array(DomainIdSchema).default([]),
    match: z
      .object({
        /** 正则源串，不区分大小写，任一命中即可。对控件的可见文案匹配。 */
        label: z.array(z.string()).min(1),
        /** 允许的标签或 ARIA 角色（`button` / `tab` / `checkbox` / `input` …）。空 = 不限。 */
        roles: z.array(z.string()).default([]),
        route: z.string().optional(),
        /**
         * **容器限定**：这个控件必须待在文案命中这些正则的容器里（弹窗、抽屉、面板）。
         *
         * 2026-09-12 实测逼出来的：`Buy / Long` 在材料里出现 45 次——它既是下单面板的
         * **方向切换**，又是确认框里的**确认键**。只按文案匹配，点到哪一个全看当时谁先被找到；
         * 那一轮探索点的是方向按钮，回执照样记成 attempted，`order.submit` 于是被判成 confirmed，
         * 而订单一张没下。`within: ["Confirm Order", "确认订单"]` 说的就是「弹窗里的那个」。
         */
        within: z.array(z.string()).default([]),
      })
      .strict(),
    /**
     * `activate` 要点它；`observe-only` 只要看见就算完成；`fill` 往它里面填一个**声明好的值**。
     *
     * `fill` 是 2026-09-12 实测逼出来的（docs/v3/history/24 §17）：会话签完之后 `Place Order` 出现了，
     * 点它**什么也没发生**——因为 Size 是空的。探索一直把输入框当 `observe-only`
     * （`activationBlocker` 里文本框一律 `unsupported:value_input`），于是提交这一步
     * 永远走不完最后一厘米。值必须写在包里、由人定：探索自己编一个数填进去，
     * 等于让它替产品决定「下多大的单」。
     */
    action: z.enum(["activate", "observe-only", "fill"]).default("activate"),
    /** `action: "fill"` 要填的值。由规则包声明，探索不自己编。 */
    value: z.string().optional(),
    /**
     * 动作的副作用等级。`state-change`（下单、平仓、撤单）永远不在探索里点，
     * 不管它的文案长什么样——不能只靠 delete/logout 词表判业务副作用。
     */
    sideEffect: z.enum(["none", "ui-only", "state-change"]).default("ui-only"),
    /** 需要的前提（`session` / `position-fixture` …）。缺了就是 blocked，不是删掉。 */
    requires: z.array(z.string()).default([]),
    /**
     * 点成之后这个目标**给出**什么前提（`requires` 的对偶）。
     *
     * 2026-09-12 实测撞出来的：`T-CONNECT`（连钱包建会话）写的是
     * `requires: ["wallet-session"]`——**它要求的正是它自己产出的东西**，于是它永远点不动，
     * 连着 `order.submit` 也永远验不了；四次探索里它四次以 `requires:wallet-session` 被挡，
     * 那四行看起来还像是策略在正常工作。能力从哪来必须写出来，写出来才查得了。
     */
    provides: z.array(z.string()).default([]),
    expectedStates: z.array(z.string()).default([]),
    /**
     * 点完这一下，**屏幕上必须出现什么**（正则，逐条对效果里的新增文字/新增控件/变化状态匹配）。
     *
     * 2026-09-12 实测逼出来的：机器臂把下单链一路走到弹窗里的确认键、点了它，产品模型据此把
     * 「提交订单」判成 confirmed——而同一时刻账户页上写着「尚无开放仓位」，单根本没下成。
     * 它数的效果是上一步「弹窗打开了」。**弹窗打开不是订单提交**。
     * 判决和用例判据必须是同一套标准：从屏幕上读（CLAUDE.md「判决必须在屏幕上」）。
     * 不声明就退回旧口径（有效果且不是闸门即 confirmed）——声明了，就以屏幕为准。
     */
    expectOnScreen: z.array(z.string()).default([]),
  })
  .strict();
export type ExplorationTargetSpec = z.infer<typeof ExplorationTargetSpecSchema>;

export const ProductRulePackSchema = z
  .object({
    schemaVersion: z.literal("product-rule-pack.v1"),
    id: DomainIdSchema,
    /**
     * 版本号会被**拼进 charter 的 id**（`charter-<packId>-<version>`，见 `charter.ts`），
     * 而那个 id 受 `DomainIdSchema` 约束。所以这里跟着用同一套字符集。
     *
     * 2026-09-16 实测：迁移时把版本写成 `2026-09-13.3+domain-data`，存得下（当时只校验
     * 非空），真拿去建 charter 时才炸——探索节点开始 4 毫秒就失败，错误是一条
     * `path: ["id"]` 的 zod 正则错，看不出跟版本号有关。存的时候拒，错误才指得到字段。
     */
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/, "version 只能用字母数字与 _ . : / -（它会拼进 charter 的 id）"),
    domain: z.string().min(1),
    product: z.string().min(1),
    network: z.string().min(1),
    accountMode: z.string().min(1),
    appliesTo: z.object({ urlPatterns: z.array(z.string()).default([]), note: z.string().default("") }).strict().default({}),
    sources: z.array(SourceRefSchema).min(1),
    modules: z.array(ModuleDefSchema).min(1),
    features: z.array(FeatureDefSchema).min(1),
    rules: z.array(RuleSchema).default([]),
    targets: z.array(ExplorationTargetSpecSchema).default([]),
    /**
     * **谁在用这个产品。**
     *
     * 2026-09-12 实测：一次运行产出 26 条故事，`role` 全是同一个词——角色是模型现编的，
     * 包里根本没有这样东西可参照。角色不同，同一个功能该验的东西就不同
     * （第一次用的人关心「走不走得通」，老手关心「快不快、错了拦不拦得住」）。
     * 所以它和模块、规则一样是**领域事实**，写在包里、由人认领，不由模型发挥。
     */
    roles: z.array(z.object({
      id: DomainIdSchema,
      name: z.string().min(1),
      /** 这个角色来这里要达成什么。故事的「以便 Z」应当落在它上面。 */
      goal: z.string().min(1),
      sourceRefs: z.array(DomainIdSchema).default([]),
    }).strict()).default([]),
    /**
     * **这个产品的生命周期**：用户从进门到走完一个完整闭环，中间必经的几段。
     *
     * 优先级不该靠感觉：一条故事在不在主链上，是可以查的事实。
     * 有了它，P0 的定义就变成「少了它，这条生命周期走不完」——而不是「看起来重要」。
     * 阶段按 `order` 排；`featureIds` 是这一段落在哪些功能上（可留空，表示还没对上）。
     */
    lifecycle: z.array(z.object({
      id: DomainIdSchema,
      name: z.string().min(1),
      order: z.number().int().nonnegative(),
      featureIds: z.array(DomainIdSchema).default([]),
      sourceRefs: z.array(DomainIdSchema).default([]),
    }).strict()).default([]),
    /**
     * 探索**拿不到、只能由外面准备好**的前提（`session` / `position-fixture` …）。
     *
     * 有了它，「这个目标要的东西谁给」就有了唯一答案：要么某个目标 `provides` 它，
     * 要么这里声明它来自外部。两样都没有 = 那个目标永远点不动，而这在实测里
     * 表现为四行看起来很正常的 `blocked`。见下面 `target_requires_unprovidable`。
     */
    externalCapabilities: z.array(z.string()).default([]),
    /**
     * 这个产品特有的**禁点文案**，接在通用默认后面。
     *
     * `DEFAULT_FORBID_LABELS` 里原来混着「下单 / 平仓 / 撤单 / 充值 / 提现 / close position /
     * cancel all」这类**只有交易类产品才有**的词。通用生成器里写死一个行业的词表，等于
     * 换个产品就带着别人的副作用观念去探索：一个 CMS 的「发布」拦不住，一个交易页的「下单」
     * 又会误伤「下单面板」。产品特有的词跟着规则包走，通用的留在默认里。
     */
    forbidLabels: z.array(z.string()).default([]),
    /**
     * **闸门文案**：点完之后冒出这些字，说明只走到了一道门前，行为并没有发生。
     *
     * 2026-09-12 实测：探索点了「全仓」，弹出保证金模式弹窗，回执记下「新控件：Establish Connection」，
     * 于是 `order.margin-mode` 被判成 **confirmed**——而那个弹窗的主按钮是「建立连接」，
     * 保证金模式**一次都没切成**。`order.submit` 同理：点出一个确认框就算「提交已验证」。
     *
     * `confirmed` 本来的意思是「这个功能被证实了」，实际做的判断只是「控件有反应」。
     * 闸门文案是把这两件事分开的最小机制：识别到闸门 → 记 `inconclusive` 并说明卡在哪，不冒充确证。
     * 文案按产品走（连钱包、二次确认、短信验证码各行各业长得都不一样），所以写在规则包里。
     */
    gateLabels: z.array(z.string()).default([]),
    /**
     * **这个产品特有的动作词**，接在通用动作词后面（门禁与验收准则索引用来判「这条准则要人动手」）。
     *
     * 通用表里原来混着「下单 / 撤单 / 平仓 / 开仓 / 转账 / 充值 / 提现 / 划转」——只有交易类产品才有的词，
     * 焊在对每个产品都生效的正则里。2026-09-15 挪到这里：交易所的包写它们，待办应用的包不写。
     */
    actionVocabulary: z.array(z.string().min(1)).default([]),
    /**
     * **这个产品特有的不可逆操作**，接在通用那张（删除 / 支付 / 退款…）后面，执行守卫用。
     * 每条是正则（和 `forbidLabels` 一样），才写得出「动作要拦、名词别误伤」：`下单(?!面板|区)`。
     */
    sideEffectLabels: z.array(z.string().min(1)).default([]),
    /**
     * **这个产品会自己变的读数叫什么**（比如某个价格、某个倒计时）。门禁看到断言把它们钉在一个数上就报；
     * 通用规则只认数字的形状（时刻、长小数百分比、大额数字），认不出名字。
     */
    volatileReadings: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ProductRulePack = z.infer<typeof ProductRulePackSchema>;

export interface PackError {
  code: string;
  jsonPointer: string;
  ruleId?: string;
  message: string;
}

const uniq = <T extends { id: string }>(xs: T[], pointer: string, errors: PackError[]): Map<string, T> => {
  const m = new Map<string, T>();
  xs.forEach((x, i) => {
    if (m.has(x.id)) errors.push({ code: "duplicate_id", jsonPointer: `${pointer}/${i}/id`, message: `duplicate id ${x.id}` });
    m.set(x.id, x);
  });
  return m;
};

/**
 * 结构之外的硬事实校验：悬空引用、无来源的要求、无依据的 P0、模块环。
 * 全部是确定性阻断；模型置信度再高也不能替代 sourceRef。
 */
export function validateRulePack(raw: unknown): { ok: true; pack: ProductRulePack; hash: string } | { ok: false; errors: PackError[] } {
  const parsed = ProductRulePackSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, errors: parsed.error.issues.map((i) => ({ code: "schema", jsonPointer: "/" + i.path.join("/"), message: i.message })) };
  const pack = parsed.data;
  const errors: PackError[] = [];
  const sources = uniq(pack.sources, "/sources", errors);
  const modules = uniq(pack.modules, "/modules", errors);
  const features = uniq(pack.features, "/features", errors);
  const rules = uniq(pack.rules, "/rules", errors);
  uniq(pack.targets, "/targets", errors);
  /**
   * **要得到的前提，得有地方给。**
   *
   * 2026-09-12：`T-CONNECT` 写 `requires: ["wallet-session"]`，而全包上下没有任何东西
   * 产出 `wallet-session`——它要求的正是它自己要产出的东西。结果是这个目标永远被挡，
   * `account.connect` 与 `order.submit` 永远验不了，而探索回执上只是四行
   * `requires:wallet-session`，看起来像是策略在正常工作。**一个永远满足不了的前提
   * 不是一道闸门，是一个死目标**，得在校验时就说出来。
   */
  pack.targets.forEach((t, i) => {
    // `expectedStates` 从来没有人读过。留着字段是为了旧包还能装载，但写了内容就是白写——说出来。
    if (t.expectedStates.length)
      errors.push({ code: "expected_states_not_implemented", jsonPointer: `/targets/${i}/expectedStates`,
        message: `目标 ${t.id} 写了 expectedStates，但没有任何代码读它。要声明「点完屏幕上该出现什么」，用 expectOnScreen` });
    if (t.expectOnScreen.length && t.action === "observe-only")
      errors.push({ code: "expect_on_screen_without_activation", jsonPointer: `/targets/${i}/expectOnScreen`,
        message: `目标 ${t.id} 只看不点，却声明了点完该出现什么` });
  });
  pack.targets.forEach((t, i) => {
    if (t.action === "fill" && !t.value)
      errors.push({ code: "fill_target_without_value", jsonPointer: `/targets/${i}/value`,
        message: `目标 ${t.id} 是 fill，但没有声明要填什么值——探索不会自己编一个` });
    if (t.action !== "fill" && t.value !== undefined)
      errors.push({ code: "value_on_non_fill_target", jsonPointer: `/targets/${i}/value`,
        message: `目标 ${t.id} 不是 fill，却带了 value` });
  });
  const providable = new Set([...pack.externalCapabilities, ...pack.targets.flatMap((t) => t.provides)]);
  pack.targets.forEach((t, i) => {
    for (const need of t.requires) {
      if (providable.has(need)) continue;
      errors.push({ code: "target_requires_unprovidable", jsonPointer: `/targets/${i}/requires`,
        message: `目标 ${t.id} 要求前提 ${need}，但没有任何目标 provides 它，externalCapabilities 里也没有声明它来自外部——它永远点不动` });
    }
    if (t.provides.some((p) => t.requires.includes(p)))
      errors.push({ code: "target_requires_what_it_provides", jsonPointer: `/targets/${i}`,
        message: `目标 ${t.id} 同时 requires 和 provides ${t.provides.filter((p) => t.requires.includes(p)).join(",")}：它要求的正是它自己产出的东西` });
  });
  /**
   * **一个文案不能被两个会改状态的目标同时认领。**
   *
   * 2026-09-12 实测：`T-SUBMIT` 写 `^Enable Trading$`，`T-CONNECT` 写 `Connect|Enable Trading`。
   * 页面上那个「Enable Trading」按钮两个目标都命中，于是歧义检查把两个一起挡掉——
   * 回执上是对称的两行 `policy:matches_state_change:…`，看着像策略在正常工作，
   * 实际是整条下单链第一步就没起步（那一轮 11 个目标点成，确认键 not_found）。
   * 歧义检查本身没错：分不清是哪一个就不许点。错在包里同一个按钮有两个主人。
   *
   * 只查「字面量」文案（`^X$`、没有正则元字符的那种）撞上另一个目标的模式：
   * 正则与正则是否相交不可判定，但真实包里的冲突几乎都是这一种，而且零误报。
   * `within` 把两边分开时不算冲突——那正是容器限定要解决的事。
   */
  const literal = (p: string): string | undefined => {
    const m = /^\^([^\\^$.*+?()[\]{}|]+)\$$/.exec(p);
    return m ? m[1] : undefined;
  };
  const stateChanging = pack.targets.filter((t) => t.sideEffect === "state-change");
  pack.targets.forEach((t, i) => {
    for (const pat of t.match.label) {
      const lit = literal(pat);
      if (!lit) continue;
      for (const other of stateChanging) {
        if (other.id === t.id) continue;
        if (t.match.within.length && other.match.within.length) continue;
        if (t.match.within.length !== other.match.within.length) continue;
        if (!other.match.label.some((o) => { try { return new RegExp(o, "i").test(lit); } catch { return false; } })) continue;
        errors.push({ code: "target_label_claimed_twice", jsonPointer: `/targets/${i}/match/label`,
          message: `文案「${lit}」同时属于目标 ${t.id} 和会改状态的 ${other.id}：页面上那一个控件两边都命中，歧义检查会把两个一起挡掉。把文案分给一个主人，或者用 match.within 把它们限定在各自的容器里` });
      }
    }
  });
  pack.lifecycle.forEach((l, i) => {
    l.featureIds.forEach((f, j) => {
      if (!features.has(f)) errors.push({ code: "dangling_ref", jsonPointer: `/lifecycle/${i}/featureIds/${j}`, message: `feature ${f} missing` });
    });
    l.sourceRefs.forEach((sref, j) => {
      if (!sources.has(sref)) errors.push({ code: "dangling_ref", jsonPointer: `/lifecycle/${i}/sourceRefs/${j}`, message: `source ${sref} missing` });
    });
    if (pack.lifecycle.filter((x) => x.order === l.order).length > 1)
      errors.push({ code: "lifecycle_order_collision", jsonPointer: `/lifecycle/${i}/order`,
        message: `生命周期阶段 ${l.id} 的 order=${l.order} 和别的阶段撞了：主链的先后要是确定的` });
  });
  pack.roles.forEach((r, i) => {
    r.sourceRefs.forEach((sref, j) => {
      if (!sources.has(sref)) errors.push({ code: "dangling_ref", jsonPointer: `/roles/${i}/sourceRefs/${j}`, message: `source ${sref} missing` });
    });
  });
  pack.modules.forEach((m, i) => {
    const seen = new Set<string>([m.id]);
    let p = m.parentId;
    while (p) {
      if (seen.has(p)) { errors.push({ code: "module_cycle", jsonPointer: `/modules/${i}/parentId`, message: `cycle through ${p}` }); break; }
      seen.add(p);
      const parent = modules.get(p);
      if (!parent) { errors.push({ code: "dangling_ref", jsonPointer: `/modules/${i}/parentId`, message: `module ${p} missing` }); break; }
      p = parent.parentId;
    }
  });
  pack.features.forEach((f, i) => {
    if (!modules.has(f.moduleId)) errors.push({ code: "dangling_ref", jsonPointer: `/features/${i}/moduleId`, message: `module ${f.moduleId} missing` });
    f.applicabilitySourceRefs.forEach((s, j) => {
      if (!sources.has(s)) errors.push({ code: "dangling_ref", jsonPointer: `/features/${i}/applicabilitySourceRefs/${j}`, message: `source ${s} missing` });
    });
    if (f.applicability !== "unresolved" && !f.applicabilitySourceRefs.length)
      errors.push({ code: "applicability_without_source", jsonPointer: `/features/${i}/applicability`, message: `${f.id}: applicability claimed without a source` });
  });
  pack.rules.forEach((r, i) => {
    r.featureIds.forEach((f, j) => {
      if (!features.has(f)) errors.push({ code: "dangling_ref", jsonPointer: `/rules/${i}/featureIds/${j}`, ruleId: r.id, message: `feature ${f} missing` });
    });
    r.sourceRefs.forEach((s, j) => {
      if (!sources.has(s)) errors.push({ code: "dangling_ref", jsonPointer: `/rules/${i}/sourceRefs/${j}`, ruleId: r.id, message: `source ${s} missing` });
    });
    if (r.claimType === "normative") {
      const grounded = r.sourceRefs.some((s) => ["official-doc", "product-spec", "fixture-contract"].includes(sources.get(s)?.kind ?? ""));
      if (!grounded)
        errors.push({ code: "normative_without_product_source", jsonPointer: `/rules/${i}/sourceRefs`, ruleId: r.id, message: `${r.id}: a normative rule needs an official/product/fixture source; domain references only support hypotheses` });
    }
    // P0 下限只能挂在有产品来源的要求上：一条假设不能把优先级钉死，那正是「无依据 P0」。
    if (r.riskFloor === "P0" && (r.claimType !== "normative" || !r.sourceRefs.length))
      errors.push({ code: "p0_without_source", jsonPointer: `/rules/${i}/riskFloor`, ruleId: r.id, message: `${r.id}: P0 floor needs a normative rule with a product source` });
    if (r.verification.kind === "ui-state") {
      const e = r.verification.expect;
      if (!e.controlsPresent.length && !e.stateChanged.length && !e.textPresent.length)
        errors.push({ code: "empty_ui_expectation", jsonPointer: `/rules/${i}/verification/expect`, ruleId: r.id, message: `${r.id}: ui-state verification with nothing to check` });
      for (const [k, list] of Object.entries(e))
        (list as string[]).forEach((re, j) => {
          try { new RegExp(re, "i"); } catch { errors.push({ code: "bad_regex", jsonPointer: `/rules/${i}/verification/expect/${k}/${j}`, ruleId: r.id, message: `${re}` }); }
        });
    }
  });
  pack.targets.forEach((t, i) => {
    if (!features.has(t.featureId)) errors.push({ code: "dangling_ref", jsonPointer: `/targets/${i}/featureId`, message: `feature ${t.featureId} missing` });
    t.ruleRefs.forEach((r, j) => {
      if (!rules.has(r)) errors.push({ code: "dangling_ref", jsonPointer: `/targets/${i}/ruleRefs/${j}`, message: `rule ${r} missing` });
    });
    t.match.label.forEach((re, j) => {
      try { new RegExp(re, "i"); } catch { errors.push({ code: "bad_regex", jsonPointer: `/targets/${i}/match/label/${j}`, message: re }); }
    });
    if (t.match.route) { try { new RegExp(t.match.route); } catch { errors.push({ code: "bad_regex", jsonPointer: `/targets/${i}/match/route`, message: t.match.route }); } }
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, pack, hash: rulePackHash(pack) };
}

export const rulePackHash = (pack: ProductRulePack): string =>
  createHash("sha256").update(canonicalJSON(pack)).digest("hex");
