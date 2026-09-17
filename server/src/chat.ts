import {
  CapabilityRecipeSchema,
  describeDiff,
  diffGraphs,
  validateGraph,
  type CapabilityRecipe,
  type GraphDef,
} from "@testpilot/harness-core";
import { projectPlannerModel } from "./modelProfiles.js";
import { getGraph, listGraphs, nodeOutput, outputStore, registry, saveGraph } from "./graphs.js";
import { ABLATABLE } from "@testpilot/harness-core";

/** 存在的消融开关。模型只能从这里挑，不能自己编一个。 */
const ABLATION_NAMES: string[] = Object.values(ABLATABLE);
import { DEFAULT_PROMPTS, getSettings } from "./settings.js";
import { FIELDS, isFieldId, shrinkWarnings, type FieldSpec } from "./fieldDraft.js";
import { runLedger } from "./runService.js";
import { frozenModules } from "./moduleStage.js";

/**
 * Chat with the agent — a drafting surface, not a control surface.
 *
 * Everything it produces is a *draft* of something the application already knows how to
 * validate: a capability recipe, a graph, a prompt. The chat never applies anything. That
 * is not politeness about autonomy, it is the only arrangement in which a generated
 * artefact is safe to have around: a recipe is a command line this machine will execute,
 * and a graph is what a twenty-minute run will follow.
 *
 * So the shape is always the same — the model writes it, this module checks it against the
 * same schema the hand-written ones go through, and the person decides. A draft that does
 * not validate is shown with its errors rather than hidden: "the model got it wrong" is
 * information, and quietly retrying until something parses is how you end up applying the
 * one that happened to parse.
 */

/**
 * `run` 是一份**起跑草稿**，不是一次起跑。
 *
 * 可复现性活在**运行记录**里，不在输入设备里——所以约束不是「chat 不许起跑」，
 * 而是：它走同一个 `startRun`，起跑之前必须先把会被记录的每一栏摆出来给人看过，
 * 而且评测的两臂不能由 chat 凭空造（那得来自仓库里的评测定义）。
 * 这里的做法最简单也最硬：chat **根本不调 startRun**，它只产出那张确认卡，
 * 按下去的是人，走的是界面上那个一模一样的按钮。
 */
export type ChatIntent = "capability" | "graph" | "prompt" | "ask" | "run" | "field";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ChatDraft {
  kind: "capability" | "graph" | "prompt" | "run" | "field";
  value: unknown;
  valid: boolean;
  /** Why it cannot be saved. Shown as-is; the reviewer is the one who decides what to do. */
  issues: string[];
  /**
   * What saving it would change beyond what was asked for.
   *
   * Not blocking, because a legitimate edit removes things too — but never silent. A model
   * asked to change one parameter routinely returns the graph with every other parameter
   * missing, and since params have defaults, that version validates perfectly while
   * quietly changing which file the run reads and what language it writes in.
   */
  warnings?: string[];
  /** The change, line by line, against what is saved now. */
  diff?: string[];
  /** For a prompt draft: which settings key it rewrites. For a graph: which graph. */
  target?: string;
}

export interface ChatResult {
  reply: string;
  draft?: ChatDraft;
  tokens: number;
  ms: number;
}

const ASK_STABLE = [
  "You are the harness's assistant inside TestPilot, a test-case generation harness.",
  "Answer briefly and concretely about what the harness does and how to drive it.",
  "When a node or a run is given below, the question is about THAT one: answer from the",
  "figures provided rather than in general, and say what is missing if they do not settle it.",
  "You cannot change anything: drafting a capability, a graph or a prompt is done by",
  "switching to that mode. Say so instead of pretending to have acted.",
].join("\n");

const CAPABILITY_STABLE = [
  "You draft CAPABILITY RECIPES for a test harness. A capability is an external service",
  "the harness starts, watches and stops: a local chain, a model proxy, a mock backend,",
  'or the APPLICATION UNDER TEST itself (kind "app") — a benchmark app the harness starts and drives.',
  "",
  "A recipe is declarative and exec-style:",
  '- `command` is a program name ("npx", "anvil", "node"), never a shell line. No ; & | $ ` > <.',
  "- `args` is the argument list, one entry per argument.",
  "- `healthcheck` is how to tell it is READY, not merely running: tcp (port), http (url),",
  "  or rpc (url + method). Running is not ready — a chain holds its port open before it",
  "  answers RPC, so a recipe without a healthcheck reports success too early.",
  "- `autostart` only for something every run needs.",
  "- Never put a credential in `env`; reference an existing environment variable instead.",
  "",
  'Return JSON only: {"reply":"one or two sentences","recipe":{"id":"...","kind":"chain",',
  '"command":"npx","args":["..."],"healthcheck":{"kind":"tcp","port":8545}}}',
].join("\n");

