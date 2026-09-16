/**
 * TestPilot MCP server (stdio) —— 八个确定性工具。
 *
 * 九步仍然是**一个**工具（`run_pipeline`）：把它们分别暴露出去，agent 就能挑顺序，
 * 配对评测就不成立了（架构 §8）。加进来的另外七个都不是「九步里的一步」——
 * 它们是九步**之外**的事：取规格、打分、比两次、注缺陷、跑一条、读决定、校准 judge。
 *
 * 每个 `description` 是写给模型看的：一句 what，一句 when，第三人称。
 * 模型选工具靠的就是这两句——写成给人看的说明书，它会在该调 `score_run` 的时候
 * 去调 `run_pipeline`。
 *
 * stdout 归 JSON-RPC，进度一律写 stderr（每行一个 JSON）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RunGateway } from "./run-gateway.js";
import { HostApi } from "./host/api.js";
import { registerHostDomains } from "./host/tools.js";
import {
  CalibrateJudgeInput,
  DriveSutInput,
  MutateAndDetectInput,
  PairedEvalInput,
  ReadDecisionsInput,
  ExtractEpisodesInput,
  RetrieveSpecInput,
  RunPipelineInput,
  ScoreRunInput,
  Held,
  heldResult,
  WriteStoriesInput,
  WriteCasesInput,
  RunCaseInput,
  RunP0Input,
} from "./contracts.js";
import { runPipeline, type ProgressEvent } from "./pipeline.js";
import { fencedRetrieveText, retrieveSpec } from "./retrieve.js";
import { TIER_ONE_CAP, extractEpisodes, formatEpisode } from "./memory.js";
import { pairedEval, scoreRun } from "./score.js";
import { driveSut, mutateAndDetect } from "./exec.js";
import { calibrateJudge } from "./calibrate.js";
import { DEFAULT_RUNS_DIR, readDecisions, resolveRunDir } from "./runs.js";
import { writeArtifact } from "./write.js";
import { runCase, runP0 } from "./runcase.js";

const log = (e: ProgressEvent) => process.stderr.write(JSON.stringify(e) + "\n");

/** 节点 id → 一句人话，进度条上显示的就是它。 */
const NODE_LABEL: Record<string, string> = {
  docs: "读取材料",
  spec: "归纳规格",
  stories: "拆解用户故事",
  design: "设计测试用例",
  gate: "过测试设计门禁",
};
const stepLabel = (id: string): string => NODE_LABEL[id] ?? id;

/** 一个 ProgressEvent 变成进度条上的一行人话。 */
function progressMessage(e: ProgressEvent): string | undefined {
  const label = stepLabel(e.nodeId);
  if (e.kind === "node.started") return `▶ ${label}…`;
  if (e.kind === "node.finished") {
    const p = (e.payload ?? {}) as { status?: string; tokens?: number; wrote?: string; ms?: number; error?: string };
    if (p.status === "failed") return `✗ ${label} 失败：${p.error ?? ""}`;
    const secs = p.ms != null ? `${Math.round(p.ms / 1000)}s` : "";
    const tok = p.tokens ? `${Math.round(p.tokens / 1000)}k tok` : "";
    const wrote = p.wrote ? `→ ${p.wrote}` : "";
    return `✓ ${label} ${[wrote, [tok, secs].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}`.trim();
  }
  return undefined;
}

const server = new McpServer({ name: "testpilot", version: "0.2.0" });
const runs = new RunGateway();
/**
 * 宿主入口：UI 能做的操作，这里逐域暴露给宿主（docs/v3 的 host-parity）。
 *
 * 它走的是 UI 同一套 HTTP 接口，不复制任何服务端逻辑——「入口从 UI 换成宿主」
 * 要成立，两条入口就必须共用一份实现。需要运行写入凭证的动作从 RunGateway 取，
 * 凭证留在 MCP 进程内存里，不经过模型。
 */
const hostApi = new HostApi({ tokenFor: (runId) => runs.tokenFor(runId) });
registerHostDomains(server, hostApi);

/**
 * 一次工具调用的回复。
 *
 * 错误**不抛到传输层**，而是作为 `isError` 的内容回去：一个 JSON-RPC 层的异常在模型那边
 * 表现为「工具坏了」，而这些错误里绝大多数是「你给的东西不对，具体是这样不对」——
 * 那是模型自己能改的，前提是它读得到。
 */
