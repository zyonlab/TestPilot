import { readFileSync } from "node:fs";
import { z } from "zod";
import { ABLATABLE, fitToBudget, type ModelClient, type NodeDef } from "@testpilot/harness-core";
import {
  CASES_SCHEMA,
  CASES_STABLE,
  CASES_STABLE_PLAIN,
  ORACLE_STRICT,
  STORIES_SCHEMA,
  STORIES_STABLE,
  casesVariable,
  storiesVariable,
  COMPOSE_STABLE,
  composeVariable,
  COMPOSE_SCHEMA,
} from "./prompts.js";
import { locate, overlaps, splitDocuments } from "./attribute.js";
import { runGate } from "./gate.js";
import {
  CaseBundleSchema,
  GatedBundleSchema,
  KIND,
  SpecMaterialSchema,
  StoryBundleSchema,
  StorySchema,
  TextCaseSchema,
  type CaseBundle,
  type TextCase,
  SpecDocSchema,
  SpecRuleSchema,
} from "./types.js";

/**
 * G1: specification → user stories → text cases → gate ①.
 *
 * The control shape here is a deterministic pipeline, not an agent loop, and that is the
 * point: this stage's product is compared between versions ("what does this run cover that
 * the last one did not"), and a pipeline that takes a different path each time has nothing
 * to compare. Exploration — where the steps genuinely cannot be known in advance — is the
 * one branch that gets to be an agent.
 */

/** Pull a JSON object out of a model reply that may be wrapped in prose or fences. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseJson<T>(
  text: string,
  schema: z.ZodType<T, z.ZodTypeDef, any>,
  label: string,
  opts: { truncated?: boolean; maxTokens?: number } = {},
): T {
  const cutOff = opts.truncated
    ? ` — the reply was cut off at maxTokens${opts.maxTokens ? ` (${opts.maxTokens})` : ""}, so this is a budget problem, not a formatting one`
    : "";
  const cleaned = text.replace(/```[a-z]*\n?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`${label}: no JSON object in the reply${cutOff}`);
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    throw new Error(`${label}: reply is not valid JSON${cutOff} — ${(e as Error).message}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `${label}: reply does not match the expected shape — ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
        .join("; ")}`,
    );
  return parsed.data;
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9一-龥]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "case";

/**
 * 看一眼跑着的产品。
 *
 * 和 `CaseExecutor` 一样是注入进来的：这个进程既没有浏览器也没有数据库，
 * 谁有谁提供。返回的是**观察到的东西**，不是用例——把观察直接变成用例，
 * 等于把「产品现在这样」直接写成「产品应该这样」，中间那步判断被跳过了。
 */
export interface ProductObserver {
  observe(input: {
    url?: string;
    deep?: boolean;
    settleMs?: number;
    maxScreens?: number;
    dryRounds?: number;
    stateAbstraction?: string;
  }): Promise<{
    /** 观察到的界面材料：页面文本、可见控件、走过的路径。 */
    notes: string;
    /** 实际访问到的地址，用于追溯。 */
    url: string;
    /** 走到过几屏，以及为什么停下来。一份薄材料要能说出自己为什么薄。 */
    screens?: number;
    stoppedBecause?: string;
    /** 走过的状态转移图：点和边。 */
    graph?: unknown;
  }>;
}

export interface CaseGenNodeOptions {
  model: ModelClient;
  /** Where relative spec paths resolve from. */
  baseDir?: string;
  /** Present when this process can reach a browser. */
  observer?: ProductObserver;
}

/**
 * Read the specification. A source node: it produces without consuming.
 *
 * Several paths are joined rather than one being chosen, because a product's specification
 * usually is several documents — what it does and how it behaves on screen live apart, and
 * a case designer needs both.
 */