const GRAPH_STABLE = [
  "You draft WORKFLOW GRAPHS for a test harness. A graph is a list of nodes (each with an",
  "id, a registered type and params) and directed edges between them.",
  "",
  "Rules:",
  "- Use ONLY node types from the palette given below; a type that is not in it does not exist.",
  "- Keep the ids of nodes you are not changing, and return the WHOLE graph, not a patch.",
  "- Keep every param you are not changing, verbatim. A param you leave out is not left",
  "  alone: it falls back to a default, which silently changes which file the run reads or",
  "  what language it writes in.",
  "- Edges connect kinds: a node's output kind must match the next node's input kind.",
  "- Do not invent params. Params you do not set keep their defaults.",
  "",
  'Return JSON only: {"reply":"what you changed and why","graph":{"id":"...","version":1,',
  '"nodes":[{"id":"spec","type":"source.spec","params":{}}],"edges":[{"from":"spec","to":"stories"}]}}',
].join("\n");

const PROMPT_STABLE = [
  "You rewrite one PROMPT TEMPLATE used by a test harness.",
  "",
  "Rules that decide whether a rewrite is usable:",
  "- Keep every ${...} placeholder the current template uses. They are filled in at run",
  "  time; dropping one silently removes information the pipeline depends on.",
  "- Keep the output contract (the shape the model must return) exactly as it is. The",
  "  parser downstream is not being rewritten with you.",
  "- Change instructions, not the format. Say what you changed and why.",
  "",
  'Return JSON only: {"reply":"what you changed and why","prompt":"the full new template"}',
].join("\n");

const RUN_STABLE = [
  "You are drafting a RUN REQUEST inside TestPilot. You do not start anything: you fill in",
  "a form that a person will read and press. Say plainly what the run would do.",
  "Only use graph ids, node ids and ablation switches that appear in the context below.",
  "Never invent an evaluation arm: comparisons come from the repository's eval specs, not",
  "from this conversation. If asked to start an evaluation, say that and draft a plain run.",
].join("\n");

/**
 * 字段起草面的共同规矩。**字段各自的任务说明在 `fieldDraft.ts`**——那边是「这个字段是什么」，
 * 这边是「起草这件事怎么做」，两者会各自变化。
 *
 * 三条都不是客套话，每一条都对着一种实测过的失败：
 * 一，没有观察就说没有，别补一条看起来合理的；二，引用只能引下面给了编号的东西；
 * 三，产出会被这个字段自己的校验器判，判回来的理由原样回到对话里——所以不必自评「这份是对的」。
 */
const FIELD_STABLE = [
  "You are drafting ONE FIELD of a TestPilot project, in conversation with the person who owns it.",
  "You do not save anything: they read your draft and press the button.",
  "",
  "Three rules decide whether a draft is usable:",
  "- Say only what the material below supports. A plausible invention is worse than a gap,",
  "  because it reads exactly like an observation and nobody will go and check it.",
  "- Cite only ids that appear below. An id you did not see here does not exist.",
  "- Your draft is checked by this field's own validator, and its complaints come back to you",
  "  verbatim. Fix what it says; do not argue that the draft is fine.",
  "",
  "Answer the person in `reply` — short, and about what you changed or what you still need.",
  "Put the field's value in the other property. Keep the two apart: the reply is for reading,",
  "the value is what gets stored.",
  "",
  "When a draft of yours is already below, you are EDITING it: return the whole value with only",
  "what was asked for changed, and everything else verbatim. Rewriting it from scratch loses",
  "things silently — a smaller version is still a valid one, so nothing will complain.",
].join("\n");