const ok = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});
/**
 * 三态里的第三态。被门禁拦下**不是错误**：`isError` 不设，`structuredContent.status = "blocked"`，
 * 带拦它的那道门的名字。宿主与审计台按 `gate` 计数；模型读 `reason` 知道该补什么。
 * 一个 `isError` 的结果在模型那边读作「工具坏了」，而这些恰恰是「你给的东西不合规矩」。
 */
const held = (h: Held) => {
  const value = heldResult(h);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as unknown as Record<string, unknown>,
  };
};
const fail = (e: unknown) =>
  e instanceof Held
    ? held(e)
    : {
        content: [{ type: "text" as const, text: (e as Error).message }],
        isError: true,
      };

const RegisterRunInput = {
  projectId: z.string().min(1), externalId: z.string().min(1), idempotencyKey: z.string().min(1),
  runtime: z.enum(["penguin", "claude-code", "codex"]), model: z.string().optional(), provider: z.string().optional(),
  materials: z.array(z.object({ name: z.string().min(1), text: z.string().min(1) })).min(1),
  parameters: z.record(z.unknown()).optional(),
};
server.registerTool("register_run", {
  title: "Register a host-planned project run",
  description: "Starts or resumes one idempotent skill-mode run in the TestPilot project. Uses this host for planning and the project's executor profile for Midscene. Freezes the supplied material text and returns public run metadata; never configures a separate planner.",
  inputSchema: RegisterRunInput,
}, async ({ projectId, ...input }) => { try { return ok(await runs.register(projectId, input)); } catch (e) { return fail(e); } });
server.registerTool("generate_execution", {
  title: "Compile the approved case revisions",
  description: "Compiles the current human-approved immutable case revisions into Midscene actions and runs the code gate. No planner model is called. Rejected, stale or unapproved revisions cannot be executed.",
  inputSchema: { runId: z.string(), revisionIds: z.array(z.string()).optional() },
}, async ({ runId, ...input }) => { try { return ok(await runs.call(runId, "stages/g2", input)); } catch (e) { return fail(e); } });
server.registerTool("get_project_run", {
  title: "Read a registered project run", description: "Reads project-scoped run binding, stage states and immutable artifact revisions from the same store as the Web UI.",
  inputSchema: { projectId: z.string(), runId: z.string() },
}, async ({ projectId, runId }) => { try { return ok(await runs.read(projectId, runId)); } catch (e) { return fail(e); } });
server.registerTool("read_run_artifact", {
  title: "Read a registered immutable artifact", description: "Reads a server-verified revision of this run, including upstream stories or cases needed when continuing at a checkpoint.",
  inputSchema: { runId: z.string(), revisionId: z.string() },
}, async ({ runId, revisionId }) => { try { return ok(await runs.artifact(runId, revisionId)); } catch (e) { return fail(e); } });
server.registerTool("execute_approved", {
  title: "Execute approved compiled cases", description: "Starts a project run from a server-verified g2 revision. Checks current human approvals, preserves the oracle and executor snapshot, and returns an execution ID. Reuse idempotencyKey only when retrying the same request.",
  inputSchema: { runId: z.string(), codeRevision: z.string(), idempotencyKey: z.string(), envRef: z.string().optional() },
}, async ({ runId, ...input }) => { try { return ok(await runs.call(runId, "stages/execute", input)); } catch (e) { return fail(e); } });
server.registerTool("begin_stage", {title:"Begin a workflow node", description:"Call BEFORE planning or executing each node: modules, instructions, stories, cases, gate, finalize. A paused/cancelled response means stop this turn immediately; do not plan, write or call later nodes. Only explicit user resume may continue the same run.", inputSchema:{runId:z.string(),node:z.enum(['source','modules','instructions','stories','cases','gate','finalize','g2','execution'])}}, async ({runId,node})=>{try{return ok(await runs.call(runId,'begin-stage',{node}));}catch(e){return fail(e);}});
/**
 * 模块规划节点（docs/v3/history/24 §6、§8）。
 *
 * 这里只有**提议**和**读状态**两个工具，没有冻结——冻结那一步必须是人，
 * 服务端的冻结路由带 Authorization 头就 403。模型提议完就停在这儿，这是设计，不是缺口。
 */