export function sourceSpecNode(
  opts: CaseGenNodeOptions,
): NodeDef<{ path?: string; paths?: string[]; text?: string }, unknown, z.infer<typeof SpecMaterialSchema>> {
  return {
    type: "source.spec",
    title: "User documents",
    description: "Read the documents the user gave us — material, not yet a specification",
    inKind: null,
    // 材料，不是规格：用户给的东西什么形状都有，先整理再用。
    outKind: KIND.material,
    params: z.object({
      path: z.string().optional(),
      paths: z.array(z.string()).optional(),
      text: z.string().optional(),
    }),
    input: z.unknown(),
    output: SpecMaterialSchema,
    run: async (_input, params) => {
      if (params.text) return { text: params.text, origin: "inline", derivedFrom: "document" as const };
      const paths = params.paths?.length ? params.paths : params.path ? [params.path] : [];
      if (!paths.length) throw new Error("source.spec needs `text`, `path` or `paths`");
      const parts = paths.map((p) => {
        const full = p.startsWith("/") ? p : `${opts.baseDir ?? process.cwd()}/${p}`;
        // Each document keeps its name in the material: a story traced back to "the spec"
        // is barely traced at all when the spec is four files.
        return `===== ${p} =====\n${readFileSync(full, "utf8")}`;
      });
      return { text: parts.join("\n\n"), origin: paths.join(", "), derivedFrom: "document" as const };
    },
  };
}

/**
 * 探索产品，写出一份规格。
 *
 * 这是黑盒那条路：**explore → spec → 故事 → 用例**，而不是 explore 直接产用例。
 * 多出来的那一步不是仪式——它是把「产品现在是这样」写成一份可读、可批改、可版本化的东西，
 * 然后才由它推出故事。跳过它，观察就直接变成了断言，中间没有任何一处可以让人说
 * 「这条不该这么写」。
 *
 * 它和 `source.spec` 产出同一种东西（`KIND.spec`），所以下游一个字都不用改：
 * 材料从哪来是这一层的事，怎么用是下一层的事。区别只在 `derivedFrom` 这个印记上——
 * 而那个印记很重要，见 `SpecProvenance`。
 */
export function sourceExploreNode(
  opts: CaseGenNodeOptions,
): NodeDef<
  {
    url?: string;
    deep: boolean;
    settleMs?: number;
    maxScreens: number;
    dryRounds: number;
    stateAbstraction: string;
    lang?: string;
    maxTokens?: number;
  },
  unknown,
  z.infer<typeof SpecMaterialSchema>
> {
  return {
    type: "source.explore",
    title: "Explore the product",
    description: "Drive the running product and record what it does — material, not yet a specification",
    inKind: null,
    outKind: KIND.material,
    params: z.object({
      /** 留空则用这次运行的目标端地址。 */
      url: z.string().optional(),
      /** 往前走，而不是只看入口页。 */
      deep: z.boolean().default(true),
      settleMs: z.number().int().min(0).max(20000).optional(),
      /**
       * 最多采到几屏。探索的成本闸：每往前一屏一次模型调用，本地模型一次几十秒。
       *
       * 默认 6 是个折中。此前这个数**恒等于 2**（入口页 + 往前一屏），对任何一个登录页
       * 之后还有几屏的产品，材料里都缺着大半，而缺的部分在下游看不出来。
       */
      maxScreens: z.number().int().min(1).max(30).default(6),
      /** 连续几轮没发现新界面就停。产品有几屏事先不知道，所以不按固定轮数走。 */
      dryRounds: z.number().int().min(1).max(8).default(3),
      /**
       * 状态抽象：`route` / `route+controls` / `route+controls+title` / `url+controls`。
       *
       * 它决定「这算不算一屏新的」，是探索有效性的关键变量——过松漏测，过紧冗余。
       * 做成参数是为了能消融、能和别人的结果比，而不是写死一把尺子。
       */
      stateAbstraction: z.string().default("route+controls"),
      lang: z.string().optional(),
      maxTokens: z.number().int().min(400).max(16000).default(2400),
    }),
    input: z.unknown(),
    output: SpecMaterialSchema,
    run: async (_input, params, ctx) => {
      if (!opts.observer) throw new Error("source.explore has no way to reach the product");
      const seen = await opts.observer.observe({
        url: params.url,
        deep: params.deep,
        settleMs: params.settleMs,
        maxScreens: params.maxScreens,
        dryRounds: params.dryRounds,
        stateAbstraction: params.stateAbstraction,
      });
      if (!seen.notes.trim()) throw new Error("source.explore saw nothing it could describe");
      // 走到几屏、为什么停，是判断这份材料薄不薄的唯一依据——一屏和六屏产出的规格
      // 看起来一样规整，差别只在它没写的那部分。
      ctx.emit("wf.node.output", {
        nodeId: ctx.nodeId,
        observed: seen.url,
        screens: seen.screens,
        stoppedBecause: seen.stoppedBecause,
      });
      if (seen.screens !== undefined && seen.screens <= 1)
        ctx.emit("log", {
          stream: "source.explore",
          text: `只采到 ${seen.screens} 屏（${seen.stoppedBecause ?? "原因不明"}）——这份材料只覆盖入口页`,
        });

      // 观察记录原样往下走。把它整理成规格是 `spec.compose` 的事——观察与解读分开，
      // 三种来源才可能整理成同一个形状。
      const g = seen.graph as { states?: unknown[]; transitions?: unknown[] } | undefined;
      if (g)
        ctx.emit("log", {
          stream: "source.explore",
          text: `状态转移图：${g.states?.length ?? 0} 个状态，${g.transitions?.length ?? 0} 条转移（抽象 ${params.stateAbstraction}）`,
        });
      return {
        text: seen.notes,
        origin: `explored ${seen.url}`,
        derivedFrom: "exploration" as const,
        // 图跟着材料走。结构留在结构里，不拍成文本让下游再解析一次。
        ...(seen.graph ? { graph: seen.graph as never } : {}),
      };
    },
  };
}

