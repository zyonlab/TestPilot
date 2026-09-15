import { validateRulePack } from "@testpilot/harness-testing/domain";

/**
 * **把「填一个复杂字段」变成「和人聊出来」。**
 *
 * 2026-09-15 用户定的方向：规则包这类字段，在 Web UI 上点一下就打开对话抽屉，
 * 聊着聊着把这个字段生成出来；领域知识等其它复杂字段同理。
 *
 * 起因是一次实测：拿 Vikunja（待办应用）跑通用性，发现「没规则包 → 没产品模型 →
 * 工作单元循环用不了」，而规则包在 UI 上**只能上传一份写好的 JSON**
 * （`RulePacks.tsx` 就是一个 file input）。那份 JSON 有 18 个顶层字段、
 * 每条规则要写 claimType / sourceRefs / riskFloor / verification，
 * 还有一层跨字段校验。对新用户来说这条路等于关着，于是降级路径成了默认路径。
 *
 * 这个模块是那件事的另一半：每个可起草的字段在这里登记一行——
 * 它要什么上下文、产出什么形状、**由谁来判合不合格**。
 *
 * ## 校验必须在回路里
 *
 * 最要紧的一条：草稿由**这个字段自己的校验器**判定，不由模型自称。
 * `validateRulePack` 会拒收编造的东西（来源不存在、功能引用不到、claimType 与
 * 来源等级不匹配），拒收理由原样回给对话——模型照着改，人看着改了什么。
 * 一个「看起来像规则包」的东西进不了库，这是这个设计能成立的前提。
 *
 * ## 从观察来的只能是 observed
 *
 * 规则包的 claimType 分三档：normative（要求）/ observed（观察到的）/ hypothesis（假设）。
 * 探索材料是**观察**，撑不起「产品应该如此」。所以起草出来的规则一律是 observed，
 * 要升级成 normative 得有产品自己的规格撑着——那一步必须是人做的判断。
 * 这不是靠嘱咐，是 `validateRulePack` 强制的：没有 product 级来源的 normative 会被拒。
 */

export type FieldId = "rulePack" | "domainKnowledge";

export interface FieldSpec {
  id: FieldId;
  /** 给人看的名字，进抽屉标题。 */
  title: string;
  /** 给模型的任务说明。写清楚产出什么、不许产出什么。 */
  instruction: string;
  /** 受限解码的形状。顶层永远有 `reply`，字段的值放在 `valueKey` 那一栏。 */
  schema: Record<string, unknown>;
  /**
   * 模型返回的对象里，哪一栏才是这个字段的值。
   *
   * 分开是因为**回话和产物不是一回事**：reply 是说给人听的，值是要存进库的。
   * 混在一起的后果是「模型解释了一通，而那通解释被当成规则包存了下来」。
   */
  valueKey: string;
  /**
   * 判这份草稿合不合格。返回的 errors 会原样回到对话里——
   * 所以它们必须是人话，而不是一串 jsonPointer。
   */
  validate: (draft: unknown) => { ok: boolean; errors: string[] };
  /** 起草这个字段要看什么。`run` = 这次运行的探索材料与模块树。 */
  needs: ReadonlyArray<"exploration" | "modules" | "stories">;
}

/**
 * 一份包**最少**要有哪几栏。
 *
 * 从 `ProductRulePackSchema` 里没有默认值的那几个字段抄下来的，`field-draft.test.ts`
 * 把两边钉在一起。写死一份清单而不是现场反射，是因为这段字要进提示词——
 * 而提示词里的清单一旦和校验器错开，症状是「模型每次都少写一栏」，看起来像模型笨。
 */
export const RULE_PACK_REQUIRED = [
  "schemaVersion", "id", "version", "domain", "product", "network", "accountMode",
  "sources", "modules", "features",
] as const;