server.registerTool("plan_modules", {
  title: "Propose the product module tree",
  description: "Proposes this product's module tree before stories. The tree must have at least two levels: 3-7 top-level modules, each with child modules whose parentId points at it — a flat one-level list is reported as module_tree_is_a_list, and dropping the dots from the ids does not make a flat list a tree. Each module: stable dot-separated id, name, parentId (hierarchy goes in parentId, NOT in the name — an id with a dot and no parentId is refused), purpose stated as what it means to the user, and evidence citing material section ids (every module needs at least one). Every material section must be claimed by some module's evidence or declared in the top-level outOfScope:[{sectionId,reason}] (the key is sectionId, and it must be one of the material section ids) with a reason — 'I could not see it in the UI' is a coverage gap, not out of scope. Cut modules by what the user is trying to do, not by screen regions. Every leaf module is a commitment: in the next node you will write at least two user stories for it, so a tree with more leaves than you can fill is finer than the product itself — the server reports each empty leaf back to you there. A blocked result names the offending module. After a validated proposal STOP: a human must freeze the tree before stories can be split along it; you cannot freeze it yourself.",
  inputSchema: { runId: z.string(), content: z.unknown() },
}, async ({ runId, content }) => { try { return ok(await runs.call(runId, "stages/modules", { content })); } catch (e) { return fail(e); } });
server.registerTool("module_plan_state", {
  title: "Read the module plan and whether a human froze it",
  description: "Returns the current module proposal, its machine findings, and whether a human has frozen it. Stories units are split along the frozen tree; while a proposal exists unfrozen, claiming story units is refused.",
  inputSchema: { runId: z.string() },
}, async ({ runId }) => { try { return ok(await runs.call(runId, "stages/modules/state", {})); } catch (e) { return fail(e); } });
for (const [name, action, description] of [
  ["load_run_instructions", "instructions", "Loads the exact frozen-version planning skills and domain references for this registered run. Call before retrieving specifications or writing stages. Returns the server-delivered digest."],
  ["gate_run", "gate", "Runs the deterministic design gate on the validated case revision. Returns actionable findings. Agents cannot supply scores or thresholds."],
  ["finalize_run", "finalize", "Finalizes the registered generation run for human review only after validated stories, cases and a passing current gate. Rejects missing, stale or forged stages. Does not approve or execute cases."],
] as const) server.registerTool(name, { title: name, description, inputSchema: { runId: z.string() } },
  async ({ runId }) => { try { return ok(await runs.call(runId, `stages/${action}`, {})); } catch (e) { return fail(e); } });
/**
 * 单元循环（docs/v3/history/22）。
 *
 * 拆分与合并都在服务端：`claim_unit` 交出一个单元的范围、上下文清单和它自己的材料，
 * `write_unit` 只校验这个单元。整份 `write_stories` / `write_cases` 在开了单元的 run 上会被拒——
 * 边界靠服务端强制，不靠这段描述。
 */
