import { OpenAIModel, gated, traced, plannerModel, plannerConnectionFromEnv, type ModelClient } from "@testpilot/harness-core";
import { projectModelConnection } from "./modelProfiles.js";
import { resolveModelRuntime, PROBE_IMAGE, type ModelConfig } from "./config.js";
import { getSettings, langDirective } from "./settings.js";

/**
 * Domain generation uses the project planner, or explicit TP_PLANNER_* defaults.
 * The retired global model probe keeps its own override path for compatibility;
 * project role probes live in modelProfilesRoutes.ts.
 */
function gatewayModel(opts?: { timeoutMs?: number; retries?: number; override?: Partial<ModelConfig>; executorProbe?: boolean; projectId?: string }): ModelClient {
  if (!opts?.executorProbe) return traced(gated(plannerModel(opts?.projectId
    ? projectModelConnection(opts.projectId, "planner") : plannerConnectionFromEnv())), { name: "gateway.planner" });
  // `override` 只有「测试连接」用：人在框里填了一组值，要测的就是那一组，
  // 不是服务端此刻在跑的那一组。不接它的话，按钮测的永远是后者——
  // 而那正好让「我改了参数再测一次」这个动作完全失效。
  const r = resolveModelRuntime(opts?.override);
  return traced(
    gated(
      new OpenAIModel({
        baseUrl: r.baseUrl,
        apiKey: r.apiKey,
        model: r.modelName,
        noThink: r.noThink,
        ...(r.thinkBudget !== undefined ? { thinkBudget: r.thinkBudget } : {}),
        timeoutMs: opts?.timeoutMs ?? r.timeoutMs,
        ...(opts?.retries !== undefined ? { retries: opts.retries } : {}),
      }),
    ),
    { name: "gateway.model" },
  );
}

export type ProbeResult =
  | { state: "ok"; detail: string }
  | { state: "notMultimodal"; detail: string }
  | { state: "fail"; detail: string };

// Probe the endpoint: reachable? accepts images (multimodal)?
export async function probeModel(
  override?: Partial<ModelConfig>,
): Promise<ProbeResult> {
  // 探活只调两个旋钮：更短的超时、只试一次。其余全部由 `OpenAIModel` 装配，
  // 与真实运行逐字相同——这正是这次改动的全部意义。
  const text = gatewayModel({ timeoutMs: 30_000, retries: 1, override, executorProbe: true });
  const vision = gatewayModel({ timeoutMs: 60_000, retries: 1, override, executorProbe: true });
  const r = resolveModelRuntime(override);

  // Step 1: reachability + basic text completion.
  try {
    await text.chat({
      stable: "Reply with the single word: ok",
      variable: "",
      /**
       * **`maxTokens` 不能按「答案有多长」估。**
       *
       * 这个端点关不掉思考（实测：`enable_thinking:false` 与 `chat_template_kwargs`
       * 都不认，每次多烧 20–60 个推理 token）。此前探活给的是 16，
       * 于是推理还没写完就撞上限，`content` 回来是空的——
       * **一个能看图的模型被探针判成了瞎的**。
       * 走 `OpenAIModel` 之后它会自动加上 thinkBudget，这里只需给答案留够。
       */
      maxTokens: 64,
      label: "model.probe.text",
    });
  } catch (e) {
    return {
      state: "fail",
      detail: `Could not reach the endpoint. ${(e as Error).message}`,
    };
  }

  // Step 2: multimodal probe — send an image and see if the model handles it.
  try {
    const out = await vision.chat({
      stable: "What is in this image? Answer in one word.",
      variable: "",
      images: [PROBE_IMAGE],
      maxTokens: 96,
      label: "model.probe.vision",
    });
    return {
      state: "ok",
      // 把**生效的**端点与模型一起报出来：探活最常见的误诊是「测的不是跑的那一个」。
      detail:
        `Reachable and multimodal. Model replied: "${out.text.trim().slice(0, 60)}"` +
        ` · ${out.model ?? r.modelName} @ ${r.baseUrl}` +
        ` · 思考${r.noThink ? "关" : "开"}（与真实运行相同）`,
    };
  } catch (e) {
    return {
      state: "notMultimodal",
      detail: `Endpoint reachable, but the image request failed — likely not a vision-language model. ${(e as Error).message}`,
    };
  }
}