const SCHEMAS = {
  run: {
    type: "object",
    properties: {
      reply: { type: "string" },
      run: {
        type: "object",
        properties: {
          graphId: { type: "string" },
          envRef: { type: "string" },
          url: { type: "string" },
          ablate: { type: "array", items: { type: "string" } },
          budget: {
            type: "object",
            properties: { calls: { type: "number" }, usd: { type: "number" }, ms: { type: "number" } },
          },
          params: { type: "object" },
        },
        required: ["graphId"],
      },
    },
    required: ["reply", "run"],
  },
  capability: {
    type: "object",
    properties: {
      reply: { type: "string" },
      recipe: {
        type: "object",
        properties: {
          id: { type: "string" },
          /**
           * **取值必须和 `CapabilityRecipeSchema` 一致。**
           *
           * 这里曾经漏掉 `"app"`，而 `harness.config.ts` 里六个能力有四个正是 app
           * （PetClinic / Juice Shop / DimeShift / Pagekit，也就是被测对象本身）——
           * 也就是说这个系统里最常见的一类能力，起草面在结构上产不出来，
           * 而约束解码还会把模型强行塞进一个错的 kind。
           *
           * schema 决定模型能产出什么，所以它落后于校验器时，症状是「模型不会写」，
           * 而不是「校验失败」。`server/test/chat-schema.test.ts` 把两边钉在一起。
           */
          kind: { type: "string", enum: ["chain", "model", "mock", "device", "app", "other"] },
          description: { type: "string" },
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          env: { type: "object" },
          cwd: { type: "string" },
          autostart: { type: "boolean" },
          healthcheck: { type: "object" },
          healthIntervalMs: { type: "integer" },
        },
        required: ["id", "kind", "command"],
      },
    },
    required: ["reply", "recipe"],
  },
  graph: {
    type: "object",
    properties: {
      reply: { type: "string" },
      graph: {
        type: "object",
        properties: {
          id: { type: "string" },
          version: { type: "integer" },
          nodes: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, type: { type: "string" }, params: { type: "object" } },
              required: ["id", "type"],
            },
          },
          edges: {
            type: "array",
            items: {
              type: "object",
              properties: { from: { type: "string" }, to: { type: "string" } },
              required: ["from", "to"],
            },
          },
        },
        required: ["id", "nodes", "edges"],
      },
    },
    required: ["reply", "graph"],
  },
  prompt: {
    type: "object",
    properties: { reply: { type: "string" }, prompt: { type: "string" } },
    required: ["reply", "prompt"],
  },
} as const;

function transcript(messages: ChatTurn[]): string {
  return messages.map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.text}`).join("\n\n");
}

/** Pull the JSON object out of a reply that may be wrapped in prose or fences. */
function extract(text: string): Record<string, unknown> | undefined {
  const cleaned = text.replace(/```[a-z]*\n?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return undefined;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** A capability draft, checked exactly as a hand-written recipe is. */
export function checkRecipe(value: unknown, existingIds: string[]): ChatDraft {
  const parsed = CapabilityRecipeSchema.safeParse(value);
  const issues = parsed.success
    ? []
    : parsed.error.issues.map((i) => `${i.path.join(".") || "recipe"}: ${i.message}`);
  if (parsed.success && existingIds.includes(parsed.data.id))
    issues.push(`id: ${parsed.data.id} is already taken by another capability or process`);
  return { kind: "capability", value, valid: issues.length === 0, issues };
}

/**
 * A graph draft, checked by the same validator a hand-drawn graph is saved through — and
 * then compared, key by key, with the version it would replace.
 */
export function checkGraph(value: unknown): ChatDraft {
  const def = value as GraphDef;
  if (!def || typeof def !== "object" || !Array.isArray(def.nodes))
    return { kind: "graph", value, valid: false, issues: ["not a graph: no nodes"] };
  const issues = validateGraph(def, registry).map(
    (i) => `${i.at?.node ? `${i.at.node}: ` : ""}${i.message}`,
  );

  const current = getGraph(def.id);
  const diff = current ? describeDiff(diffGraphs(current, def)) : undefined;
  const warnings: string[] = [];
  if (current)
    for (const change of diffGraphs(current, def).paramsChanged)
      if (change.to === undefined)
        warnings.push(
          `${change.nodeId}.${change.key} would be dropped (was ${JSON.stringify(change.from)}) and fall back to its default`,
        );

  return {
    kind: "graph",
    value,
    valid: issues.length === 0,
    issues,
    warnings: warnings.length ? warnings : undefined,
    diff,
    target: def.id,
  };
}

/**
 * A prompt draft. The check is deliberately narrow: placeholders and the output contract
 * are what the rest of the pipeline depends on, and everything else is a judgement call
 * that belongs to the person reading the diff.
 */
export function checkPrompt(value: unknown, key: string): ChatDraft {
  const text = String(value ?? "");
  const issues: string[] = [];
  const current = (getSettings().prompts as unknown as Record<string, string>)[key];
  if (!(key in DEFAULT_PROMPTS)) issues.push(`prompt: there is no template called ${key}`);
  if (!text.trim()) issues.push("prompt: empty");
  for (const ph of new Set(current?.match(/\$\{[^}]+\}/g) ?? []))
    if (!text.includes(ph)) issues.push(`prompt: dropped the placeholder ${ph}, which is filled in at run time`);
  return { kind: "prompt", value: text, valid: issues.length === 0, issues, target: key };
}