/**
 * **一份最小的、真的过得了校验的包**，原样放进提示词。
 *
 * 2026-09-15 第一次真跑（Vikunja，8 屏材料、8 个冻结模块）：材料确实到了模型手里——
 * 它引用了那 8 屏和真实的模块 id——可校验器回了 **39 条错，全是形状错**：
 * features 写成了字符串、rule 上挂了 `moduleId`、`verification.kind` 编了一个不存在的取值。
 * 那一轮 9250 token 花在猜形状上。
 *
 * 原因不在模型：`schema` 那一栏当时是 `{ type: "object" }`，提示词只报了顶层字段名，
 * **形状一个字没说**。这是这个仓库里反复出现的同一个毛病（见 `hand-over-the-number`）：
 * 契约不说，模型只能猜；说了就立刻对上。
 *
 * 所以这里给的不是散文描述，是一份能跑的样例。它的内容是无意义的占位
 * （`example.*`，一个不存在的产品），提示词里也明说了「抄形状，别抄内容」——
 * 样例带着领域倾向的话，换个产品就等于把别人的领域观念塞了进去。
 * `field-draft.test.ts` 让这份样例每次都真的过一遍 `validateRulePack`：
 * 它和校验器一旦错开，红的是测试，而不是用户的第一轮对话。
 */
export const RULE_PACK_EXAMPLE = {
  schemaVersion: "product-rule-pack.v1",
  id: "example-rules",
  version: "2026-09-15.1",
  domain: "example-domain",
  product: "Example App",
  network: "local",
  accountMode: "password",
  appliesTo: { urlPatterns: ["^http://localhost:3000/"], note: "整个站点：探索能去哪些地址由这一栏决定" },
  sources: [
    { id: "SRC-OBSERVED", kind: "observation", locator: "run cc-host-… 的探索材料", fetchedAt: "2026-09-15", note: "第 1–8 屏" },
  ],
  modules: [{ id: "example.area", name: "某个区域", parentId: null }],
  features: [
    { id: "example.area.do", moduleId: "example.area", name: "做某件事", description: "",
      applicability: "applicable", applicabilitySourceRefs: ["SRC-OBSERVED"] },
  ],
  rules: [
    { id: "R-EXAMPLE", featureIds: ["example.area.do"], claimType: "observed",
      statement: "做完那件事之后，列表里出现一条新的",
      appliesWhen: "在某个区域的列表页", sourceRefs: ["SRC-OBSERVED"], riskFloor: "P1", constants: {},
      verification: { kind: "ui-state", expect: { controlsPresent: ["保存"], stateChanged: [], textPresent: ["新建"] } } },
  ],
  targets: [
    { id: "T-EXAMPLE", featureId: "example.area.do", ruleRefs: ["R-EXAMPLE"],
      match: { label: ["^新建$"], roles: [], within: [] },
      action: "activate", sideEffect: "ui-only", requires: ["session"], provides: ["example-created"] },
  ],
  roles: [{ id: "example.newcomer", name: "第一次用的人", goal: "把一件事从头做完", sourceRefs: ["SRC-OBSERVED"] }],
  lifecycle: [{ id: "lc.example", name: "做完一件事", order: 0, featureIds: ["example.area.do"], sourceRefs: ["SRC-OBSERVED"] }],
  // 登录由环境配好的步骤做，产出的前提就叫 session——2026-09-15 Vikunja 那份包写成 authenticated、
  // 挂在登录按钮上，而登录是 state-change，探索永远不点，四个目标全被挡。样例得把这件事演一遍。
  externalCapabilities: ["session"],
  forbidLabels: [],
  gateLabels: [],
};

const ruleClaimNote =
  "Every rule you draft MUST use claimType \"observed\": you are reading what the product " +
  "was seen to do, not a specification of what it must do. A rule that says the product " +
  "SHOULD behave a certain way needs a product-level source, and only a person can supply " +
  "that — say so in the reply instead of inventing one.";

