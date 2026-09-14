import { readFileSync } from "node:fs";
import { normalizeCase } from "./normalizeOracle.js";
import { z } from "zod";
import { computeFlows, computeModules, describeFlows } from "../exec/flows.js";
import { scanSmells } from "./smells.js";
import { checkStories } from "./storyQuality.js";
import { buildIndexFromDocs, estimateTokens, retrieve, SPEC_FENCE } from "../retrieve/index.js";
import { checkProvenance } from "./provenance.js";
import { ABLATABLE, fitToBudget, type ModelClient, type NodeDef } from "@testpilot/harness-core";
import {
  CASES_SCHEMA,
  CASES_STABLE,
  CASES_STABLE_PLAIN,
  CASES_STABLE_NO_PRIORITY,
  CASES_STABLE_NO_CLEANUP,
  ORACLE_STRICT,
  storiesSchema,
  STORIES_STABLE,
  casesVariable,
  storiesVariable,
  COMPOSE_STABLE,
  composeVariable,
  COMPOSE_SCHEMA, DOMAIN_PERP } from "./prompts.js";
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
  const candidates = balancedObjects(cleaned);
  if (!candidates.length) throw new Error(`${label}: no JSON object in the reply${cutOff}`);

  /**
   * 逐个候选试，取第一个合形状的。
   *
   * 原来的做法是「第一个 `{` 到最后一个 `}`」，它假设回复里**恰好一个** JSON 对象。
   * 换一个模型之后这个假设就不成立了：实测收到过 `{…}\n{…}` 这样的回复，切出来的那段
   * 解析报「Unexpected non-whitespace character after JSON」——读起来像格式坏了，
   * 其实是我们切错了。多一个对象、前面带一段带花括号的解释，都属于这一类。
   */
  /**
   * 模型返回**裸数组**时，把它套回它该在的那个键下面。
   *
   * TokenHarbor 上 guided decoding 只是建议不是强制——实测同一个 schema 要求对象，
   * 回来的是 `[{...},{...}]`。这不是格式坏了，是约束没生效。schema 里只有一个数组字段时
   * 该套哪个键是唯一的，套错不了；不唯一就不猜。
   */
  const arrayKey = soleArrayKey(schema);
  const wrapped = arrayKey
    ? balancedArrays(cleaned).map((a) => `{"${arrayKey}":${a}}`)
    : [];

  let lastError = "";
  for (const c of [...candidates, ...wrapped]) {
    let raw: unknown;
    try {
      raw = JSON.parse(c);
    } catch (e) {
      lastError = lastError || `not valid JSON${cutOff} — ${(e as Error).message}`;
      continue;
    }
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    lastError =
      lastError ||
      `does not match the expected shape — ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
        .join("; ")}`;
  }
  throw new Error(`${label}: reply ${lastError}`);
}

/**
 * schema 里唯一的那个数组字段的名字。不唯一就返回空——该套哪个键说不准的时候不猜。
 */
function soleArrayKey(schema: unknown): string | undefined {
  const def = (schema as { _def?: { typeName?: string; shape?: () => Record<string, { _def?: { typeName?: string } }> } })._def;
  if (def?.typeName !== "ZodObject" || !def.shape) return undefined;
  const shape = def.shape();
  const arrays = Object.entries(shape).filter(([, v]) => v?._def?.typeName === "ZodArray");
  return arrays.length === 1 ? arrays[0][0] : undefined;
}

/** 顶层的平衡数组。与对象那一个同样要认字符串与转义。 */
export function balancedArrays(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  if (depth > 0 && start >= 0) out.push(text.slice(start));
  return out;
}

/**
 * 把回复里每一个**括号平衡**的顶层对象切出来。
 *
 * 要认字符串与转义，否则一段带 `}` 的文案会把计数弄乱——而弄乱之后切出来的东西
 * 解析失败，报的却是「模型返回的 JSON 不合法」。
 */
