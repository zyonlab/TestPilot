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
} from "./contracts.js";
import { runPipeline, type ProgressEvent } from "./pipeline.js";
import { fencedRetrieveText, retrieveSpec } from "./retrieve.js";
import { TIER_ONE_CAP, extractEpisodes, formatEpisode } from "./memory.js";
import { pairedEval, scoreRun } from "./score.js";
import { driveSut, mutateAndDetect } from "./exec.js";
import { calibrateJudge } from "./calibrate.js";
import { DEFAULT_RUNS_DIR, readDecisions, resolveRunDir } from "./runs.js";

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

server.registerTool(
  "retrieve_spec",
  {
    title: "Retrieve the relevant specification sections",
    description:
      "Returns the sections of the specification that are relevant to a query, within a token budget, together " +
      "with a hint naming what was left out and how to ask for it. Use it before writing anything that has to " +
      "agree with the specification — a user story, a test case, a review note — instead of pasting the whole " +
      "document or truncating it blindly.",
    inputSchema: RetrieveSpecInput,
  },
  async (args) => {
    try {
      // 材料是第三方文本：模型读到的 `content` 包在 `<spec_material>` 里（过滤见 retrieve.ts），
      // 宿主读 `structuredContent`。两份是同一个结果，只是一份多了边界标记。
      const result = retrieveSpec(args);
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
  "read_decisions",
  "calibrate_judge",
];

await server.connect(new StdioServerTransport());
process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), kind: "server.ready", tools: TOOLS }) + "\n");