export const FIELDS: Record<FieldId, FieldSpec> = {
  rulePack: {
    id: "rulePack",
    title: "规则包",
    instruction: [
      "Draft a ProductRulePack for the product under test, from the observations below.",
      "A rule pack is the domain's invariants written as data: what the product requires,",
      "what it was observed doing, and what is only a guess — each with where it came from.",
      ruleClaimNote,
      "Name every source you cite in `sources` and reference it from the rule's `sourceRefs`;",
      "a rule citing a source you did not declare is rejected, and so is a fabricated one.",
      "Keep it small and true: ten rules a reader can check beat forty a reader must trust.",
      "",
      `The pack MUST have these fields: ${RULE_PACK_REQUIRED.join(", ")}. schemaVersion is the`,
      'literal "product-rule-pack.v1". Optional but valuable: appliesTo, rules, targets, roles,',
      "lifecycle, externalCapabilities, forbidLabels, gateLabels.",
      "",
      "A source you declare from the exploration material has kind \"observation\". The kinds",
      "\"official-doc\", \"product-spec\" and \"fixture-contract\" mean a document someone actually",
      "has — do not label an observation as one of those to make a normative rule pass.",
      "Every rule needs a `verification` the code can check on screen: controls that must be",
      "present, state that must change, text that must appear.",
      "",
      "LOGGING IN is not a target. The environment's configured login steps run before exploration,",
      "and they provide the capability named exactly \"session\". A target that needs a logged-in user",
      "writes requires: [\"session\"], and the pack lists \"session\" in externalCapabilities.",
      "Never make a login button provide a capability: submitting a login is state-change, exploration",
      "never clicks state-change targets, so every target waiting on it stays blocked forever.",
      "appliesTo.urlPatterns is the set of addresses exploration may navigate to. Cover every page the",
      "material shows (e.g. the site origin), not only the entry page — a pattern that matches one page",
      "confines exploration to that page.",
      "",
      "THIS IS THE EXACT SHAPE. Copy the shape, not the content — the product, the ids and the",
      "words below are meaningless placeholders, and none of it says anything about your product:",
      JSON.stringify(RULE_PACK_EXAMPLE, null, 1),
    ].join("\n"),
    needs: ["exploration", "modules"],
    valueKey: "pack",
    schema: {
      type: "object",
      properties: { reply: { type: "string" }, pack: { type: "object" } },
      required: ["reply"],
    },
    validate: (draft) => {
      const v = validateRulePack(draft);
      return v.ok
        ? { ok: true, errors: [] }
        : { ok: false, errors: v.errors.map((e) => `${e.jsonPointer || "/"}：${e.message}`) };
    },
  },
  domainKnowledge: {
    id: "domainKnowledge",
    title: "领域知识",
    instruction: [
      "Draft a short domain note for the product under test: what a newcomer must know to",
      "read its screens — the vocabulary, the units, what the numbers mean, what the product",
      "refuses and why. Write it as prose a tester reads once, not as rules.",
      "Say only what the observations support. Where you are guessing, mark the sentence",
      "【待确认】 — an unmarked guess is worse than a gap, because nobody will check it.",
    ].join("\n"),
    needs: ["exploration"],
    valueKey: "text",
    schema: {
      type: "object",
      properties: { reply: { type: "string" }, text: { type: "string" } },
      required: ["reply"],
    },
    validate: (draft) => {
      const text = draft;
      if (typeof text !== "string" || !text.trim()) return { ok: false, errors: ["草稿是空的"] };
      if (text.length > 60_000) return { ok: false, errors: [`太长了（${text.length} 字符），领域知识是给人读一遍的，不是倾倒观察`] };
      return { ok: true, errors: [] };
    },
  },
};

/**
 * `Object.hasOwn` 而不是 `in`：`"toString" in FIELDS` 是 true。
 *
 * 这个判断守的是 `/api/chat` 的 `field`，也就是**外面传进来的一个字符串**。
 * 用 `in` 的话 `field: "constructor"` 一路过关，然后 `FIELDS["constructor"].instruction`
 * 取到的是 undefined——起草面拿着一个原型链上的东西当字段规格。写这条测试时撞到的。
 */
/**
 * 这一版比上一版**少了什么**。
 *
 * 2026-09-15 真跑第二轮拍下来的：让它改 5 个 target 的一个枚举值，它回「其余字段未动」，
 * 而 features 从 8 条变成了 5 条——少的那 3 条不会报错，因为一份 5 个功能的包完全合法。
 * 这和图起草那边记着的是同一个毛病（见 `ChatDraft.warnings`）：**模型改一处会顺手重写全篇**，
 * 而重写的结果validates perfectly。
 *
 * 所以不拦（正经的修改本来就会删东西），但也绝不闷着：数一数每个数组少了几条，摆出来。
 */
export function shrinkWarnings(prev: unknown, next: unknown): string[] {
  if (!prev || typeof prev !== "object" || !next || typeof next !== "object") return [];
  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, before] of Object.entries(a)) {
    if (!Array.isArray(before)) continue;
    const after = b[key];
    if (!Array.isArray(after)) {
      if (before.length) out.push(`${key}：上一版有 ${before.length} 条，这一版没有了`);
      continue;
    }
    if (after.length < before.length) out.push(`${key}：${before.length} → ${after.length}，少了 ${before.length - after.length} 条`);
  }
  return out;
}

export const isFieldId = (v: unknown): v is FieldId => typeof v === "string" && Object.hasOwn(FIELDS, v);