/**
 * 材料 → **标准规格**。
 *
 * 整个流程里唯一产出规格的地方。用户文档、探索记录、（以后）代码摘要，到这里被整理成同一个
 * 形状，下游从此只认这一种东西——此前下游是直接吃原始文档的，于是「用户这次给的是什么格式」
 * 这个问题被复制到了每一个节点里。
 *
 * 整理不是创作：材料没说的进「没有答案的地方」，不凭常识补一条看起来合理的规则。
 */
export function composeSpecNode(
  opts: CaseGenNodeOptions,
): NodeDef<
  { lang?: string; maxTokens: number; maxRules: number },
  z.infer<typeof SpecMaterialSchema>,
  z.infer<typeof SpecDocSchema>
> {
  return {
    type: "spec.compose",
    title: "Compose the specification",
    description: "Organise raw material into the one standard specification shape",
    inKind: KIND.material,
    outKind: KIND.spec,
    params: z.object({
      lang: z.string().optional(),
      maxTokens: z.number().int().min(600).max(16000).default(3000),
      maxRules: z.number().int().min(1).max(200).default(60),
    }),
    input: SpecMaterialSchema,
    output: SpecDocSchema,
    run: async (material, params, ctx) => {
      const res = await opts.model.chat({
        stable: COMPOSE_STABLE,
        variable: composeVariable(material.text, material.origin ?? "inline", material.derivedFrom ?? "document", params.lang),
        schema: COMPOSE_SCHEMA,
        maxTokens: params.maxTokens,
        label: "spec.compose",
      });
      ctx.spend({ calls: 1, tokens: res.tokens });

      const parsed = parseJson(
        res.text,
        z.object({
          title: z.string().default(""),
          summary: z.string().default(""),
          rules: z.array(SpecRuleSchema).default([]),
          unknowns: z.array(z.string()).default([]),
        }),
        "spec.compose",
        { truncated: res.truncated, maxTokens: params.maxTokens },
      );

      const rules = parsed.rules.slice(0, params.maxRules);
      if (!rules.length)
        throw new Error("spec.compose: the material produced no rules — nothing downstream could be traced to it");

      /**
       * 把每条规则的原话定位回它出自哪份材料。
       *
       * 定位是确定性的字符串包含，不是再问一次模型：一个"你这句是不是原话"的自评，
       * 量的是模型的自信，不是事实。定位不到的分两种，含义差得很远，所以分开报。
       */
      const docs = splitDocuments(material.text, material.origin ?? "inline");
      const located = rules.map((r) => ({ ...r, source: locate(r.evidence, docs) }));

      // 没有出处的规则是编出来的。不静默丢弃，也不静默接受：留下来，但记一笔，
      // 让门禁和追溯都能看见这份规格里有多少是无根的。
      const unsupported = located.filter((r) => !r.evidence.trim()).length;
      if (unsupported)
        ctx.emit("log", {
          stream: "spec.compose",
          text: `${unsupported}/${located.length} 条规则没有材料原话作为出处——它们在下游无法自证`,
        });
      // 比没有出处更值得看一眼：给了出处，但那句话在材料里查不到。
      const fabricated = located.filter((r) => r.evidence.trim() && !r.source).length;
      if (fabricated)
        ctx.emit("log", {
          stream: "spec.compose",
          text: `${fabricated}/${located.length} 条规则给出的"原话"在材料里定位不到——它是转述或是编的，不是原话`,
        });
      if (!parsed.unknowns.length)
        ctx.emit("log", {
          stream: "spec.compose",
          text: "这份规格声称材料里没有任何未决之处——这是一个很强的断言，值得人看一眼",
        });

      const text = [
        parsed.title ? `# ${parsed.title}` : "",
        parsed.summary,
        "",
        "## 规则",
        ...located.map((r) => `- **${r.id}** ${r.text}${r.evidence ? `\n  > ${r.evidence}` : ""}`),
        "",
        "## 没有答案的地方",
        ...(parsed.unknowns.length ? parsed.unknowns.map((u) => `- ${u}`) : ["- （整理者认为没有）"]),
      ]
        .filter((x) => x !== "")
        .join("\n");

      ctx.emit("wf.node.output", {
        nodeId: ctx.nodeId,
        rules: located.length,
        unknowns: parsed.unknowns.length,
        grounded: located.filter((r) => r.source).length,
      });
      return {
        title: parsed.title,
        text,
        rules: located,
        unknowns: parsed.unknowns,
        origin: material.origin,
        derivedFrom: material.derivedFrom,
      };
    },
  };
}