export function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  // 没闭合的那个也留着：它多半是被 maxTokens 腰斩的那一个，交给上面报「预算问题」。
  if (depth > 0 && start >= 0) out.push(text.slice(start));
  return out;
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
    /** 见 source.explore 的同名参数。声明在这里，否则节点转发过来会被类型挡掉。 */
    scenarioFirst?: boolean;
    inPageFirst?: "auto" | "on" | "off";
    groupCap?: number;
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
    // 读文档，不改变任何状态——这正是 retriever 的定义
    observationType: "retriever" as const,
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
    // 这三个和下面 zod 的 params 必须同时改——类型在两处声明，改一处不报错，
    // 表现成"参数声明了但传不下去"。
    scenarioFirst: boolean;
    inPageFirst: "auto" | "on" | "off";
    groupCap: number;
    lang?: string;
    maxTokens?: number;
  },
  unknown,
  z.infer<typeof SpecMaterialSchema>
> {
  return {
    type: "source.explore",
    // 整条流水线里唯一一个真的自主循环：它自己决定下一步点哪里、什么时候停
    observationType: "agent" as const,
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
      stateAbstraction: z.string().default("route+controls/norm"),
      /**
       * 探索之前先问一次「这是什么业务、人在这里可能要完成哪些事」，并用答案决定先点什么。
       *
       * 关掉就退回"按控件表和 URL 队列决定"——那正是把一个只有一条 route 的
       * 合约交易页探索成一份登录流程材料的原因。
       */
      scenarioFirst: z.boolean().default(true),
      /**
       * 页内控件优先于未去过的路由。
       *
       * `auto` 按事实判（这一屏有 ≥2 个控件组）。不能无脑翻转：
       * "未去过的路由优先"那条规则是从多路由产品的实测里长出来的，翻死了会毁掉那些基准。
       */
      inPageFirst: z.enum(["auto", "on", "off"]).default("auto"),
      /** 一个控件组最多采几项。防一个装着几百个交易对的 listbox 淹掉下单区那三项。 */
      groupCap: z.number().int().min(1).max(30).default(6),
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
        // 声明了就要真的转发。这一层已经有现成的反例：`lang` 与 `maxTokens`
        // 在 params 里躺着，run 里一次都没读——是两个死旋钮。
        scenarioFirst: params.scenarioFirst,
        inPageFirst: params.inPageFirst,
        groupCap: params.groupCap,
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
  { lang?: string; maxTokens?: number; maxRules: number },
  z.infer<typeof SpecMaterialSchema>,
  z.infer<typeof SpecDocSchema>
> {
  return {
    type: "spec.compose",
    // 把材料接到规格上的一段，典型的 chain：上游产物 → 模型 → 下游产物
    observationType: "chain" as const,
    title: "Compose the specification",
    description: "Organise raw material into the one standard specification shape",
    inKind: KIND.material,
    outKind: KIND.spec,
    params: z.object({
      lang: z.string().optional(),
      /**
       * 6000 而不是 3000：加上 `flows`、`altitude`、`about` 之后，同一份材料的规格输出
       * 大了一截，3000 会把回复腰斩——而被腰斩的回复解析出来是「JSON 格式错误」，
       * 看起来像提示词的问题，其实是预算的问题。截断本身有专门的报错说这件事，
       * 但更好的做法是不要撞上它。
       */
      /**
       * 留空则按材料规模自己算——见下面 `maxTokens` 的算法。
       *
       * 固定值在这条流水线上已经错过三次：3000 → 6000 → 还是不够。每次都是同一个原因：
       * **探索变彻底了，材料变大了，而输出预算是上一轮定的**。规格的长度跟着规则数和
       * 流程数走，而那两个数跟着图的大小走——那就直接按图算，别再手工调一个常数。
       */
      maxTokens: z.number().int().min(600).max(32000).optional(),
      maxRules: z.number().int().min(1).max(200).default(60),
    }),
    input: SpecMaterialSchema,
    output: SpecDocSchema,
    run: async (material, params, ctx) => {
      /**
       * 路径先算出来，再交给模型命名。
       *
       * 「从入口到终点有哪些路径」是图算法。让模型从屏幕描述里"推断"流程，它会推断出
       * 一些看起来合理、实际上走不通的流程，而且没人能查。所以这里给它的是**事实**，
       * 它只补名字和目的——那才是图上看不出来的东西。
       */
      const computed = material.graph ? computeFlows(material.graph) : { flows: [], truncated: false };
      const computedModules = material.graph ? computeModules(material.graph, computed.flows) : [];
      const flowText = material.graph
        ? "\n\n" + describeFlows(computed.flows, computedModules, computed.truncated)
        : "";
      if (computed.truncated)
        ctx.emit("log", {
          stream: "spec.compose",
          text: `图上路径过多，流程列表被截断——规格里的流程不是全部`,
        });

      /**
       * 输出预算按材料规模算。
       *
       * 一条规则连同证据原话约 120 个 token，一条流程连同每一步的转移 id 约 90 个，
       * 再留一份给标题、摘要和「没有答案的地方」。上限 32000（DashScope 收得下），
       * 下限 6000（小图也不至于被切）。
       *
       * **这个数不该再由人来调。**它在这条流水线上被手工调过两次，两次都是在一次
       * 「回复被切断」之后补的——而切断这件事，从产出上看只是「规格短了点」。
       */
      const budget =
        params.maxTokens ??
        Math.min(
          32000,
          Math.max(6000, params.maxRules * 120 + computed.flows.length * 90 + 2000),
        );
      /**
       * 输入也要有预算——这是全流水线最大的一次输入。
       *
       * 输出侧早就治好了（上面那段，按图的规模自己算）。输入侧此前一个字都没有：
       * 探索材料实测最大 128,430 字节，而它唯一的保护是网关那一刀 `slice(0, 240000)`——
       * **从尾巴切**，正是 `budget.ts` 开宗明义说错的那个算法。同一个节点，
       * 一半治好了一半没治。
       *
       * `fitToBudget` 按份额分配、超了的**掐中间**：开头说明这是什么，
       * 结尾通常是刚刚追加的那部分，中间才是可以省的。而且它会说出自己省了多少——
       * 一次被悄悄截断的输入，从产出上看只是「规格短了点」。
       *
       * 分配比例：材料 3、算出来的流程 1。流程是**事实**（图算法算的，不是模型推断的），
       * 短而不可替代；材料长且冗余。
       */
      const INPUT_LIMIT = 60_000;
      const fitted = fitToBudget(
        [
          { name: "material", text: material.text, share: 3 },
          { name: "flows", text: flowText, share: 1 },
        ],
        INPUT_LIMIT,
      );
      if (fitted.dropped > 0)
        ctx.emit("log", {
          stream: "spec.compose",
          text: `材料超过输入预算，掐掉中间 ${fitted.dropped} token（保留头尾）——规格是照一份不完整的材料写的`,
        });
      // 材料是第三方文本：过滤后包进 `<spec_material>` 再进提示词。这是 A 臂离原始材料
      // 最近的一处，也是此前唯一零过滤的注入面（探索产物就是被测站点的页面文字）。
      const fittedText = SPEC_FENCE.wrap(fitted.parts.map((p) => p.text).join(""));

      const res = await opts.model.chat({
        stable: COMPOSE_STABLE,
        variable: composeVariable(fittedText, material.origin ?? "inline", material.derivedFrom ?? "document", params.lang),
        schema: COMPOSE_SCHEMA,
        maxTokens: budget,
        label: "spec.compose",
      });
      ctx.spend({ calls: 1, tokens: res.tokens });

      const parsed = parseJson(
        res.text,
        z.object({
          title: z.string().default(""),
          summary: z.string().default(""),
          rules: z.array(SpecRuleSchema).default([]),
          flows: z
            .array(z.object({ id: z.string(), name: z.string().default(""), purpose: z.string().default("") }))
            .default([]),
          modules: z.array(z.object({ id: z.string(), name: z.string().default("") })).default([]),
          screens: z.array(z.object({ id: z.string(), name: z.string().default("") })).default([]),
          unknowns: z.array(z.string()).default([]),
        }),
        "spec.compose",
        { truncated: res.truncated, maxTokens: budget },
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

      /**
       * 合并：**路径以算出来的为准，模型只贡献名字与目的**。
       *
       * 反过来（以模型的回复为准）会让它凭空多出或少掉几条流程，而那正是这一层要防的。
       * 模型没命名的路径也留着——一条没有名字的流程仍然是一条流程。
       */
      const named = new Map(parsed.flows.map((f) => [f.id, f]));
      const flows = computed.flows.map((f) => ({
        id: f.id,
        name: named.get(f.id)?.name ?? "",
        purpose: named.get(f.id)?.purpose ?? "",
        steps: f.steps.map((s) => s.how),
        transitions: f.steps.map((s) => `${s.from}->${s.to}`),
        endsAt: f.endsAt,
      }));
      /** 模块同理：聚类是事实，名字是判断。模型只贡献名字。 */
      const namedMod = new Map(parsed.modules.map((m) => [m.id, m.name]));
      const modules = computedModules.map((m) => ({
        id: m.id,
        name: namedMod.get(m.id) || m.id,
        flowIds: m.flowIds,
        routes: m.routes,
      }));
      /**
       * 把 id 原样抄成名字，等于没起名字。
       *
       * 约束解码要求 `name` 存在，但要求不了它**不等于 id**。而模块名就是故事图的横轴
       * ——横轴上写着 `oups`、`vets` 时，复核的人第一眼看到的是代码词汇。
       * 报出来，因为这件事从产出上看完全正常：字段有值、结构完整。
       */
      /**
       * 屏幕名同理：哪些屏是图上的事实，名字才交给模型。
       *
       * 只留图上真有的 id——模型编一个 `/checkout` 出来，产品地图上没有那个节点，
       * 那个名字就无处可挂，而它会让「这个产品有几屏」这个数悄悄多一个。
       */
      const knownStates = new Set(material.graph?.states.map((s) => s.id) ?? []);
      const screens = parsed.screens
        .filter((s) => knownStates.has(s.id) && s.name && s.name !== s.id)
        .map((s) => ({ id: s.id, name: s.name }));
      const unnamedScreens = knownStates.size - screens.length;
      if (knownStates.size && unnamedScreens > 0)
        ctx.emit("log", {
          stream: "spec.compose",
          text: `${unnamedScreens} 个屏没起出人话名字——产品地图上它们会显示成路由`,
        });

      const unnamed = modules.filter((m) => m.name === m.id).map((m) => m.id);
      if (unnamed.length)
        ctx.emit("log", {
          stream: "spec.compose",
          text: `${unnamed.length} 个模块没起出人话名字（${unnamed.join("、")}）——故事图的横轴会显示代码词汇`,
        });
      const invented = parsed.flows.filter((f) => !computed.flows.some((c) => c.id === f.id)).length;
      if (invented)
        ctx.emit("log", {
          stream: "spec.compose",
          text: `${invented} 条流程是模型自己加的，不在算出来的路径里——已丢弃`,
        });

      const text = [
        parsed.title ? `# ${parsed.title}` : "",
        parsed.summary,
        "",
        "## 规则",
        /**
         * 海拔要写进正文。
         *
         * 我强制模型给每条规则标了 `altitude`，然后把它留在结构化字段里没写出来——
         * 而 `plan.stories` 读的是**正文**。于是下一层看到的还是一片没有层次的规则列表，
         * 8 条故事全是「X 页展示 Y」，没有一条讲校验，尽管规格里明明白白写着两条。
         *
         * 要求写了、数据没往下传，这是这条流水线上反复出现的同一个形状。
         */
        ...located.map(
          (r) =>
            `- **${r.id}** \`[${r.altitude ?? "?"}]\` ${r.text}${r.about ? `（关于 ${r.about}）` : ""}` +
            `${r.evidence ? `\n  > ${r.evidence}` : ""}`,
        ),
        "",
        ...(modules.length
          ? [
              "",
              "## 模块",
              /**
               * 模块要写进正文，理由和海拔那次一模一样：它算出来了、也喂给了这一层的模型，
               * 却**没写进下游读的正文**。于是 `plan.stories` 只能拿流程名当活动，而流程与
               * 故事近乎一一对应——故事图七列里六列只有一个故事，骨架和躯干塌在了一起。
               */
              ...modules.map(
                (m) =>
                  `- **${m.id}** ${m.name}${m.routes.length ? `　（${m.routes.slice(0, 6).join("、")}）` : ""}` +
                  `${m.flowIds.length ? `\n  > 包含流程：${m.flowIds.join("、")}` : ""}`,
              ),
            ]
          : []),
        ...(flows.length
          ? [
              "",
              "## 流程",
              /**
               * 每一步都带上它的转移 id。
               *
               * 用例要引用这些 id 来声明自己验证了哪条转移；只渲染人读的箭头串，
               * 等于要求它引用一个从没出现过的东西。
               */
              ...flows.flatMap((f) => [
                `- **${f.id}** ${f.name || "(未命名)"}${f.purpose ? ` —— ${f.purpose}` : ""}`,
                ...f.steps.map((how, i) => `  > \`${f.transitions[i] ?? ""}\`　${how}`),
              ]),
            ]
          : []),
        "",
        "## 没有答案的地方",
        ...(parsed.unknowns.length ? parsed.unknowns.map((u) => `- ${u}`) : ["- （整理者认为没有）"]),
      ]
        .filter((x) => x !== "")
        .join("\n");

      /**
       * 海拔分布要报出来。一份只有 `screen` 规则的规格是屏幕清单，不是规格——
       * 由它推出的用例只能检查「屏幕还是不是原来的样子」，而这件事从产出上看不出来。
       */
      /**
       * 需求异味：写法上就注定验不了的句子。见 `smells.ts`。
       *
       * 报，不拦——异味是警告不是判决。但**必须报出来**：规格是模型写的，
       * 而模型最擅长写的恰恰是「正确显示」「合理提示」这一类，
       * 而下游一层都拦不住它——拆故事时变成一条模糊的故事，设计用例时变成一条含糊的断言，
       * 直到执行那一刻才发现没有任何东西可判。
       */
      const smells = scanSmells(located.map((r) => ({ id: r.id, text: r.text })));
      if (smells.smells.length)
        ctx.emit("log", {
          stream: "spec.compose",
          text:
            `${Math.round(smells.ratio * 100)}% 的规则带需求异味（${smells.smells.length} 处）：` +
            smells.smells.slice(0, 4).map((s) => `${s.where}「${s.hit}」${s.what.split("：")[0]}`).join("；"),
        });

      const altitudes: Record<string, number> = {};
      for (const r of located) altitudes[r.altitude ?? "unspecified"] = (altitudes[r.altitude ?? "unspecified"] ?? 0) + 1;
      ctx.emit("wf.node.output", {
        nodeId: ctx.nodeId,
        rules: located.length,
        unknowns: parsed.unknowns.length,
        grounded: located.filter((r) => r.source).length,
        flows: flows.length,
        altitudes,
        // 有异味的规则占比。跨版本可比——单看条数会被规格长度带偏。
        smellRatio: smells.ratio,
        smells: smells.byRule,
      });
      if (located.length && !(altitudes.flow || altitudes.domain))
        ctx.emit("log", {
          stream: "spec.compose",
          text: "这份规格全部是屏幕层规则——没有一条说「做了什么之后会怎样」，由它推出的用例只能发现屏幕变了",
        });
      return {
        title: parsed.title,
        text,
        rules: located,
        flows,
        modules,
        screens,
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
    // 同上
    observationType: "chain" as const,
    title: "Stories",
    description: "Split a specification into user stories with their acceptance criteria",
    inKind: KIND.spec,
    outKind: KIND.stories,
    params: z.object({
      maxStories: z.number().int().min(1).max(50).default(12),
      lang: z.string().optional(),
      /**
       * 一条故事的体量。
       *
       * 原估算是 ~200 token/条，那是故事只有 id/title/acceptance 的时候。加上 `role`、
       * `benefit`、`flowId`、`activity`，验收标准又改成 Given/When/Then 三段，一条故事
       * 实际在 400–500 token。按旧估算给预算，回复会被腰斩——而腰斩的回复解析出来是
       * 「JSON 格式错误」，看起来像提示词的问题。
       *
       * 加字段就要回头看预算，这是同一件事的两半。
       */
      maxTokens: z.number().int().min(400).max(32000).optional(),
    }),
    input: SpecDocSchema,
    output: StoryBundleSchema,
    run: async (spec, params, ctx) => {
      /**
       * 一条故事现在带 id、标题、角色、收益、flowId、活动、来源，外加**多条**
       * Given/When/Then 验收标准——中文下单条轻松 300+ token。520 是加这些字段**之前**
       * 定的，900 是我拍的，两次都不够。
       *
       * 给足：每条 2600，下限 12000。切断的代价（整批故事作废）远大于多要一点预算的代价，
       * 而这个方向上没有对称的风险——要多了只是没用完。
       *
       * 2600 这个数是被**开着思考**的那一组逼出来的：模型先想一遍之后写的故事明显更长
       * （验收标准更多、措辞更完整），1600 够不着。两组用同一个数，对照才成立。
       */
      const maxTokens = params.maxTokens ?? Math.min(32000, Math.max(12000, params.maxStories * 2600));
      const res = await opts.model.chat({
        stable: STORIES_STABLE,
        variable: storiesVariable(spec.text, params.lang),
        // 活动只能填模块名——放开成自由串时，模型把整段规格正文抄进了这一栏，
        // 而它就是故事图的列头。见 `storiesSchema`。
        schema: storiesSchema((spec.modules ?? []).map((m) => m.name || m.id)),
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
      /**
       * **活动按模块确定性回填。**
       *
       * 与流程同一条道理：属于哪个模块是算出来的（流程 → 模块的归属由 `computeModules`
       * 决定），模型只负责给模块起个人话名字。让模型自己填 `activity`，它会给几乎每条
       * 故事编一个独有的活动——实测七列里六列只有一个故事，故事图退化成横过来的列表。
       *
       * 骨架必须比躯干粗，这一点不能指望提示词说服模型，要由数据结构保证。
       */
      const moduleOfFlow = new Map<string, string>();
      for (const m of spec.modules ?? []) for (const fid of m.flowIds) moduleOfFlow.set(fid, m.name || m.id);
      /**
       * 挂不到流程的故事，回填够不着。而它们的 `activity` 实测是模块的 **id**——
       * 规格正文把模块渲染成 `- **search** 搜索与浏览商品`，模型抄了粗体那一段。
       * 于是同一个模块裂成两列：一列叫「搜索与浏览商品」，一列叫 `search`。
       * 所以再补一步归一：活动名对上某个模块的 id 或名字，一律换成那个模块的名字。
       */
      const nameOfModule = new Map<string, string>();
      for (const m of spec.modules ?? []) {
        const display = m.name || m.id;
        nameOfModule.set(m.id.toLowerCase(), display);
        if (m.name) nameOfModule.set(m.name.toLowerCase(), display);
      }
      /**
       * **活动只能是已知的模块名，别的一律丢掉。**
       *
       * 约束解码已经把它钉成枚举了（见 `storiesSchema`），这里是第二道：约束解码在有些
       * 端点上会被降级成普通调用（`guidedSupported` 一旦为假就永久关掉），那时这一栏又是
       * 自由字符串。实测放开的后果是模型把**整段规格正文**（三千多字符）抄了进来——
       * 而这一栏就是故事图的列头，一个三千字的列头会让整页当场不可读。
       *
       * 认不出来就置空，让它落到「未归类」那一列。**宁可少一个分类，不可多一个假分类**：
       * 一个瞎编的列头比没有列头更糟，因为人会信它。
       */
      const known = new Set([...nameOfModule.values()]);
      const stories = raw.map(attribute).map((st) => {
        const byFlow = st.flowId ? moduleOfFlow.get(st.flowId) : undefined;
        if (byFlow) return { ...st, activity: byFlow };
        const byName = nameOfModule.get((st.activity ?? "").trim().toLowerCase());
        if (byName) return { ...st, activity: byName };
        return known.size && st.activity && !known.has(st.activity)
          ? { ...st, activity: undefined }
          : st;
      });
      /**
       * 故事质量：对照 QUS 框架里能自动查、而且这条流水线真会犯的那几条。
       * 见 `storyQuality.ts`。报，不拦。
       */
      const quality = checkStories(stories);
      if (quality.findings.length)
        ctx.emit("log", {
          stream: "plan.stories",
          text:
            `${Math.round(quality.ratio * 100)}% 的故事有质量问题（${quality.findings.length} 处）：` +
            quality.findings.slice(0, 4).map((f) => `${f.storyId} ${f.what.split("——")[0]}`).join("；"),
        });

      const activities = new Set(stories.map((s) => s.activity).filter(Boolean));
      /**
       * 骨架和躯干一样粗，就等于没有骨架。报出来——故事图看起来正常，只是它不是图。
       */
      if (stories.length >= 4 && activities.size >= stories.length * 0.8)
        ctx.emit("log", {
          stream: "plan.stories",
          text:
            `${stories.length} 条故事分在 ${activities.size} 个活动里——故事图的横轴和故事几乎一一对应，` +
            `那不是图，是横过来的列表。多半是故事都挂在了各自独立的流程上，或者规格里没有模块。`,
        });

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
        // 流程同理：用例要引用它的转移 id，门禁要拿它校验那些 id 真的存在。
        flows: spec.flows ?? [],
        // 模块也要带下去：故事的 `activity` 靠它确定性回填，不能只信模型抄对了名字。
        modules: spec.modules ?? [],
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
    // 同上；它内部每条故事一次模型调用，那些是它下面的 generation
    observationType: "chain" as const,
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
      perStoryMaxTokens: z.number().int().min(200).max(32000).default(9000),
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

      /**
       * 规格切成可检索的段，**一次**，在循环外。
       *
       * 索引是纯函数（BM25 + 标题层级切片，见 `../retrieve/`），每条故事重建一遍
       * 只是把同一份文档重新扫 N 遍。
       */
      const specIndex = specText.trim()
        ? buildIndexFromDocs([{ docId: "spec", text: specText }], "inline")
        : undefined;

      for (const story of bundle.stories) {
        if (ctx.signal.aborted) break;
        try {
          /**
           * **按这条故事取规格，不再盲裁。**
           *
           * 以前这里是 `fitToBudget`：故事固定不动，规格按份额掐中间。预算是对的，
           * 掐掉的是**哪一段**却没有人知道——一条讲「退出登录」的故事，很可能拿到的是
           * 被掐得只剩头尾的登录规格，而产出看起来完全正常，只是少测了几条。
           *
           * 现在预算一分不变（还是 `params.contextTokens`），装进去的换成**和这条故事
           * 最相关的那几段**；没装进去的有名字、有数目、有一句怎么取它们的指导
           * （`hint`，SWE-agent 的做法：截断变成行为指导，不是一句道歉）。
           */
          const storyText = JSON.stringify(story);
          // 故事不可裁：它是这次调用要回答的问题本身。剩下的才是规格能用的预算。
          const specBudget = Math.max(200, params.contextTokens - estimateTokens(storyText));
          const query = [story.title, ...story.acceptance].join(" ");
          const got = specIndex
            ? retrieve(specIndex, query, specBudget)
            : { chunks: [], dropped: 0, hint: "" };

          /**
           * 每段带 `[id: …]`，模型把它抄进 `sourceRefs`；整份包进 `<spec_material>`。
           * id 是这次真正取到的段的 id——出处只能是取到过的东西，这一条由下面的
           * `checkProvenance` 对着 `got.chunks` 核对，对不上的 id 丢掉并记日志。
           */
          const specForCall = {
            text: SPEC_FENCE.wrap(
              got.chunks
                .map((c) => `### ${c.heading.length ? c.heading.join(" / ") : "(untitled)"} [id: ${c.id}]\n${c.text}`)
                .join("\n\n"),
            ),
            hint: got.hint,
          };
          const retrievedIds = got.chunks.map((c) => c.id);
          if (specIndex)
            ctx.emit("log", {
              stream: "design.cases",
              text:
                `story ${story.id}: 载入 ${got.chunks.length} 段规格 / 未载入 ${got.dropped} 段` +
                `（预算 ${specBudget} token，共 ${specIndex.chunks.length} 段）`,
            });

          const res = await opts.model.chat({
            // Ablation: without the method instructions the model still writes cases, it
            // just stops being told how to think about them. That is the comparison.
            stable:
              /**
               * 三个开关各减各的那一段，全部由 `subtract` 从原文生成——手写第二份必然漂移。
               * 同时开两个时按顺序减，减完还是同一份原文的子集。
               */
              (() => {
                if (ctx.ablated.has(ABLATABLE.designMethods)) return CASES_STABLE_PLAIN;
                if (ctx.ablated.has(ABLATABLE.casePriority)) return CASES_STABLE_NO_PRIORITY;
                if (ctx.ablated.has(ABLATABLE.caseCleanup)) return CASES_STABLE_NO_CLEANUP;
                return CASES_STABLE;
              })() +
              (params.oracleGuidance === "strict" ? ORACLE_STRICT : "") +
              // 领域 REFERENCE 臂（07 T-10）：默认带，`ablate: ["domain-perp"]` 去掉。
              (ctx.ablated.has(ABLATABLE.domainPerp) ? "" : DOMAIN_PERP),
            // `hint` 一起送进去：模型该知道的不是「内容被截断了」，而是「还剩什么、怎么拿」。
            variable: casesVariable(
              specForCall.hint ? `${specForCall.text}\n\n[retrieval] ${specForCall.hint}` : specForCall.text,
              story,
              params.lang,
              params.maxCasesPerStory,
            ),
            schema: CASES_SCHEMA,
            maxTokens: params.perStoryMaxTokens,
            label: `design.cases:${story.id}`,
          });
          ctx.spend({ calls: 1, tokens: res.tokens });
          // 扁平全必填 schema 回来的 oracle 先剥占位符（`normalizeOracle.ts`），再给 zod。
          const shape = z.object({ cases: z.array(z.preprocess(normalizeCase, TextCaseSchema.omit({ id: true, storyId: true }))) });
          const parsed = parseJson(res.text, shape, `design.cases:${story.id}`, {
            truncated: res.truncated,
            maxTokens: params.perStoryMaxTokens,
          });
          const produced: TextCase[] = parsed.cases
            .slice(0, params.maxCasesPerStory)
            .map((c, i) => ({ ...c, id: `${story.id}-${i + 1}-${slug(c.title)}`, storyId: story.id }));
          /**
           * 出处核对（与写盘 hook 同一个 `checkProvenance`）。对不上的 id **丢掉**而不是整条拒掉：
           * 一条用例的断言仍然可能是对的，只是它指错了段；丢掉之后它成了「无出处」，
           * 门禁与审计会看见这件事，而不是看见一条看起来有出处的用例。
           */
          const known = new Set(retrievedIds);
          const prov = checkProvenance(produced, known);
          if (prov.unknown.length || prov.unreferenced.length) {
            for (const c of produced) c.sourceRefs = c.sourceRefs.filter((r) => known.has(r));
            ctx.emit("log", {
              stream: "design.cases",
              text:
                `story ${story.id}: ${prov.unknown.length} 条用例引用了本次没取到的段（已丢弃那些 id），` +
                `${prov.unreferenced.length} 条没有出处`,
            });
          }
          cases.push(...produced);
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
        flows: bundle.flows ?? [],
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
    // 门禁：拦住不合格的产物往下走。它一次模型都不调，全是事实判断
    observationType: "guardrail" as const,
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