server.registerTool("claim_unit", {
  title: "Claim the next work unit",
  description: "Returns ONE bounded unit of a node (a module subtree for stories, a single story for cases) with its scope, ContextManifest, and only the features, rules, observations and conflicts in that scope. Run-wide materials (domain reference, roles, action vocabulary, volatile readings, rule pack) are NOT repeated here — they come once from load_run_instructions as `runScope`. Reason about this unit alone, then call write_unit. A null unit means the node is finished and the server has merged it. The split is computed by the server from the product model; agents cannot widen it.",
  inputSchema: { runId: z.string(), node: z.enum(["stories", "cases"]) },
}, async ({ runId, ...body }) => { try { return ok(await runs.call(runId, "stages/units/claim", body)); } catch (e) { return fail(e); } });
server.registerTool("write_unit", {
  title: "Write one claimed work unit",
  description: "Writes the stories or cases of one claimed unit. Validated against that unit's scope only: ids must be unique across units, feature and rule references must be inside the unit, a rule with riskFloor P0 forces priority P0, and every story needs a role, a benefit and acceptance criteria. A blocked result names the exact jsonPointer and repairScope; fix that unit and call again. When the last unit of a node is written the server merges and validates the whole bundle.",
  inputSchema: { runId: z.string(), unitId: z.string(), content: z.unknown() },
}, async ({ runId, ...body }) => { try { return ok(await runs.call(runId, "stages/units/write", body)); } catch (e) { return fail(e); } });
server.registerTool("unit_status", {
  title: "Read work unit progress",
  description: "Lists this run's work units with their status, attempts and output revisions. Use it to resume after an interruption; counts are computed by the server.",
  inputSchema: { runId: z.string(), node: z.enum(["stories", "cases"]).optional() },
}, async ({ runId, ...body }) => { try { return ok(await runs.call(runId, "stages/units/status", body)); } catch (e) { return fail(e); } });
server.registerTool("merge_units", {
  title: "Merge the finished work units of a node",
  description: "Runs the server-side merge and the whole-bundle validation (provenance, frozen upstream) for a node whose units are all written. The merge also runs automatically when the last unit is written; call this to retry after fixing what the whole-bundle validation refused, without rewriting a unit.",
  inputSchema: { runId: z.string(), node: z.enum(["stories", "cases"]) },
}, async ({ runId, ...body }) => { try { return ok(await runs.call(runId, "stages/units/merge", body)); } catch (e) { return fail(e); } });
server.registerTool("import_run_artifact", {
  title: "Import an untrusted host artifact revision",
  description: "Imports existing output into a run registered in this MCP session. Identical retries retain one revision. Imported output is not a gate result or approval; stage validation and finalize are still required.",
  inputSchema: { runId: z.string(), name: z.string(), kind: z.enum(["spec", "stories", "cases", "code", "report"]), content: z.unknown(), parentRevision: z.string().nullable().optional(), sourceRefs: z.array(z.string()).optional() },
}, async ({ runId, ...body }) => { try { return ok(await runs.call(runId, "artifacts", body)); } catch (e) { return fail(e); } });

server.registerTool(
  "run_pipeline",
  {
    title: "Run the TestPilot generation pipeline",
    description:
      "Runs the whole TestPilot test-case generation pipeline in one deterministic pass: it reads the " +
      "specification documents in materialsDir, derives user stories, designs text test cases, scores them " +
      "against the test-design gate, and writes stories.json / cases.json / gate.json / meta.json / events.jsonl " +
      "into outDir. Use it whenever test cases have to be produced from documents; it is one indivisible step and " +
      "cannot be decomposed, reordered, or partially substituted — use stopAfter/from to run it in segments instead.",
    inputSchema: RunPipelineInput,
  },
  async (args, extra) => {
    if (runs.registered || process.env.TP_GENERATION_MODE === "skill") return held(new Held("binding", "Registered skill sessions use the host planner and stage tools; run_pipeline is available only in a separate explicit A comparison session."));
    // 进度令牌由客户端在请求 _meta 里给；没有就只往 stderr 记，不发通知。
    const token = (extra as { _meta?: { progressToken?: string | number } } | undefined)?._meta?.progressToken;
    const send = (extra as { sendNotification?: (n: unknown) => Promise<void> } | undefined)?.sendNotification;
    let seq = 0;
    const emit = (e: ProgressEvent) => {
      log(e);
      const message = progressMessage(e);
      if (token == null || !send || !message) return;
      // 每个节点起止各推一次；total 未知（stopAfter/from 会改步数），只报单调递增的 progress。
      void send({
        method: "notifications/progress",
        params: { progressToken: token, progress: ++seq, message },
      }).catch(() => {
        /* 客户端不收进度通知就算了，运行本身不受影响。 */
      });
    };
    try {
      return ok(await runPipeline({ ...args, emit }));
    } catch (e) {
      return fail(e);
    }
  },
);

/** 这个 MCP 进程里 `retrieve_spec` 返回过的段 id 与调用次数——`write_cases` 的出处基底。 */
const provenanceBasis = { retrievedIds: new Set<string>(), retrieveCalls: 0 };
const writeTool = (name: "stories" | "cases", args: { runId: string; runsDir?: string; content: unknown; materialsDir?: string }) =>
  runs.has(args.runId) ? runs.call(args.runId, `stages/${name}`, { content: args.content }) : writeArtifact(name, args, provenanceBasis);

