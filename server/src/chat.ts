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
export type ChatIntent = "capability" | "graph" | "prompt" | "ask" | "run";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ChatDraft {
  kind: "capability" | "graph" | "prompt" | "run";
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

  const stable =
    intent === "capability"
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
    schema: intent === "ask" ? undefined : (SCHEMAS[intent] as unknown as Record<string, unknown>),
    maxTokens: intent === "graph" || intent === "prompt" ? 2500 : 1200,
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
  const draft =
    intent === "capability"
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
