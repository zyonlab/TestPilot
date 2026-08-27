import {
  CapabilityRecipeSchema,
  describeDiff,
  diffGraphs,
  gated,
  modelFromEnv,
  validateGraph,
  type CapabilityRecipe,
  type GraphDef,
} from "@testpilot/harness-core";
import { getGraph, nodeOutput, outputStore, registry, saveGraph } from "./graphs.js";
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

export type ChatIntent = "capability" | "graph" | "prompt" | "ask";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ChatDraft {
  kind: "capability" | "graph" | "prompt";
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
  "the harness starts, watches and stops: a local chain, a model proxy, a mock backend.",
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

const SCHEMAS = {
  capability: {
    type: "object",
    properties: {
      reply: { type: "string" },
      recipe: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["chain", "model", "mock", "device", "other"] },
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
  kind: "node" | "run";
  /** Node id, for kind "node". */
  node?: string;
  /** The run being looked at — supplies the node's output, and is the subject of "run". */
  wfRunId?: string;
}

export interface ChatInput {
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
      if (output !== undefined) out.push("what it produced:", brief(output));
    }
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
  }

  return out.length ? ["", ...out, ""] : [];
}

export async function chat(input: ChatInput): Promise<ChatResult> {
  const model = gated(modelFromEnv());
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

  const stable =
    intent === "capability"
      ? CAPABILITY_STABLE
      : intent === "graph"
        ? GRAPH_STABLE
        : intent === "prompt"
          ? PROMPT_STABLE
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
        : checkPrompt(obj.prompt, input.promptKey ?? "explore");

  return { reply, draft, tokens: res.tokens, ms: res.ms };
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