server.registerTool(
  "write_stories",
  {
    title: "Write runs/<runId>/stories.json (validated)",
    description:
      "Writes the user stories of a run after validating their shape (StoryBundle). This is the only sanctioned way " +
      "to write stories.json: an invalid bundle is refused with the exact zod findings and recorded in holds.jsonl. " +
      "Fix the content and call again; do not write the file with a generic file tool.",
    inputSchema: WriteStoriesInput,
  },
  async (args) => {
    try {
      return ok(await writeTool("stories", args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "write_cases",
  {
    title: "Write runs/<runId>/cases.json (validated: shape + provenance)",
    description:
      "Writes the test cases of a run after validating their shape (CaseBundle) and their provenance: every case's " +
      "sourceRefs must be chunk ids that retrieve_spec returned in this session (fallback: ids present in the " +
      "materials index). Read first, then write — a call before any retrieve_spec is refused (gate grounding). " +
      "Refusals are recorded in holds.jsonl. This is the only sanctioned way to write cases.json.",
    inputSchema: WriteCasesInput,
  },
  async (args) => {
    try {
      return ok(await writeTool("cases", args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "retrieve_spec",
  {
    title: "Retrieve the relevant specification sections",
    description:
      "Returns the sections of the specification that are relevant to a query, within a token budget, together " +
      "with a hint naming what was left out and how to ask for it. Use it before writing anything that has to " +
      "agree with the specification — a user story, a test case, a review note — instead of pasting the whole " +
      "document or truncating it blindly.",
    inputSchema: { ...RetrieveSpecInput, materialsDir: RetrieveSpecInput.materialsDir.optional(), runId: z.string().optional().describe("Registered run; retrieves only its immutable material revisions. Required for skill-mode generation.") },
  },
  async (args) => {
    try {
      // 材料是第三方文本：模型读到的 `content` 包在 `<spec_material>` 里（过滤见 retrieve.ts），
      // 宿主读 `structuredContent`。两份是同一个结果，只是一份多了边界标记。
      if (!args.runId && !args.materialsDir) throw new Error("runId_or_materialsDir_required");
      const result = args.runId ? await runs.call(args.runId, "stages/retrieve", args) as unknown as ReturnType<typeof retrieveSpec>
        : retrieveSpec({ ...args, materialsDir: args.materialsDir! });
      // 出处的基底（T-09）：这个进程里真正返回过的段 id。`write_cases` 只认它们。
      provenanceBasis.retrieveCalls += 1;
      for (const c of result.chunks ?? []) if (typeof c?.id === "string") provenanceBasis.retrievedIds.add(c.id);
      return {
        content: [{ type: "text" as const, text: fencedRetrieveText(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "score_run",
  {
    title: "Score a run against a gold checklist",
    description:
      "Scores one finished run against a human-written gold checklist and returns a scoreboard entry: coverage, " +
      "held-out coverage, the per-item coverage matrix, and the run's complete provenance binding. Use it to answer " +
      "'did this run find the things a person said mattered'; it refuses to score a run whose meta.json is missing " +
      "any of skillVersion, promptsDigest, model or materialsHash, and it never falls back to a different checklist.",
    inputSchema: ScoreRunInput,
  },
  async (args) => {
    try {
      return ok(await scoreRun(args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "paired_eval",
  {
    title: "Compare two runs on the same checklist",
    description:
      "Compares two runs item by item against the same gold checklist and returns a scoreboard entry carrying " +
      "McNemar's exact test plus the list of which checklist items flipped and in which direction. Use it to decide " +
      "whether one version is actually better than another; it refuses when the two runs were last scored against " +
      "different checklists, because those are different lineages and their numbers do not subtract.",
    inputSchema: PairedEvalInput,
  },
  async (args) => {
    try {
      return ok(await pairedEval(args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "mutate_and_detect",
  {
    title: "Measure how much of a real fault the suite catches",
    description:
      "Injects known faults into a running system under test, executes the run's cases against the healthy and the " +
      "faulty builds, and reports the false-alarm rate, the mutation score, and which way the suite leans. Use it to " +
      "answer 'would this suite notice if the product broke'; it needs a reachable target that supports ?defect=, and " +
      "faults that could not actually be injected are excluded from the denominator rather than counted as survivors.",
    inputSchema: MutateAndDetectInput,
  },
  async (args) => {
    try {
      return ok(await mutateAndDetect(args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "drive_sut",
  {
    title: "Execute one test case against the system under test",
    description:
      "Executes a single case from a run against a live target and returns what happened: pass or fail, the step " +
      "log, the screenshots, the oracle results, and whether the failure was the product's or the infrastructure's. " +
      "Use it to check one specific case against the real product, passing projectId so the session, viewport and " +
      "headers come from that project's environment record rather than being guessed; pass dryRun to see the resolved " +
      "plan without touching the product. It has no write access to the benchmark directory and cannot alter scoring.",
    inputSchema: DriveSutInput,
  },
  async (args) => {
    try {
      return ok(await driveSut(args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "run_case",
  {
    title: "Run one test case of a project against its environment (verdict + cost)",
    description:
      "Runs one case of a TestPilot project through the gateway and returns the verdict: passed / failed / " +
      "unobservable, the machine oracle results (each with who decided it — never the model), the failure kind " +
      "(infra / locate / assert) and the spend (model calls, tokens, cache hits). Screenshots are not returned; the " +
      "report path is. Use it after changing the product to check one behaviour; use run_p0 for the whole suite.",
    inputSchema: RunCaseInput,
  },
  async (args) => {
    try {
      return ok(await runCase(args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "run_p0",
  {
    title: "Run a project's P0 suite (verdicts + cost, no model judgement)",
    description:
      "Runs every P0 case of a TestPilot project (batch-level browser reuse, per-case reset, cached replay) and " +
      "returns the gate (pass/fail), per-case verdicts with their machine oracle results and failure kinds, and the " +
      "summed spend. Verdicts come from machine oracles at execution time — the model is never asked whether a case " +
      "passed. Unobservable is reported separately from failed. Logs are clipped to 2KB per case; screenshots stay " +
      "on disk (reportPath).",
    inputSchema: RunP0Input,
  },
  async (args) => {
    try {
      return ok(await runP0(args));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "extract_episodes",
  {
    title: "Compute episodic memory candidates from a run's artifacts",
    description:
      "Reads gate.json, holds.jsonl and the scan report of one finished run and returns candidate episodic memories — " +
      "one line per thing that actually went wrong (a gate rule that fired, a hook that blocked a write, a scanner finding), " +
      "each already validated against the memory shape and the write filter that refuses credentials and identifiers. Use it " +
      "at the end of a run before writing agent_state/memory/testpilot-episodes.md: pick from the candidates, do not compose " +
      "your own, and do not save general rules about how to write test cases — only what this run hit.",
    inputSchema: ExtractEpisodesInput,
  },
  async ({ runId, runsDir, scanPath }) => {
    try {
      const dir = resolveRunDir(runId, runsDir ?? DEFAULT_RUNS_DIR);
      const out = extractEpisodes({ runId, runDir: dir, scanPath });
      return ok({
        runId,
        runTag: out.runTag,
        candidates: out.candidates,
        lines: out.candidates.map(formatEpisode),
        skipped: out.skipped,
        cap: TIER_ONE_CAP,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "read_decisions",
  {
    title: "Read the review decisions for a run",
    description:
      "Returns the human review decisions recorded for a run — which cases were approved, rejected or revised, by " +
      "whom, and why. Use it at the start of a follow-up session to find out what a person already decided; a run " +
      "nobody has reviewed yet returns an empty list, which is a normal state and not an error.",
    inputSchema: ReadDecisionsInput,
  },
  async ({ runId, runsDir }) => {
    try {
      if (runs.has(runId)) {
        const result = await runs.call(runId, "stages/decisions", {});
        return ok({ runId, ...result });
      }
      const dir = resolveRunDir(runId, runsDir ?? DEFAULT_RUNS_DIR);
      const decisions = readDecisions(dir);
      return ok({ runId, decisions, count: decisions.length });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "calibrate_judge",
  {
    title: "Measure the model judge against human labels",
    description:
      "Judges each human-labelled item several times and reports Cohen's kappa between the judge's majority vote " +
      "and the human labels, plus the share of items the judge did not answer the same way twice. Use it before " +
      "trusting any model-assisted coverage number; it costs one model call per item per repeat, so it is run " +
      "deliberately rather than on every scoring.",
    inputSchema: CalibrateJudgeInput,
  },
  async (args) => {
    try {
      return ok(await calibrateJudge(args));
    } catch (e) {
      return fail(e);
    }
  },
);

const TOOLS = [
  "run_pipeline",
  "extract_episodes",
  "retrieve_spec",
  "score_run",
  "paired_eval",
  "mutate_and_detect",
  "drive_sut",
  "run_case",
  "run_p0",
  "write_stories",
  "write_cases",
  "read_decisions",
  "calibrate_judge",
];

await server.connect(new StdioServerTransport());
process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), kind: "server.ready", tools: TOOLS }) + "\n");