/**
 * 判一份字段草稿。
 *
 * **判定不在这里，在字段自己的校验器里**——这个函数只负责把它说的话原样搬到对话上。
 * 规则包的校验器会拒收编造的来源、引用不到的功能、与来源等级不匹配的 claimType，
 * 而那些拒收理由正是模型下一轮要改的东西，所以它们必须原样出现，不能被概括成
 * 「这份草稿有 3 个问题」。
 */
export function checkField(value: unknown, spec: FieldSpec, previous?: unknown): ChatDraft {
  const { ok, errors } = spec.validate(value);
  const warnings = shrinkWarnings(previous, value);
  return { kind: "field", value, valid: ok, issues: errors, target: spec.id, ...(warnings.length ? { warnings } : {}) };
}

/**
 * What the person is pointing at while they type.
 *
 * The header used to switch between "诊断这次运行" and "改这一步怎么跑" based on the
 * selection, but the selection never left the browser — the model was answering about the
 * pipeline in general while the interface claimed a scope. Either the scope travels or the
 * claim comes off; this is the scope travelling.
 *
 * `node` carries the node's own parameters and what it produced in the run being looked at;
 * `run` carries how the run went. Both are read server-side rather than sent up from the
 * client, so a question cannot be answered against numbers the page happened to be showing.
 */
export interface ChatContext {
  kind: "node" | "run" | "case";
  /** Node id, for kind "node". */
  node?: string;
  /** The run being looked at — supplies the node's output, and is the subject of "run". */
  wfRunId?: string;
  /**
   * 复核队列里正在看的那一条，for kind "case"。
   *
   * composer 挂在条目上，作用域就得跟着条目走：问「这一条为什么被门禁点了」时，
   * 手里必须有**这一条**的步骤、判据和它身上那几条 finding，而不是整批的摘要。
   */
  caseId?: string;
}

export interface ChatInput {
  projectId?: string;
  messages: ChatTurn[];
  intent: ChatIntent;
  /** For a graph draft: which graph is being changed. */
  graphId?: string;
  /** For a prompt draft: which template is being rewritten. */
  promptKey?: string;
  /**
   * For a field draft: which complex field this drawer is filling（`fieldDraft.ts` 的 FieldId）。
   *
   * 抽屉是**附着在字段上**打开的，所以这个 id 决定三件事：给模型什么任务说明、
   * 喂它哪些上下文、以及**由谁判草稿合不合格**。判定不由模型自称——见 fieldDraft.ts。
   */
  field?: string;
  /**
   * 上一轮起草出来的那份值。
   *
   * 给它两个用处：进提示词，让这一轮是**改**而不是重写；以及和新的一份比一比，
   * 少了什么就说出来（`shrinkWarnings`）。缺了前者，实测是改一个枚举值顺手丢掉三个功能。
   */
  previous?: unknown;
  existingIds?: string[];
  /** What the question is about, when the person has something selected. */
  context?: ChatContext;
}

/** A value big enough to drown the conversation is summarised, not pasted. */
function brief(value: unknown, limit = 900): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;
}

/**
 * 一个节点的产出，**整批**摊给模型——但摊的是形状，不是字节。
 *
 * 此前这里是 `brief(output, 900)`：40 条用例的产物几千行，砍到 900 字符之后
 * 剩下的是前两条用例的 JSON 开头。于是问「62% 差在哪、这 11 条 finding 先改哪三条」
 * 得到的必然是**语气正确的空话**——模型手里根本没有那 11 条。
 *
 * 解法不是把上限调大（那只会把上下文塞满冗余的 JSON 括号），而是换一种摊法：
 * 每条用例一行、每条 finding 一行，各带一个可以被引用的编号。
 * 40 条用例加 11 条 finding 大约两三千字符，而且**一条都没少**。
 */