/** Specification → user stories. One model call: the whole document is the material. */
export function planStoriesNode(
  opts: CaseGenNodeOptions,
): NodeDef<
  { maxStories: number; lang?: string; maxTokens?: number },
  z.infer<typeof SpecDocSchema>,
  z.infer<typeof StoryBundleSchema>
> {
  return {
    type: "plan.stories",
    title: "Stories",
    description: "Split a specification into user stories with their acceptance criteria",
    inKind: KIND.spec,
    outKind: KIND.stories,
    params: z.object({
      maxStories: z.number().int().min(1).max(50).default(12),
      lang: z.string().optional(),
      /** Story descriptions run ~200 tokens each; a real spec needs more room than a mock one. */
      maxTokens: z.number().int().min(400).max(16000).optional(),
    }),
    input: SpecDocSchema,
    output: StoryBundleSchema,
    run: async (spec, params, ctx) => {
      const maxTokens = params.maxTokens ?? Math.max(1200, params.maxStories * 260);
      const res = await opts.model.chat({
        stable: STORIES_STABLE,
        variable: storiesVariable(spec.text, params.lang),
        schema: STORIES_SCHEMA,
        maxTokens,
        label: "plan.stories",
      });
      ctx.spend({ calls: 1, tokens: res.tokens });
      const parsed = parseJson(res.text, z.object({ stories: z.array(StorySchema) }), "plan.stories", {
        truncated: res.truncated,
        maxTokens,
      });
      const raw = parsed.stories.slice(0, params.maxStories);
      if (!raw.length) throw new Error("plan.stories: the reply contained no stories");

      const docs = spec.origin.split(", ").filter((d) => d.includes("/"));

      /**
       * 故事出自哪份文档：先定位，定不到才退回模型的说法。
       *
       * 一个查得出来的事实不该让位给一句声称。定位走的是规格里那些**已经被定位过**的规则：
       * 故事的验收标准应当是规格的原话，所以它对得上哪条规则，就跟着那条规则的出处走。
       *
       * 模型的说法只在定不到时才用，而且必须指向一份这次运行真的读过的文档——它此前可以
       * 指向任何字符串，包括一份从来没参与过这次运行的文件，而下游没人核对。
       */
      const attribute = (st: (typeof raw)[number]): (typeof raw)[number] => {
        for (const line of st.acceptance ?? []) {
          const hit = (spec.rules ?? []).find(
            (r) => r.source && (overlaps(line, r.text) || overlaps(line, r.evidence)),
          );
          if (hit?.source) return { ...st, source: hit.source, sourceBy: "located" as const };
        }
        const claimed = st.source?.trim();
        const known = claimed && docs.find((d) => d.includes(claimed) || claimed.includes(d));
        // 指不到任何一份读过的文档的说法直接丢掉：留着它，界面上就会显示一个查无此处的
        // 文件名，而那比空着更难发现。
        return known
          ? { ...st, source: known, sourceBy: "claimed" as const }
          : { ...st, source: undefined, sourceBy: undefined };
      };
      const stories = raw.map(attribute);

      // A document that produced no story is a silent hole: everything downstream looks
      // healthy, and the miss only surfaces much later as a coverage number with no
      // explanation. Say it here, where the cause is still visible.
      if (docs.length > 1) {
        const attributed = stories.map((st) => st.source).filter((x): x is string => !!x);
        if (!attributed.length) {
          // Every story unattributed is a different problem from every document being
          // ignored, and saying the second when the first is true sends people looking for
          // a decomposition bug that is not there.
          ctx.emit("log", {
            stream: "plan.stories",
            text: "没有一条故事能定位到它出自哪份文档——无法判断每份材料是否都被覆盖到",
          });
        } else {
          const silent = docs.filter((d) => !attributed.includes(d));
          if (silent.length)
            ctx.emit("log", {
              stream: "plan.stories",
              text: `没有故事出自：${silent.join(", ")} —— 提高 maxStories，或把这次运行拆开`,
            });
        }
      }
      const guessed = stories.filter((st) => st.sourceBy === "claimed").length;
      if (guessed)
        ctx.emit("log", {
          stream: "plan.stories",
          text: `${guessed}/${stories.length} 条故事的出处是模型声称的，不是定位出来的——它们的验收标准对不上规格里任何一条有出处的规则`,
        });

      ctx.emit("wf.node.output", { nodeId: ctx.nodeId, stories: stories.map((s) => s.id) });
      // 一路带下去：一条故事是从人写的规格里拆出来的，还是从跑着的产品上看出来的，
      // 决定了它衍生的用例挂了意味着什么。
      return {
        origin: spec.origin,
        derivedFrom: spec.derivedFrom,
        // 规格跟着故事走。`design.cases` 吃的是 `stories`，拿不到 `spec` 节点的产物，而图上
        // 那个 `specText` 参数建图时填不出来——所以在这一行出现之前，它一直在空规格上设计用例。
        specText: spec.text,
        stories,
      };
    },
  };
}