// Generate runnable Midscene code from natural-language steps (falls back to a template).
export async function generateCode(
  title: string,
  steps: string[],
  expected: string,
  projectId?: string,
): Promise<string> {
  const client = gatewayModel({ projectId });
  // The instruction preamble is a configurable template; the case-specific data is
  // always appended by code so the placeholders can't be broken by an edit.
  const preamble = getSettings().prompts.generateCode;
  /**
   * 拆成 stable / variable 两半，而不是拼成一个字符串。
   *
   * 前缀缓存只在**开头那几个字节逐字相同**时才命中——把每次都变的用例正文
   * 拼在模板前面或中间，缓存就永远不命中。`ChatRequest` 的形状本来就是
   * 为了逼调用方说清「哪一半从不变化」。
   */
  const caseText = `Test: ${title}
Steps:
${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}
Expected result: ${expected || "the action succeeds"}`;

  try {
    const out = await client.chat({
      // stable 走前缀缓存：它在这个节点里从不变化。
      stable: `You output only code, no prose.\n\n${preamble}`,
      variable: caseText,
      maxTokens: 800,
      // label 此前和 refineCase 装反了：这里写的是 "case.refine"，
      // 而 refineCase 写的是 "case.generate-code"。一条按 label 归因的成本报表，
      // 会把这两件事的账记到对方头上。
      label: "case.generate-code",
    });
    const cleaned = out.text.replace(/```[a-z]*\n?/gi, "").trim();
    if (cleaned) return cleaned;
  } catch {
    // fall through to template
  }
  return [
    ...steps.map((s) => `await agent.aiAction(${JSON.stringify(s)});`),
    `await agent.aiAssert(${JSON.stringify(expected || "the action succeeds")});`,
  ].join("\n");
}

// Edit-time AI node intervention: given a case and a natural-language instruction, return a
// proposed change to either its steps or its oracle. Returns the proposal only — the caller
// diffs it against the current value and applies it (via PATCH) if the user accepts. Nothing
// is ever mutated silently.
export type RefineTarget = "steps" | "oracle" | "data";
export interface RefineResult {
  target: RefineTarget;
  proposedSteps?: string[]; // present when target === "steps" or "data" (both edit the step list)
  proposedExpected?: string; // present when target === "oracle"
  note: string; // one-line explanation of what changed (for the diff header)
}

function extractJson(raw: string): any {
  const cleaned = raw.replace(/```[a-z]*\n?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function refineCase(
  input: {
    title: string;
    steps: string[];
    expected: string;
    type: string;
    target: RefineTarget;
    instruction: string;
    stepIdx?: number; // optional: focus the edit on one step
    lang?: string; // optional: UI language to force the output into (when enforced)
  },
  projectId?: string,
): Promise<RefineResult> {
  const focus =
    typeof input.stepIdx === "number"
      ? `Focus your change on step ${input.stepIdx + 1}, but you may add/split steps around it if needed.`
      : "";

  const stepsShape =
    `Return JSON: {"steps": ["<step 1>", "<step 2>", ...], "note": "<one short line: what you changed>"}. ` +
    `Each step is a short, concrete natural-language UI action (as passed to Midscene aiAction). ` +
    `Keep placeholders like \${env.KEY} and \${secret.KEY} intact. Return the FULL updated step list, not a diff.`;
  const shape =
    input.target === "steps"
      ? stepsShape
      : input.target === "data"
        ? `The instruction is about the TEST DATA / inputs (which account, values, edge-case inputs, or ` +
          `parameterization the steps use). Adjust the data used INSIDE the steps accordingly — prefer ` +
          `placeholders \${env.KEY} / \${secret.KEY} for credentials over literal values, and use concrete ` +
          `literals for non-secret test data. ` +
          stepsShape
        : `Return JSON: {"expected": "<one concrete, checkable assertion of the successful/error outcome>", "note": "<one short line: what you changed>"}. ` +
          `This is the pass/fail oracle checked by Midscene aiAssert.`;

  const prompt = `You are refining an automated UI test based on a QA engineer's instruction.
Return ONLY JSON, no prose, no markdown fences.

Test title: ${input.title}
Type: ${input.type}
Current steps:
${input.steps.map((s, i) => `${i + 1}. ${s}`).join("\n") || "(none)"}
Current expected (oracle): ${input.expected || "(none)"}

Instruction: ${input.instruction}
${focus}

${shape}${langDirective(input.lang)}`;

  const out = await gatewayModel({ projectId }).chat({
    stable: "You output only strict JSON, no prose.",
    variable: prompt,
    maxTokens: 900,
    label: "case.refine",
  });
  const parsed = extractJson(out.text);
  const note = typeof parsed.note === "string" ? parsed.note : "AI-proposed change";
  if (input.target === "steps" || input.target === "data") {
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.map((s: unknown) => String(s)).filter((s: string) => s.trim())
      : [];
    if (!steps.length) throw new Error("model returned no steps");
    return { target: input.target, proposedSteps: steps, note };
  }
  const expected = typeof parsed.expected === "string" ? parsed.expected.trim() : "";
  if (!expected) throw new Error("model returned no expected");
  return { target: "oracle", proposedExpected: expected, note };
}