export function digest(value: unknown): string {
  if (!value || typeof value !== "object") return brief(value);
  const o = value as {
    cases?: Array<{ id?: string; title?: string; method?: string; tier?: unknown }>;
    stories?: Array<{ id?: string; title?: string }>;
    gate?: {
      score?: number;
      scoreBasis?: { cases: number; flagged: string[]; formula: string };
      findings?: Array<{ rule: string; severity: string; message: string; caseId?: string }>;
      stats?: Record<string, unknown>;
    };
  };
  const out: string[] = [];

  if (o.gate) {
    if (o.gate.score !== undefined) out.push(`gate score: ${o.gate.score.toFixed(3)}`);
    if (o.gate.scoreBasis)
      out.push(
        `how that score is computed: ${o.gate.scoreBasis.formula}`,
        `cases dragging it down (${o.gate.scoreBasis.flagged.length}): ${o.gate.scoreBasis.flagged.join(", ")}`,
      );
    if (o.gate.stats) out.push(`stats: ${JSON.stringify(o.gate.stats)}`);
    const fs = o.gate.findings ?? [];
    if (fs.length) {
      out.push(`ALL ${fs.length} gate findings, numbered — cite them by number:`);
      // 一条都不省。省掉的那几条恰恰可能是最该先改的三条。
      fs.forEach((f, i) =>
        out.push(`  [F${i + 1}] ${f.severity} ${f.rule} · ${f.caseId ?? "(batch)"} · ${brief(f.message, 180)}`),
      );
    }
  }

  if (o.stories?.length) {
    out.push(`ALL ${o.stories.length} stories, numbered:`);
    o.stories.forEach((s, i) => out.push(`  [S${i + 1}] ${s.id ?? ""} ${s.title ?? ""}`.trimEnd()));
  }

  if (o.cases?.length) {
    out.push(`ALL ${o.cases.length} cases, numbered — cite them by number:`);
    o.cases.forEach((c, i) =>
      out.push(`  [C${i + 1}] ${c.id ?? ""} · ${c.title ?? ""}${c.method ? ` · ${c.method}` : ""}`),
    );
  }

  // 认不出来的形状按老办法给，但给得比 900 宽——一个认不出的产物不该比认得出的更吃亏。
  return out.length ? out.join("\n") : brief(value, 4000);
}

/**
 * Turn a selection into lines the model can use.
 *
 * Absent pieces are simply left out. A heading followed by nothing tells the model there is
 * a fact it is not being given, which is worse than not raising the subject.
 */
async function contextLines(ctx: ChatContext | undefined): Promise<string[]> {
  if (!ctx) return [];
  const out: string[] = [];
  const run = ctx.wfRunId ? outputStore.getRun(ctx.wfRunId) : undefined;
  const detail = (run?.detail ?? {}) as {
    nodes?: Array<{ nodeId: string; status: string; ms: number; spend?: { calls: number; tokens: number } }>;
    spend?: Record<string, number>;
    ablate?: string[];
  };

  if (ctx.kind === "node" && ctx.node) {
    const graphId = String(run?.graphId ?? "");
    const def = graphId ? getGraph(graphId) : undefined;
    const node = def?.nodes.find((n) => n.id === ctx.node);
    out.push(`THE PERSON IS ASKING ABOUT NODE "${ctx.node}".`);
    if (node) out.push(`type: ${node.type}`, `params: ${JSON.stringify(node.params ?? {})}`);
    const record = detail.nodes?.find((n) => n.nodeId === ctx.node);
    if (record)
      out.push(
        `in run ${ctx.wfRunId}: ${record.status}, ${Math.round(record.ms / 1000)}s` +
          (record.spend ? `, ${record.spend.calls} model calls, ${record.spend.tokens} tokens` : ""),
      );
    if (ctx.wfRunId) {
      const output = await nodeOutput(ctx.wfRunId, ctx.node).catch(() => undefined);
      if (output !== undefined) out.push("what it produced:", digest(output));
    }
  }

  if (ctx.kind === "case" && ctx.caseId && ctx.wfRunId) {
    /*
     * 这一条用例，连同它身上那几条 finding。
     *
     * 从门禁那一步的产出里挑出这一条——而不是把整批塞进来：作用域是条目，
     * 那么给的也该是条目。整批的问题有整批的问法（kind "run"）。
     */
    out.push(`THE PERSON IS ASKING ABOUT ONE CASE: ${ctx.caseId} (in run ${ctx.wfRunId}).`);
    const gated = (await nodeOutput(ctx.wfRunId, "gate").catch(() => undefined)) as
      | {
          cases?: Array<Record<string, unknown> & { id?: string }>;
          gate?: { findings?: Array<{ rule: string; severity: string; message: string; caseId?: string }> };
        }
      | undefined;
    const kase = gated?.cases?.find((c) => c.id === ctx.caseId);
    if (kase) out.push("the case:", brief(kase, 2500));
    const mine = (gated?.gate?.findings ?? []).filter((f) => f.caseId === ctx.caseId);
    if (mine.length) {
      out.push(`gate findings against THIS case (${mine.length}):`);
      mine.forEach((f, i) => out.push(`  [F${i + 1}] ${f.severity} ${f.rule} · ${brief(f.message, 200)}`));
    } else out.push("the gate raised nothing against this case.");
  }

  if (ctx.kind === "run" && run) {
    out.push(`THE PERSON IS ASKING ABOUT RUN ${ctx.wfRunId} (${run.graphId} v${run.graphVersion}, ${run.status}).`);
    if (detail.nodes?.length)
      out.push(
        "nodes:",
        ...detail.nodes.map(
          (n) => `- ${n.nodeId}: ${n.status}, ${Math.round(n.ms / 1000)}s${n.spend ? `, ${n.spend.calls} calls` : ""}`,
        ),
      );
    if (detail.spend) out.push(`spend: ${JSON.stringify(detail.spend)}`);
    if (detail.ablate?.length) out.push(`ablated: ${detail.ablate.join(", ")}`);
    /*
     * 问「这次运行 62% 差在哪」时，门禁那一步的产出得在手里。
     *
     * 只给一串节点状态，模型能说的就只有「gate 这一步跑完了」——而那不是问题。
     * 门禁节点的产出摊成编号清单（见 digest），回答才引得出具体是哪几条。
     */
    for (const nodeId of ["gate", "codegate"]) {
      if (!detail.nodes?.some((n) => n.nodeId === nodeId)) continue;
      const output = ctx.wfRunId ? await nodeOutput(ctx.wfRunId, nodeId).catch(() => undefined) : undefined;
      if (output !== undefined) out.push(`what "${nodeId}" produced:`, digest(output));
    }
  }

  return out.length ? ["", ...out, ""] : [];
}