/**
 * Stories → text cases, one model call per story.
 *
 * Per story rather than per document, because on a self-hosted model short calls with an
 * identical prefix are much cheaper than one long one — and because a story that fails to
 * produce cases should cost that story, not the whole batch.
 */
export function designCasesNode(opts: CaseGenNodeOptions): NodeDef<
  {
    specText?: string;
    lang?: string;
    contextTokens: number;
    perStoryMaxTokens: number;
    maxCasesPerStory: number;
    oracleGuidance: "default" | "strict";
  },
  z.infer<typeof StoryBundleSchema>,
  CaseBundle
> {
  return {
    type: "design.cases",
    title: "Design cases",
    description: "Expand each story into text cases using the test design methods",
    inKind: KIND.stories,
    outKind: KIND.cases,
    params: z.object({
      /**
       * 覆盖用：正常情况下规格由 `plan.stories` 随故事一起带下来。
       *
       * 别把它当成主通道——建图时只有规格的**路径**，内容要等节点运行时才读得到，
       * 所以图里的这个参数填不出真正的规格。
       */
      specText: z.string().optional(),
      lang: z.string().optional(),
      /** Context this node may spend on material. The spec is what grows without bound. */
      contextTokens: z.number().int().min(500).max(200_000).default(8000),
      /** A whole story's work is lost when the reply is cut off, so this is generous. */
      perStoryMaxTokens: z.number().int().min(200).max(16000).default(6000),
      maxCasesPerStory: z.number().int().min(1).max(30).default(8),
      /**
       * How hard to press on what an assertion must name. `strict` appends a definition of
       * "observable phenomenon" with counter-examples — the critic's standing proposal,
       * kept as a parameter so it can be compared rather than believed.
       */
      oracleGuidance: z.enum(["default", "strict"]).default("default"),
    }),
    input: StoryBundleSchema,
    output: CaseBundleSchema,
    run: async (bundle, params, ctx) => {
      const cases: TextCase[] = [];
      const failures: Array<{ story: string; message: string }> = [];

      /**
       * 明确给了的参数覆盖，**空的忽略**，其余取上游带下来的那份。
       *
       * 后半句是这个洞的修法本身：参数作为覆盖是对的，但一个**空**参数不该压掉真正的规格。
       * 此前图里无条件存着一个空 `specText`，于是它每次都「覆盖」成了没有规格。
       */
      const specText = params.specText?.trim() ? params.specText : (bundle.specText ?? "");
      if (!specText.trim())
        // 空规格不再是一件悄无声息的事：这个节点会照常产出用例，只是它只看得见故事，
        // 而那正是它此前一直在做的事，没有任何一处说出来。
        ctx.emit("log", {
          stream: "design.cases",
          text: "这一批用例是在没有规格的情况下设计的——模型只看得见故事的标题与验收标准",
        });

      for (const story of bundle.stories) {
        if (ctx.signal.aborted) break;
        try {
          // The story must survive intact; the specification is the part that gets trimmed,
          // and how much was trimmed is reported rather than silently swallowed.
          const budget = fitToBudget(
            [
              { name: "story", text: JSON.stringify(story), share: 1, fixed: true },
              { name: "spec", text: specText, share: 1 },
            ],
            params.contextTokens,
          );
          const specForCall = budget.parts.find((p) => p.name === "spec")!;
          if (specForCall.dropped > 0)
            ctx.emit("log", {
              stream: "design.cases",
              text: `story ${story.id}: trimmed ${specForCall.dropped} tokens of specification to fit the context budget`,
            });

          const res = await opts.model.chat({
            // Ablation: without the method instructions the model still writes cases, it
            // just stops being told how to think about them. That is the comparison.
            stable:
              (ctx.ablated.has(ABLATABLE.designMethods) ? CASES_STABLE_PLAIN : CASES_STABLE) +
              (params.oracleGuidance === "strict" ? ORACLE_STRICT : ""),
            variable: casesVariable(specForCall.text, story, params.lang, params.maxCasesPerStory),
            schema: CASES_SCHEMA,
            maxTokens: params.perStoryMaxTokens,
            label: `design.cases:${story.id}`,
          });
          ctx.spend({ calls: 1, tokens: res.tokens });
          const shape = z.object({ cases: z.array(TextCaseSchema.omit({ id: true, storyId: true })) });
          const parsed = parseJson(res.text, shape, `design.cases:${story.id}`, {
            truncated: res.truncated,
            maxTokens: params.perStoryMaxTokens,
          });
          for (const [i, c] of parsed.cases.slice(0, params.maxCasesPerStory).entries())
            cases.push({ ...c, id: `${story.id}-${i + 1}-${slug(c.title)}`, storyId: story.id });
          ctx.emit("wf.node.output", { nodeId: ctx.nodeId, storyId: story.id, produced: parsed.cases.length });
        } catch (e) {
          // One story's bad reply must not throw away the other stories' work.
          failures.push({ story: story.id, message: (e as Error).message });
          ctx.emit("log", { stream: "design.cases", text: `story ${story.id} produced nothing: ${(e as Error).message}` });
        }
      }

      if (!cases.length)
        throw new Error(
          `design.cases: no story produced usable cases (${failures.map((f) => `${f.story}: ${f.message}`).join(" | ")})`,
        );
      return {
        origin: bundle.origin,
        derivedFrom: bundle.derivedFrom,
        stories: bundle.stories,
        cases,
      };
    },
  };
}