/**
 * 起草面开场要摆给人看的两样东西：有哪些字段可以起草，以及**哪几次运行手里有材料**。
 *
 * 第二样是这个抽屉能不能省下人工的关键。没有材料的起草，产出的是一份读起来完整、
 * 每一条都无从核对的规则包——比空着更糟，因为它看上去已经填好了。所以选运行这一步
 * 摆在明面上，每一行还带着「几份材料、模块树冻没冻」：人一眼看得出自己选的是不是空的。
 */
export function fieldSources(projectId: string) {
  const fields = Object.values(FIELDS).map((f) => ({ id: f.id, title: f.title, needs: [...f.needs] }));
  let runs: Array<{ runId: string; at?: string; status?: string; materials: number; modules: number }> = [];
  try {
    const l = runLedger();
    const byRun = new Map<string, number>();
    for (const r of l.listRevisions(projectId)) {
      if (r.kind !== "material") continue;
      byRun.set(r.runId, (byRun.get(r.runId) ?? 0) + 1);
    }
    runs = [...byRun.entries()]
      .map(([runId, materials]) => {
        const run = outputStore.getRun(runId);
        let modules = 0;
        try {
          modules = frozenModules(runId, projectId)?.length ?? 0;
        } catch {
          /* 没冻结过就是 0 */
        }
        return { runId, at: run?.startedAt === undefined ? undefined : String(run.startedAt), status: run?.status ? String(run.status) : undefined, materials, modules };
      })
      // 新的在前：人要找的几乎总是刚跑完的那一次。
      .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))
      .slice(0, 30);
  } catch {
    /* 账本还没建起来——没有可选的运行，抽屉照常开得了 */
  }
  return { fields, runs };
}

/**
 * 一个字段起草时看得见的东西。
 *
 * 只喂 `needs` 声明要的那几样：起草规则包要探索材料和模块树，写领域知识只要材料。
 * 多喂没有好处——上下文里多出来的每一样都是模型可以引用的东西，而它引用了就等于
 * 我们默许它把那样东西写进这个字段。
 *
 * **没有运行也要能用。** 抽屉是从字段上点开的，那一刻常常还没有任何一次运行
 * （新项目的第一件事往往正是填规则包）。那就明说材料是空的，让对话去问人，
 * 而不是让模型对着一片空白编一份看起来完整的规则包。
 */
async function fieldContextLines(spec: FieldSpec, projectId?: string, runId?: string): Promise<string[]> {
  const out: string[] = [];
  const needs = new Set(spec.needs);
  if (!runId || !projectId) {
    out.push(
      "NO RUN IS SELECTED, so there is no exploration material and no module tree.",
      "Draft only from what the person tells you in the conversation, and say plainly which",
      "parts you could not ground. Do not fill the gap with what products like this usually do.",
    );
    return ["", ...out, ""];
  }

  if (needs.has("exploration")) {
    let material: Array<{ name: string; text: string }> = [];
    try {
      const l = runLedger();
      material = l
        .listRevisions(projectId, runId)
        .filter((r) => r.kind === "material")
        .map((r) => ({ name: r.name, content: l.readRevision(r.id, projectId).content }))
        .filter((r): r is { name: string; content: string } => typeof r.content === "string")
        .map((r) => ({ name: r.name, text: r.content }));
    } catch {
      /* 这次运行没在账本里登记过——退回节点产出 */
    }
    if (!material.length) {
      const seen = (await nodeOutput(runId, "source").catch(() => undefined)) as { text?: unknown } | undefined;
      if (typeof seen?.text === "string") material = [{ name: "source", text: seen.text }];
    }
    if (material.length) {
      out.push("OBSERVED MATERIAL (what the product was seen doing — this is your only evidence):");
      /*
       * 每份材料截到 12000 字符。探索材料是一屏一段，前面几屏是产品的主界面——
       * 砍掉尾巴丢的是边角，而整份不砍会把对话挤没。段的编号口径见 materialSections。
       */
      for (const m of material) out.push(`----- ${m.name} -----`, brief(m.text, 12000));
    } else out.push("THIS RUN HAS NO MATERIAL YET: say so instead of drafting from nothing.");
  }

  if (needs.has("modules")) {
    const modules = (() => {
      try {
        return frozenModules(runId, projectId);
      } catch {
        return undefined;
      }
    })();
    if (modules?.length) {
      out.push(
        "THE FROZEN MODULE TREE (a rule's `moduleId`, if you set one, must be one of these ids):",
        ...modules.map((m) => `- ${m.id}${m.parentId ? ` (under ${m.parentId})` : ""} · ${m.name ?? ""} ${m.purpose ? `— ${brief(m.purpose, 160)}` : ""}`),
      );
    } else out.push("NO MODULE TREE IS FROZEN for this run: do not invent module ids.");
  }

  if (needs.has("stories")) {
    const stories = (await nodeOutput(runId, "stories").catch(() => undefined)) as { stories?: Array<{ id?: string; title?: string }> } | undefined;
    if (stories?.stories?.length)
      out.push("STORIES:", ...stories.stories.map((st) => `- ${st.id ?? "?"} · ${brief(st.title ?? "", 120)}`));
  }

  return ["", ...out, ""];
}

export async function chat(input: ChatInput): Promise<ChatResult> {
  const run = input.context?.wfRunId ? outputStore.getRun(input.context.wfRunId) : undefined;
  const runProject = (run?.detail as { target?: { projectId?: string } } | undefined)?.target?.projectId;
  const model = projectPlannerModel(runProject ?? input.projectId, "chat.draft");
  const intent = input.intent;

  const context: string[] = await contextLines(input.context);
  if (intent === "graph") {
    context.push(
      "NODE TYPE PALETTE (type · in kind → out kind):",
      ...registry.list().map((n) => `- ${n.type} · ${n.inKind ?? "—"} → ${n.outKind}`),
    );
    const current = input.graphId ? getGraph(input.graphId) : undefined;
    if (current) context.push("", "CURRENT GRAPH:", JSON.stringify(current, null, 2));
  }
  if (intent === "prompt") {
    const key = input.promptKey ?? "explore";
    context.push(`CURRENT TEMPLATE (${key}):`, "", (getSettings().prompts as unknown as Record<string, string>)[key] ?? "");
  }

  if (intent === "run") {
    context.push(
      "GRAPHS YOU MAY START (id · title):",
      ...listGraphs().map((g) => `- ${g.id} · ${g.title ?? ""} (nodes: ${g.nodes.map((n) => n.id).join(", ")})`),
      "ABLATION SWITCHES THAT EXIST:",
      ...ABLATION_NAMES.map((a) => `- ${a}`),
    );
  }

  /**
   * 字段起草：把这个字段要的上下文摆出来。
   *
   * 探索材料给的是**观察**，所以起草出来的规则只能是 observed——这句既写在
   * 任务说明里，也由 `validateRulePack` 强制（没有产品级来源的 normative 会被拒）。
   */
  let fieldSpec: FieldSpec | undefined;
  if (intent === "field") {
    if (!isFieldId(input.field)) throw new Error(`unknown_field:${String(input.field)}`);
    fieldSpec = FIELDS[input.field];
    context.push(...(await fieldContextLines(fieldSpec, input.projectId, input.context?.wfRunId)));
    if (input.previous !== undefined)
      context.push(
        "",
        "YOUR CURRENT DRAFT — edit THIS, and return the WHOLE thing:",
        typeof input.previous === "string" ? input.previous : JSON.stringify(input.previous, null, 1),
      );
  }

  const stable =
    intent === "field"
      ? [FIELD_STABLE, "", fieldSpec!.instruction].join("\n")
      : intent === "capability"
      ? CAPABILITY_STABLE
      : intent === "graph"
        ? GRAPH_STABLE
        : intent === "prompt"
          ? PROMPT_STABLE
          : intent === "run"
            ? RUN_STABLE
            : ASK_STABLE;

  const res = await model.chat({
    stable,
    variable: [...context, "", "CONVERSATION:", "", transcript(input.messages)].join("\n"),
    schema: intent === "ask" ? undefined
      : intent === "field" ? (fieldSpec!.schema as unknown as Record<string, unknown>)
      : (SCHEMAS[intent] as unknown as Record<string, unknown>),
    // 规则包比一张图还大：给少了只会被截断，而截断的 JSON 连校验都进不去。
    maxTokens: intent === "field" ? 6000 : intent === "graph" || intent === "prompt" ? 2500 : 1200,
    label: `chat:${intent}`,
  });

  if (intent === "ask") return { reply: res.text.trim(), tokens: res.tokens, ms: res.ms };

  const obj = extract(res.text);
  if (!obj)
    return {
      reply: res.truncated
        ? "the reply was cut off before it produced a draft — ask for something smaller"
        : res.text.trim() || "no draft came back",
      tokens: res.tokens,
      ms: res.ms,
    };

  const reply = String(obj.reply ?? "").trim();

  /*
   * 模型这一轮只说了话、没给值——那是一次**提问**，不是一份空草稿。
   *
   * 起草规则包的头几轮基本都是这样：它得先问清这个产品是做什么的。把 undefined
   * 交给校验器，得到的是一串「缺这缺那」的红字，看起来像模型答错了，
   * 而它其实是在等人回答。
   */
  if (intent === "field" && obj[fieldSpec!.valueKey] === undefined)
    return { reply: reply || res.text.trim(), tokens: res.tokens, ms: res.ms };

  const draft =
    intent === "field"
      ? checkField(obj[fieldSpec!.valueKey], fieldSpec!, input.previous)
      : intent === "capability"
      ? checkRecipe(obj.recipe, input.existingIds ?? [])
      : intent === "graph"
        ? checkGraph(obj.graph)
        : intent === "run"
          ? checkRun(obj.run)
          : checkPrompt(obj.prompt, input.promptKey ?? "explore");

  return { reply, draft, tokens: res.tokens, ms: res.ms };
}