/** Gate ①. No model: every rule here is a fact about the batch. */
export function gateTextCaseNode(): NodeDef<
  { minNegativeRatio: number; maxSteps: number },
  CaseBundle,
  z.infer<typeof GatedBundleSchema>
> {
  return {
    type: "gate.textcase",
    title: "Gate: test design",
    description: "Score the batch against the test-design rules (marks, never blocks)",
    inKind: KIND.cases,
    outKind: KIND.gatedCases,
    params: z.object({
      minNegativeRatio: z.number().min(0).max(1).default(0.3),
      maxSteps: z.number().int().min(1).max(30).default(8),
    }),
    input: CaseBundleSchema,
    output: GatedBundleSchema,
    run: async (bundle, params, ctx) => {
      const gate = runGate(bundle, {
        ...params,
        gradeOracles: !ctx.ablated.has(ABLATABLE.oracleGrading),
        dedupe: !ctx.ablated.has(ABLATABLE.dedupe),
      });
      ctx.emit("gate.result", {
        nodeId: ctx.nodeId,
        gate: "textcase",
        score: gate.score,
        stats: gate.stats,
        findings: gate.findings.length,
      });
      return { ...bundle, gate };
    },
  };
}

/** Every G1 node, ready to register. */
export function caseGenNodes(opts: CaseGenNodeOptions): Array<NodeDef<never, never, never>> {
  return [
    sourceSpecNode(opts),
    // 同一层的另一个来源：规格可以是人写的，也可以是从跑着的产品上看出来的。
    // 以后还会有第三个（从代码库推），三者产出同一种东西，区别只在 derivedFrom 的印记上。
    sourceExploreNode(opts),
    composeSpecNode(opts),
    planStoriesNode(opts),
    designCasesNode(opts),
    gateTextCaseNode(),
  ] as unknown as Array<NodeDef<never, never, never>>;
}