/**
 * 一份起跑草稿能不能被按下去。
 *
 * 校验在这里做完，是因为**按下之后不会再有第二次机会**：那一下走的是和界面按钮
 * 一模一样的 `startRun`，而 startRun 只认真实存在的图、节点和开关。
 * 模型编一个不存在的图 id，最坏的结果不该是二十分钟以后的一句 zod 错误。
 */
export function checkRun(value: unknown): ChatDraft {
  const issues: string[] = [];
  const warnings: string[] = [];
  const v = (value ?? {}) as {
    graphId?: string;
    envRef?: string;
    url?: string;
    ablate?: string[];
    budget?: Record<string, number>;
    params?: Record<string, Record<string, unknown>>;
  };

  const def = v.graphId ? getGraph(v.graphId) : undefined;
  if (!v.graphId) issues.push("没说要跑哪张图");
  else if (!def) issues.push(`没有叫 ${v.graphId} 的图`);

  for (const a of v.ablate ?? [])
    if (!ABLATION_NAMES.includes(a)) issues.push(`${a} 不是一个存在的消融开关`);

  for (const nodeId of Object.keys(v.params ?? {}))
    if (def && !def.nodes.some((n) => n.id === nodeId))
      issues.push(`${v.graphId} 上没有叫 ${nodeId} 的节点`);

  // 没给上限不是错，但值得说一句：一次没有上限的运行停不下来，除非人自己去停。
  if (!v.budget || !Object.keys(v.budget).length) warnings.push("这次没有给上限——它会一直跑到跑完");

  return { kind: "run", value: v, valid: issues.length === 0, issues, ...(warnings.length ? { warnings } : {}) };
}

/**
 * Applying a draft.
 *
 * Re-validated here rather than trusting the check the chat already did: the client is the
 * one holding the draft between the two calls, and "it was valid when we showed it to you"
 * is not a property the gateway can verify.
 */
export function applyGraphDraft(def: GraphDef, note?: string): GraphDef {
  const check = checkGraph(def);
  if (!check.valid) throw new Error(`this graph does not validate: ${check.issues.join("; ")}`);
  return saveGraph(def, note ?? "from chat");
}

export function validRecipeOrThrow(value: unknown, existingIds: string[]): CapabilityRecipe {
  const check = checkRecipe(value, existingIds);
  if (!check.valid) throw new Error(`this recipe does not validate: ${check.issues.join("; ")}`);
  return CapabilityRecipeSchema.parse(value) as CapabilityRecipe;
}
