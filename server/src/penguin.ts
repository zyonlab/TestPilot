/**
 * PenguinHarness 适配层——领域服务与 harness 之间的**唯一**接缝。
 *
 * v3 把 TestPilot 切两半（`docs/v3/00-架构.md` §2）：产品层留下，harness 层换成 Penguin。
 * 这个文件就是那条切口：往上它只暴露四个函数，往下它只知道「起一个 session」「读它落盘的
 * 产物」。领域服务里任何一处都不该再出现 `penguin` 这个词。
 *
 * ## 为什么是 shell-out 而不是 SDK
 *
 * `@prismshadow/penguin-core@0.2.9` 的 `engines.node` 是 `>=24`，且是纯 ESM；
 * `testpilot-server` 跑在 Node **22.17.0** 上（`server/package.json` 的 `@types/node: ^22`，
 * dev 进程实测 v22.17.0）。把整个网关抬到 Node 24 是 Phase 1C 之外的一次风险迁移——
 * 而 `:5301` 上正跑着 Phase 2 已完成的前端所依赖的这份 server。
 *
 * 所以走 CLI：`penguin run`，用 nvm 的 Node 24 绝对路径（不 source nvm——一个
 * express 进程里 source 一个 shell 函数是没有意义的）。**这正是 Phase 0 跑通那次用的路径**，
 * 也就是说这条路已经被验过一次了，而 SDK 那条没有。
 *
 * 代价记在这里，Phase 3 再收：CLI 的 `--json` 不是事件流，它只在**结束时**打一行
 * `{sessionId,status,text}`；不带 `--json` 则是 ANSI 渲染的人类输出。所以节点级进度不从
 * 子进程的 stdout 来，而是从**运行目录**来（契约 §1：`run_pipeline` 同时写 `events.jsonl`）。
 * 这反而更稳：产物落盘是事实，子进程的输出是转述。
 *
 * （还有第三条路：CLI 自己只是 `:7364` 的 HTTP 客户端，直接打那套 API + SSE 就能在 Node 22
 * 上拿到逐条 `OmniMessage`。没走，因为那套 API 没有公开契约，而这一层要在 Phase 3 之前
 * 保持能被一眼读懂。写在这里，是为了下一个人不必重新调研一遍。）
 */
import { generationMessage, prepareSkillLaunch, type GenerationMessageInput } from "./runtime/skill-launch.js";
import type { RunBudget } from "./runBudget.js";
import { registeredStageProducts } from "./runStages.js";
import { launchNativePenguin, nativeRunState, cancelNativeRun } from "./runtime/native-penguin.js";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { RunModels } from "@testpilot/harness-core/model-profiles";
import { launchManagedPenguin, managedRunState, cancelManagedRun, type ManagedModels } from "./runtime/managed-penguin.js";
export { cancelManagedRun } from "./runtime/managed-penguin.js";
import { bus } from "./procs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 仓库根：`server/src/penguin.ts` → `server/` → 仓库根。 */
export const REPO_ROOT = resolve(__dirname, "..", "..");

/* ── 契约类型（`docs/v3/01-数据契约.md`，一个字段都不改名） ───────────────── */

/** §1 `RunMeta` —— P3 来源印记的载体。 */
export interface RunMeta {
  runId: string;
  stage: "g1" | "g2";
  /** 哪个运行时跑的（07 P2）。缺省 = 旧条目。 */
  runtime?: "penguin" | "claude-code" | "codex" | "pipeline";
  skillVersion?: string;
  promptsDigest?: { entries: Record<string, string>; combined: string };
  params?: Record<string, unknown>;
  ablated?: string[];
  model?: { baseUrl: string; model: string; thinking: boolean | null };
  modelRoles?: RunModels;
  materialsHash?: string;
  startedAt?: string;
  finishedAt?: string;
  spend?: { calls: number; tokens: number; ms: number };
}

/** §1 `NodeEvent` —— 画布与断点续跑靠它（US-14 / US-16.4 的补回点）。 */
export interface NodeEvent {
  runId: string;
  node: string;
  phase: "start" | "end" | "error";
  at: string;
  ms?: number;
  calls?: number;
  tokens?: number;
  error?: string;
  /** end 时：这个节点写了哪个文件，供 `{ from: node }` 续跑读取。 */
  wrote?: string;
}

/** §1 `Decision` —— 审计台写回，下一 session 的 `read_decisions` 读它。 */
export interface Decision {
  caseId: string;
  decision: "approved" | "rejected" | "revised";
  by: string;
  at: string;
  edit?: { title?: string; steps?: string[]; expected?: string };
  reason?: string;
  /** 只有一个值：批准永远是人。类型上没有 agent。 */
  decidedByKind?: "human";
}

/**
 * 一次运行的产物，**拼成 `review.ts` 里 `gated` 那个变量的形状**。
 *
 * 不是新形状：`GatedBundleSchema`（`harness-testing/casegen/types.ts`）就是它。
 * 复核那条路一行不改，靠的就是这里拼对。
 */
export interface RunProducts {
  meta?: RunMeta;
  /** `{ stories, cases, gate }`——`reviewBatch` 读的正是这三样。 */
  bundle: { stories: unknown[]; cases: unknown[]; gate?: unknown };
  spend?: { calls?: number; tokens?: number; ms?: number };
  /** 这次运行的目录（绝对路径）。 */
  dir: string;
}

/* ── 环境与路径 ───────────────────────────────────────────────────────── */

/**
 * Node 24 的绝对路径。
 *
 * 不 source nvm：`. nvm.sh` 定义的是一个 shell 函数，在 `spawn` 出来的非交互子进程里
 * 要么不存在要么慢得离谱。目录扫描 + 取最高版本，扫不到再退到写死的那个——
 * 后者是 Phase 0 手写进 `system_config.yaml` 的同一条路径，两处必须一致，
 * 否则 MCP 会以「工具凭空消失」的方式失败（架构 §9：非法条目只 warn+skip）。
 */
export function node24Path(): string {
  const fromEnv = process.env.TP_PENGUIN_NODE;
  if (fromEnv) return fromEnv;
  const root = join(homedir(), ".nvm", "versions", "node");
  try {
    const v = readdirSync(root)
      .filter((d) => /^v(2[4-9]|[3-9]\d)\./.test(d))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
    if (v) {
      const p = join(root, v, "bin", "node");
      if (existsSync(p)) return p;
    }
  } catch {
    /* 没装 nvm 就走下面那条 */
  }
  if (Number(process.versions.node.split(".")[0]) >= 24) return process.execPath;
  try {
    const binary = execFileSync("node", ["-p", "Number(process.versions.node.split('.')[0]) >= 24 ? process.execPath : ''"], { encoding: "utf8", timeout: 5000 }).trim();
    if (binary) return binary;
  } catch { /* Actionable configuration error below. */ }
  throw new Error("penguin_node_24_required: set TP_PENGUIN_NODE to a Node 24+ executable");
}

/** `penguin` 可执行文件。与 Node 24 同一个 `bin/`。 */
export function penguinBin(): string {
  if (process.env.TP_PENGUIN_BIN) return process.env.TP_PENGUIN_BIN;
  return join(dirname(node24Path()), "penguin");
}

/**
 * 起 penguin 子进程时的环境。
 *
 * **PATH 必须把 Node 24 排在前面。** `penguin` 的 shebang 是 `#!/usr/bin/env node`，
 * 而网关自己跑在 Node 22 上——直接 spawn 它，要么 `env: node: No such file or directory`，
 * 要么用 Node 22 跑一个 `engines: >=24` 的包。
 *
 * 这一条踩过一次，症状极具误导性：`startRun` 里设了 PATH 所以起跑正常，
 * 而查状态的 `penguin ls` 没设，于是**每一次状态查询都静默失败**、被当成"查不出来"，
 * 一次早就停掉的 session 会被一直当成还在跑。看门狗因此永远不收尾。
 */
export const penguinEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: `${dirname(node24Path())}:${process.env.PATH ?? ""}`,
});

/** Penguin 的数据根（`PENGUIN_HOME`，默认 `~/.penguin/data`）。 */
export const penguinHome = (): string =>
  process.env.PENGUIN_HOME ?? join(homedir(), ".penguin", "data");

export const PROJECT_ID = process.env.TP_PENGUIN_PROJECT ?? "default_project";
export const AGENT_ID = process.env.TP_PENGUIN_AGENT ?? "testpilot";

export const agentStateDir = (projectId = PROJECT_ID, agentId = AGENT_ID): string =>
  join(penguinHome(), projectId, "agents", agentId, "agent_state");

export const workspacesDir = (projectId = PROJECT_ID, agentId = AGENT_ID): string =>
  join(penguinHome(), projectId, "agents", agentId, "workspaces");

/** 默认工作区。Phase 0 那个仍然在，材料也在里面。 */
export const defaultWorkspace = (): string =>
  process.env.TP_PENGUIN_WORKSPACE ?? join(workspacesDir(), "phase0");

/* ── ① writeAgentConfig ───────────────────────────────────────────────── */

/**
 * MCP 子进程要拿到的 env。**逐条列**——vault 不注入 MCP 子进程（架构 §9），
 * 漏一条的表现不是报错，是那个工具在模型的工具表里凭空消失。
 *
 * 视口那两条是为 `demo.binance.com` 加的：那个 SUT 在窄视口下整块行情区不渲染，
 * 探索因此探不到任何控件，而这在日志里长得像"页面是空的"。1600×1000 是实测能出全的最小档。
 * 它们不是密钥，所以直接写进 YAML 没有代价。
 */
const MCP_ENV_KEYS = [
  "OPENAI_BASE_URL",
  "MIDSCENE_MODEL_NAME",
  "TP_MODEL_THINK",
  "TP_MODEL_TIMEOUT_MS",
  "MIDSCENE_SHOT_WIDTH",
  "MIDSCENE_SHOT_HEIGHT",
  "TP_SUT_PROFILE",
  "TP_JUDGE_MODEL",
] as const;

const MCP_ENV_DEFAULTS: Record<string, string> = {
  TP_MODEL_THINK: "0",
  TP_MODEL_TIMEOUT_MS: "900000",
  MIDSCENE_SHOT_WIDTH: "1600",
  MIDSCENE_SHOT_HEIGHT: "1000",
};

/**
 * 读 `server/.env`，只取要往 MCP 子进程里塞的那几个键。
 *
 * 直接读文件而不是靠 `process.env`：`dotenv/config` 的加载顺序取决于谁先被 import，
 * 而这个函数可能在任何时候被调用。回落到 `process.env` 是为了容器里没有 `.env` 的情形。
 */
function readServerEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = join(REPO_ROOT, "server", ".env");
  if (existsSync(file)) {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      if (v) out[k] = v;
    }
  }
  const picked: Record<string, string> = {};
  for (const k of MCP_ENV_KEYS) {
    const v = out[k] ?? process.env[k] ?? MCP_ENV_DEFAULTS[k];
    if (v !== undefined && v !== "") picked[k] = String(v);
  }
  if (existsSync(file)) picked.TP_MODEL_ENV_FILE = file;
  return picked;
}

/**
 * YAML 标量：能裸写就裸写。
 *
 * 不是洁癖——**是为了幂等**。现有那份 `system_config.yaml` 是 Phase 0 手写的，URL 与 key
 * 裸写、`"0"` 与 `"900000"` 带引号。如果这里一律加引号，第一次调用就会重写那个文件，
 * 而那个 agent 此刻正被 1A 用来测工具。渲染成和它逐字节相同，这次调用就什么都不做。
 */
function yamlScalar(v: string): string {
  const plain = /^[A-Za-z0-9_][A-Za-z0-9_\-./:@+~]*$/.test(v);
  const numeric = /^-?\d+(\.\d+)?$/.test(v) || /^(true|false|null|yes|no|on|off)$/i.test(v);
  if (plain && !numeric) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * `tools.mcpServers` 那一节的正文。
 *
 * `timeoutMs` 是**单次调用**超时（架构 §9），一次 g1 实测 19 分钟，所以 3600000 是下限
 * 而不是余量。`connectTimeoutMs` 是握手，60 秒。`permission: rw` 因为 `run_pipeline` 要写盘。
 */
function renderMcpServers(env: Record<string, string>, extraKeys: string[] = []): string {
  const lines = [
    "  mcpServers:",
    "    - name: testpilot",
    "      config:",
    "        transport: stdio",
    `        command: ${node24Path()}`,
    "        args:",
    `          - ${join(REPO_ROOT, "packages", "testpilot-mcp", "bin", "testpilot-mcp.mjs")}`,
    `        cwd: ${join(REPO_ROOT, "packages", "testpilot-mcp")}`,
    "        env:",
    ...[...MCP_ENV_KEYS, ...extraKeys.filter((k) => !(MCP_ENV_KEYS as readonly string[]).includes(k))]
      .filter((k) => env[k] !== undefined && env[k] !== "")
      .map((k) => `          ${k}: ${yamlScalar(env[k])}`),
    "        connectTimeoutMs: 60000",
    "        timeoutMs: 3600000",
    "        permission: rw",
  ];
  return lines.join("\n") + "\n";
}

/**
 * 生成（或就地替换）agent 的 MCP 声明。
 *
 * **文本切片，不做 YAML 往返。** 那份文件里有十来个 `>-` 折叠块（system_prompt 一个人就
 * 180 行），任何 YAML 库重新序列化都会把折行位置全部改掉——一次 diff 上千行的「无变更」
 * 提交，而其中真正变了的那 17 行没人看得见。切片只动 `  mcpServers:` 到下一个缩进更浅的
 * 行之间，其余逐字节原样。
 *
 * @returns 实际写了没有，以及文件路径。
 */
export function writeAgentConfig(
  projectId = PROJECT_ID,
  agentId = AGENT_ID,
  /**
   * 这一次运行才有的 env（`TP_SERVER_URL` / `TP_ENV_ID` / `TP_PROJECT_ID`）。
   *
   * **会话不走这里。** 登录态是一个有有效期的活凭证，而这份 YAML 是明文、会被反复重写的
   * 配置文件；把 cookie 烤进去，过期之后的表现是「SUT 把我登出了」而不是「你的会话过期了」，
   * 而这两句话指向完全不同的排查方向。何况业务规则 5 是「密钥只出不进：可写入、可引用、
   * 永不回显」——写进配置文件就是回显。
   *
   * 所以这里只给**引用**：工具拿着 `TP_ENV_ID` 在真要开浏览器的那一刻回 `:5301` 取，
   * 取到的永远是当下那一份。那个取会话的内部端点属于 1A 的 `drive_sut` 契约，不在这一路里建。
   */
  extraEnv: Record<string, string> = {},
): { path: string; written: boolean; reason: string } {
  const path = join(agentStateDir(projectId, agentId), "system_config.yaml");
  if (!existsSync(path))
    return { path, written: false, reason: `没有这份配置（agent ${agentId} 还没建）` };

  const original = readFileSync(path, "utf8");
  // 工具那头的 `DEFAULT_RUNS_DIR` 读它：MCP 子进程的 cwd 是包目录，不是工作区，
  // 不给这一条，skill 里不带 `runsDir` 的 `score_run` 会在 `packages/testpilot-mcp/runs` 底下找。
  // `TP_RUNTIME`：MCP 把它写进 `meta.runtime`（07 T-22 的 binding 字段）。Claude Code 那条路由 `.mcp.json` 给；
  // 这里不给，Penguin 上跑出来的分就缺一项 binding——2026-09-08 第一遍三运行时对比就是这么缺的。
  const runsEnv = { TP_RUNS_DIR: join(defaultWorkspace(), "runs"), TP_RUNTIME: "penguin" };
  const block = renderMcpServers({ ...readServerEnv(), ...runsEnv, ...extraEnv }, [
    ...Object.keys(runsEnv),
    ...Object.keys(extraEnv),
  ]);
  const lines = original.split("\n");

  // `  mcpServers:` 只在 `tools:` 底下出现，缩进恰好两格。
  const start = lines.findIndex((l) => /^ {2}mcpServers:\s*$/.test(l));
  let next: string;
  if (start === -1) {
    // 还没有这一节：插在 `tools:` 那一段的末尾（下一个顶层键之前）。
    const tools = lines.findIndex((l) => /^tools:\s*$/.test(l));
    if (tools === -1)
      return { path, written: false, reason: "这份配置里没有 tools: 节，不敢乱插" };
    let end = tools + 1;
    while (end < lines.length && (lines[end] === "" || /^\s/.test(lines[end]))) end++;
    next = [...lines.slice(0, end), ...block.split("\n").slice(0, -1), ...lines.slice(end)].join("\n");
  } else {
    let end = start + 1;
    // 这一节到「下一行的缩进 < 2 且非空」为止——`name:` / `description:` 就在后面。
    while (end < lines.length && (lines[end] === "" || /^ {2,}/.test(lines[end]))) end++;
    next = [...lines.slice(0, start), ...block.split("\n").slice(0, -1), ...lines.slice(end)].join("\n");
  }

  if (next === original) return { path, written: false, reason: "内容没变" };
  writeFileSync(path, next);
  return { path, written: true, reason: "mcpServers 已更新" };
}

/* ── ② startRun ──────────────────────────────────────────────────────── */

/** 一次运行的目录名。用 UTC 秒级时间戳，和 Phase 0 的 skill 约定同一形状。 */
export const newRunId = (): string =>
  new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");

export interface StartRunInput {
  generationMode?: "skill" | "pipeline";
  /** Web-managed run only. Native host runs inherit their own planning model. */
  models?: ManagedModels;
  projectId?: string;
  agentId?: string;
  /** 工作区。不给就用默认那个（`workspaces/phase0`）。 */
  workspace?: string;
  /** 材料目录。不给就是 `<workspace>/materials`。 */
  materialsDir?: string;
  /** 直接给 agent 的话。不给就按 `limit` 拼一句。 */
  message?: string;
  /** 最多几条故事。测试用 2。 */
  limit?: number;
  /** 消融开关（07 T-12）：不写进起跑那句话，工具就不知道要关什么——两臂会一模一样。 */
  ablate?: string[];
  /**
   * 这次运行的预算。不给就由 managed worker 退回 `configuredRunBudget()`。
   *
   * 单元循环必须显式给：默认那份是给「一次写整份」定的 10 分钟，
   * 2026-09-11 实测把一个跑得好好的 27 单元运行在第 10 个单元上掐断（docs/v3/22）。
   */
  budget?: RunBudget;
  /** 运行 id（同时是产物目录名）。不给就现生成一个。 */
  runId?: string;
  /** 事件与运行记录归到哪个项目下。同时作为 `TP_PROJECT_ID` 传给 MCP 子进程。 */
  scopeProjectId?: string;
  /** 打哪个环境。只传**引用**给 MCP，不传会话本身——见 `writeAgentConfig` 的 `extraEnv`。 */
  envRef?: string;
}

export interface StartedRun {
  sessionId: string;
  workspace: string;
  runId: string;
  outDir: string;
}

/** 起跑那句话。**把 outDir 说死**，否则运行 id 由模型现编，事后对不上号。 */
function runMessage(input: GenerationMessageInput): string { return generationMessage(input); }

/** 后台跑着的那些。取消与状态查询用得上。 */
const running = new Map<
  string,
  { sessionId: string; workspace: string; outDir: string; timer?: NodeJS.Timeout }
>();

/**
 * 起一个 Penguin session，立刻返回。
 *
 * `--background` 让 CLI 把任务投出去就退出，并在 stdout 打一行 `{"sessionId":"…"}`——
 * 这是**唯一**能在开跑那一刻就拿到 session id 的方式，而审计台的「看 trace →」深链要它。
 * 跑完与否由 `watchRun` 从产物目录看，不由这个子进程看。
 */
export async function startRun(input: StartRunInput = {}): Promise<StartedRun> {
  const projectId = input.projectId ?? PROJECT_ID;
  const agentId = input.agentId ?? AGENT_ID;
  const workspace = input.workspace ?? defaultWorkspace();
  const materialsDir = input.materialsDir ?? join(workspace, "materials");
  const runId = input.runId ?? newRunId();
  const outDir = join(workspace, "runs", runId);

  // `--workspace` 必须已经存在——CLI 不建目录。产物目录也一样：
  // 让 agent 去 mkdir 是把一件确定的事交给一个不确定的东西。
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const stageEnv = input.generationMode === "pipeline" ? { TP_GENERATION_MODE: "pipeline" } : prepareSkillLaunch({ runId, scopeProjectId: input.scopeProjectId, materialsDir, runtime: "penguin", limit: input.limit, ablate: input.ablate });

  if (input.models) {
    const { sessionId } = await launchManagedPenguin({
      runId, projectId, agentId, root: penguinHome(), workspace, outDir,
      message: input.message ?? runMessage({ materialsDir, outDir, limit: input.limit, ablate: input.ablate, generationMode: input.generationMode }),
      nodeBin: node24Path(), penguinBin: penguinBin(), models: input.models,
      ...(input.budget ? { budget: input.budget } : {}),
      mcpEnv: { ...stageEnv, TP_REPO_ROOT: REPO_ROOT, TP_RUNS_DIR: join(workspace, "runs"), TP_RUNTIME: "penguin",
        TP_SERVER_URL: process.env.TP_SERVER_URL ?? `http://127.0.0.1:${process.env.PORT ?? 5301}`,
        ...(input.scopeProjectId ? { TP_PROJECT_ID: input.scopeProjectId } : {}),
        ...(input.envRef ? { TP_ENV_ID: input.envRef } : {}),
        TP_ABLATE: input.ablate?.join(",") ?? "",
      },
    });
    running.set(runId, { sessionId, workspace, outDir });
    return { sessionId, workspace, runId, outDir };
  }
  if (input.generationMode !== "pipeline") {
    const { sessionId } = await launchNativePenguin({ runId, projectId, agentId, root: penguinHome(), workspace, outDir, repoRoot: REPO_ROOT,
      nodeBin: node24Path(), penguinBin: penguinBin(), message: input.message ?? runMessage({ materialsDir, outDir, limit: input.limit }),
      mcpEnv: { ...stageEnv, TP_REPO_ROOT: REPO_ROOT, TP_RUNTIME: "penguin", TP_RUNS_DIR: join(workspace, "runs"),
        TP_SERVER_URL: process.env.TP_SERVER_URL ?? `http://127.0.0.1:${process.env.PORT ?? 5301}`,
        ...(input.scopeProjectId ? { TP_PROJECT_ID: input.scopeProjectId } : {}), ...(input.envRef ? { TP_ENV_ID: input.envRef } : {}),
        ...(existsSync(join(REPO_ROOT, "server/.env")) ? { TP_MODEL_ENV_FILE: join(REPO_ROOT, "server/.env") } : {}) },
    });
    running.set(runId, { sessionId, workspace, outDir });
    return { sessionId, workspace, runId, outDir };
  }

  // 每次起跑前对一次 MCP 声明。内容没变就不写（见 `writeAgentConfig`）——
  // 「工具凭空消失」是这一层最难查的一类故障，代价是一次 stat + 一次字符串比较。
  writeAgentConfig(projectId, agentId, {
    ...stageEnv,
    // 工具要开浏览器时，拿这三样回 `:5301` 取当下那一份环境（baseUrl / 视口 / 会话）。
    TP_SERVER_URL: process.env.TP_SERVER_URL ?? `http://127.0.0.1:${process.env.PORT ?? 5301}`,
    ...(input.scopeProjectId ? { TP_PROJECT_ID: input.scopeProjectId } : {}),
    ...(input.envRef ? { TP_ENV_ID: input.envRef } : {}),
    // 消融开关走 env 兜底（`pipeline.ts::ablateFromEnv`）；`renderMcpServers` 会滤掉空值，没有消融臂时这个键不出现。
    ...(input.ablate?.length ? { TP_ABLATE: input.ablate.join(",") } : {}),
  });

  const message = input.message ?? runMessage({ materialsDir, outDir, limit: input.limit, ablate: input.ablate, generationMode: input.generationMode });
  const args = [
    "run",
    "--background",
    "--json",
    "--project-id",
    projectId,
    "--agent-id",
    agentId,
    "--workspace",
    workspace,
    "--approve",
    "allow-all",
    "-m",
    message,
  ];

  const sessionId = await new Promise<string>((ok, fail) => {
    const child = spawn(penguinBin(), args, {
      cwd: workspace,
      env: penguinEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => fail(new Error(`起不了 penguin：${e.message}`)));
    child.on("close", (code) => {
      const id = out.match(/"sessionId"\s*:\s*"([^"]+)"/)?.[1] ?? out.match(/session-[\w-]+/)?.[0];
      if (id) return ok(id);
      fail(new Error(`penguin run 退出码 ${code}，没拿到 sessionId：${(err || out).slice(0, 400)}`));
    });
  });

  running.set(runId, { sessionId, workspace, outDir });
  return { sessionId, workspace, runId, outDir };
}

/** 这次运行还在不在跑。 */
export const isRunning = (runId: string): boolean => running.has(runId);

/** 停掉后台看门狗（进程退出前调用，测试里也用）。 */
export function stopWatching(runId?: string): void {
  for (const [id, r] of running) {
    if (runId && id !== runId) continue;
    if (r.timer) clearInterval(r.timer);
    running.delete(id);
  }
}

/* ── 事件桥：产物目录 → 事件总线 ──────────────────────────────────────── */

/**
 * `NodeEvent` 上总线。
 *
 * kind 用 `wf.node`（契约 §1），scope 里带上 `wfRunId` 与 `nodeRunId`——WS 那头按 scope 分流，
 * 少一个字段，一个前端订阅者就要自己从 payload 里翻。
 */
export function publishNodeEvent(e: NodeEvent, wfRunId: string, projectId?: string): void {
  /*
   * scope 用**网关这边的** wfRunId，不用 `e.runId`。
   *
   * 两者不是一回事，实测过：目录（也就是网关发出去的运行 id）是 `20260903T023940`，
   * 而 `run_pipeline` 在 `meta.json` 里给自己起的 `runId` 是 `run-mtkx3hfb`（契约 §1 的
   * 「"run-" + 时间戳36进制」）。照 `e.runId` 发，WS 那头按 `scope.wfRunId` 过滤的订阅者
   * 一条都收不到——**画布全灰，而事件确实在总线上**，是这一层最难查的一类症状。
   *
   * payload 里那个 `runId` 保持原样：它是契约 §1 的字段，`score_run` 拿它去对 `meta.json`。
   */
  bus.publish("wf.node", e, {
    wfRunId,
    nodeRunId: `${wfRunId}:${e.node}`,
    ...(projectId ? { projectId } : {}),
  });
}

/** 节点 → 它写的那个文件。`events.jsonl` 还没落地时，靠文件出现反推进度。 */
const NODE_BY_FILE: Array<{ file: string; node: string }> = [
  { file: "stories.json", node: "stories" },
  { file: "cases.json", node: "design" },
  { file: "gate.json", node: "gate" },
];

/**
 * 跟着一次运行，把它的进度转成总线事件，跑完把产物交给 `onDone`。
 *
 * 三个来源，按可信度排：
 *   ① `runs/<id>/events.jsonl`——契约 §1 说的那份，`run_pipeline` 每个节点各一行。有就用它。
 *   ② 产物文件出现——`events.jsonl` 还没被 1A 落地之前的下位替代，粒度粗（三个节点）但不说谎。
 *   ③ `penguin ls --json` 里那个 session 的状态——判「跑完了」和「挂了」。
 *
 * 不做的：解析子进程 stdout。`--json` 只在结束时打一行，不带 `--json` 是 ANSI 渲染，
 * 两者都不是事件流。**产物落盘是事实，子进程的输出是转述**，这一层只信事实。
 */
export function watchRun(opts: {
  runId: string;
  sessionId: string;
  workspace: string;
  outDir: string;
  projectId?: string;
  scopeProjectId?: string;
  agentId?: string;
  /** 多久算超时。默认 60 分钟——一次 g1 实测 19 分钟，g2 更长。 */
  timeoutMs?: number;
  pollMs?: number;
  /**
   * 重新接上一次已经在跑的运行时传 `false`：跳过 `events.jsonl` 里已有的那些。
   *
   * 不跳的话，网关一重启就把这次运行从头到现在的节点事件**再发一遍**——而它们早已
   * 在 `events.db` 里，重连的客户端本来就会重放。两份叠起来，界面上一个节点会开始两次。
   */
  replay?: boolean;
  /**
   * 事件往哪儿发。不给就直接上总线（`publishNodeEvent`）。
   *
   * `penguinRun` 会给一个——它要在同一件事上**再发一份旧 kind**（`wf.node.started` /
   * `wf.node.finished`），因为画布今天认的是那两个。适配层不该知道画布的存在，所以
   * 那份翻译留在接线层，这里只留一个口子。
   */
  onEvent?: (e: NodeEvent) => void;
  onDone: (r: { status: "done" | "failed"; error?: string; products?: RunProducts }) => void;
  /**
   * 这个运行时怎么回答「session 还在跑吗」。不给就问 `penguin ls`。
   * 第二个运行时（`claudecode.ts`）的 session 是我们自己 spawn 的子进程，活着就是 running——
   * 看门狗的其余部分（产物、events.jsonl、超时）对两边一样，所以只把这一问抽出来。
   */
  stateOf?: () => "running" | "idle" | "gone" | "unknown";
}): void {
  const started = Date.now();
  const pollMs = opts.pollMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000;
  const seenLines = new Set<string>();
  const seenFiles = new Set<string>();
  /**
   * 见过这个 session 在跑没有。
   *
   * `--background` 把任务投出去就返回，而 session 要过一会儿才从 idle 翻成 running。
   * 不记这一笔，起跑后的头几秒就会被当成「跑完了但没产物」而判失败。
   */
  let sawRunning = false;
  let eventsOffset = 0;
  let finished = false;
  if (opts.replay === false) {
    // 接上来的：把游标推到当前文件末尾，只发从现在起的新行。
    try {
      eventsOffset = readFileSync(join(opts.outDir, "events.jsonl"), "utf8").length;
    } catch {
      /* 还没有这份文件，那就从 0 开始 */
    }
  }

  const scope = opts.scopeProjectId;
  const emit = (e: NodeEvent) => (opts.onEvent ?? ((x: NodeEvent) => publishNodeEvent(x, opts.runId, scope)))(e);

  const tick = () => {
    if (finished) return;

    // ① events.jsonl
    const jsonl = join(opts.outDir, "events.jsonl");
    if (existsSync(jsonl)) {
      try {
        const text = readFileSync(jsonl, "utf8");
        if (text.length > eventsOffset) {
          const fresh = text.slice(eventsOffset);
          eventsOffset = text.length;
          for (const line of fresh.split("\n")) {
            const t = line.trim();
            if (!t || seenLines.has(t)) continue;
            seenLines.add(t);
            try {
              const raw = JSON.parse(t) as Record<string, unknown>;
              emit(normalizeNodeEvent(raw, opts.runId));
            } catch {
              /* 半行（还在写）下一轮再读——offset 已经推进过了，所以只丢这一行 */
            }
          }
        }
      } catch {
        /* 读不到就下一轮 */
      }
    }

    // ② 产物文件出现
    for (const { file, node } of NODE_BY_FILE) {
      const p = join(opts.outDir, file);
      if (seenFiles.has(file) || !existsSync(p)) continue;
      seenFiles.add(file);
      if (!seenLines.size)
        emit({ runId: opts.runId, node, phase: "end", at: new Date().toISOString(), wrote: file });
    }

    // ③ session 状态
    let registered: ReturnType<typeof registeredStageProducts>;
    try { registered = registeredStageProducts(opts.runId); }
    catch { finished = true; stopWatching(opts.runId); return opts.onDone({ status: "failed", error: "registered_run_integrity_failed" }); }
    const done = registered.protected ? registered.finalized : seenFiles.has("gate.json");
    const managed = managedRunState(opts.runId) ?? nativeRunState(opts.runId);
    const state = opts.stateOf ? opts.stateOf() : managed ?? (done ? "idle" : sessionState(opts.sessionId, opts.projectId, opts.agentId));
    if (state === "running") sawRunning = true;
    const timedOut = Date.now() - started > timeoutMs;
    /**
     * **session 停了，而 gate.json 没出来 —— 这就是失败，别再等。**
     *
     * 实测撞到过一次：MCP 子进程在 `stories` 那一步中途没了（另一路正在改
     * `packages/testpilot-mcp/src/*.ts`，而这个子进程是用 tsx 直接跑源码的），
     * 工具返回 `Connection closed`，agent 照 skill 的规矩报错并停下 —— session 变 idle。
     * 而此前这里只认「gate.json 出现」和「超时」两种结局，于是这次运行会**再挂 57 分钟**
     * 才被判失败。界面上它一直是「运行中」，人会一直等一个永远不会来的结果。
     *
     * `sawRunning` 与 90 秒宽限是为了不误伤刚投出去、还没翻成 running 的那几秒。
     */
    const diedQuietly = state === "idle" && !done && (managed !== undefined || sawRunning || Date.now() - started > 90_000);

    if ((done && state !== "running") || timedOut || state === "gone" || diedQuietly) {
      finished = true;
      if (timedOut) { cancelManagedRun(opts.runId); cancelNativeRun(opts.runId); }
      stopWatching(opts.runId);
      if (done && !timedOut && state !== "gone") {
        try {
          const products = registered.protected && registered.finalized ? registered.products : readRun(opts.workspace, opts.runId);
          // `events.jsonl` 已经报过 gate 结束了就别再报一遍——实测发出去两条
          // `gate end`，画布上那一步会闪两下，而进度条不会因此更准。
          if (!seenLines.size)
            emit({ runId: opts.runId, node: "gate", phase: "end", at: new Date().toISOString(), wrote: "gate.json" });
          return opts.onDone({ status: "done", products });
        } catch (e) {
          return opts.onDone({ status: "failed", error: (e as Error).message });
        }
      }
      const why = timedOut
        ? `超过 ${Math.round(timeoutMs / 60000)} 分钟还没有 gate.json`
        : diedQuietly
          ? `session ${opts.sessionId} 已经停了，而 ${opts.outDir} 里没有 gate.json——agent 中途停下了（看 trace）`
          : "session 不在了，而产物没写完";
      emit({ runId: opts.runId, node: "gate", phase: "error", at: new Date().toISOString(), error: why });
      return opts.onDone({ status: "failed", error: why });
    }
  };

  const timer = setInterval(tick, pollMs);
  const r = running.get(opts.runId);
  if (r) r.timer = timer;
  else running.set(opts.runId, { sessionId: opts.sessionId, workspace: opts.workspace, outDir: opts.outDir, timer });
  tick();
}

/**
 * `run_pipeline` 的进度行 → 契约 §1 的 `NodeEvent`。
 *
 * 两种形状都收：契约形状（`{node, phase}`）与 Phase 0 `pipeline.ts` 里 `emit` 的形状
 * （`{kind:"node.started", nodeId}`）。1A 正在把前者落地，而这一层不该等它。
 */
export function normalizeNodeEvent(raw: Record<string, unknown>, runId: string): NodeEvent {
  const kind = String(raw.kind ?? "");
  const payload = (raw.payload ?? {}) as Record<string, unknown>;
  const phase =
    (raw.phase as NodeEvent["phase"]) ??
    (kind === "node.started" ? "start" : payload.status === "failed" ? "error" : "end");
  return {
    runId: String(raw.runId ?? runId),
    node: String(raw.node ?? raw.nodeId ?? "?"),
    phase,
    at: String(raw.at ?? raw.ts ?? new Date().toISOString()),
    ...(raw.ms !== undefined || payload.ms !== undefined ? { ms: Number(raw.ms ?? payload.ms) } : {}),
    ...(raw.calls !== undefined ? { calls: Number(raw.calls) } : {}),
    ...(raw.tokens !== undefined ? { tokens: Number(raw.tokens) } : {}),
    ...(raw.error !== undefined || payload.error !== undefined
      ? { error: String(raw.error ?? payload.error) }
      : {}),
    ...(raw.wrote !== undefined ? { wrote: String(raw.wrote) } : {}),
  };
}

/** 那个 session 现在怎么样。查不到就当它没了。 */
function sessionState(sessionId: string, projectId?: string, agentId?: string): string {
  try {
    const out = execFileSync(
      penguinBin(),
      ["ls", "--json", "--project-id", projectId ?? PROJECT_ID, "--agent-id", agentId ?? AGENT_ID],
      { encoding: "utf8", timeout: 20000, env: penguinEnv() },
    );
    const rows = JSON.parse(out) as Array<{ sessionId: string; status: string }>;
    return rows.find((r) => r.sessionId === sessionId)?.status ?? "gone";
  } catch (e) {
    /**
     * **「penguin server 没起来」不是「查不出来」。**
     *
     * 那句话的意思是**一条 session 都不可能在跑**，所以这次运行已经没了——按 `gone` 收尾。
     * 原来一律当 `unknown`（「可能 server 忙，交给超时兜底」），后果是：
     * 2026-09-12 晚上 16 条运行永远停在「运行中」，每条还每 3 秒 spawn 一个 `penguin ls`
     * 去问一个不存在的 server；超时是一小时，而开发时网关每改一行就重启，计时永远清零。
     * 界面上那一排「运行中」一个都不会自己消失，机器也白烧着。
     */
    const said = `${(e as { stdout?: string; stderr?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}${(e as Error).message ?? ""}`;
    if (/No running server found|cannot auto-start/i.test(said)) return "gone";
    // 真的只是查询挂了（server 忙）：当作还在跑，交给超时兜底。
    return "unknown";
  }
}

/* ── ③ readRun ───────────────────────────────────────────────────────── */

const readJson = (p: string): unknown =>
  existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as unknown) : undefined;

/**
 * 找到这次运行的目录。
 *
 * 目录名与 `meta.json` 里的 `runId` **不一定相同**——Phase 0 那次就不同
 * （目录 `20260902T161435`，里面写的 `20260902T161440`：一个是 agent 拼 outDir 的时刻，
 * 一个是 `run_pipeline` 进函数的时刻）。所以先按目录名找，找不到再翻内容。
 */
export function resolveRunDir(workspace: string, runId: string): string | undefined {
  const direct = join(workspace, "runs", runId);
  if (existsSync(direct)) return direct;
  const root = join(workspace, "runs");
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of ["meta.json", "cases.json", "stories.json"]) {
      const j = readJson(join(dir, f)) as { runId?: string } | undefined;
      if (j?.runId === runId) return dir;
    }
  }
  return undefined;
}

/**
 * 读一次运行的产物，拼成复核那条路认得的形状。
 *
 * 三个文件各自包了一层 `{runId, …}`（`pipeline.ts` 就是这么写的），而
 * `reviewBatch` 要的是 `{stories, cases, gate}` 平铺。这里拆包，**不改任何字段**——
 * 翻译层是所有字段丢失的来源，所以这一层只做拆包，不做重命名。
 */
export function readRun(workspace: string, runId: string): RunProducts {
  const dir = resolveRunDir(workspace, runId);
  if (!dir) throw new Error(`这个工作区里没有 ${runId} 这次运行`);

  const meta = readJson(join(dir, "meta.json")) as RunMeta | undefined;
  const s = readJson(join(dir, "stories.json")) as
    | { stories?: unknown[] }
    | unknown[]
    | undefined;
  const c = readJson(join(dir, "cases.json")) as
    | { cases?: unknown[]; gate?: unknown }
    | unknown[]
    | undefined;
  const g = readJson(join(dir, "gate.json")) as
    | { gate?: unknown; spend?: RunProducts["spend"] }
    | undefined;

  const stories = Array.isArray(s) ? s : (s?.stories ?? []);
  const cases = Array.isArray(c) ? c : (c?.cases ?? []);
  // gate 优先取 gate.json；契约 §1 说 cases.json 是 GatedBundle（含 gate），两处都认。
  const gate = g?.gate ?? (Array.isArray(c) ? undefined : c?.gate);

  if (!cases.length && !stories.length)
    throw new Error(`${runId} 的产物是空的（${dir} 里没有 cases.json / stories.json）`);

  return { meta, bundle: { stories, cases, gate }, spend: g?.spend, dir };
}

/* ── ④ writeDecisions ────────────────────────────────────────────────── */

/**
 * 审计台的决定，写两处。
 *
 * `runs/<runId>/decisions.json`：契约 §1，下一个 session 的 `read_decisions` 读它——
 * 没有它，「已批准的用例进 g2」这条链就断了。
 * db 的 `review_decisions`：现有前端与 `reviewBatch` 读的还是它，Phase 1C 不动前端。
 *
 * 两处**都写**而不是二选一：只写文件，看板与队列立刻失忆；只写 db，下一个 session 看不见。
 * db 那张表只认 approved/rejected，所以契约里的 `revised` 落成「approved + 一条编辑」——
 * 那正是它在队列里的含义（`review.ts::editCase` 把编辑单独存着）。
 */
export function writeDecisions(
  workspace: string,
  runId: string,
  decisions: Decision[],
): { path: string; count: number } {
  const dir = resolveRunDir(workspace, runId) ?? join(workspace, "runs", runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "decisions.json");

  // 按 caseId 覆盖式合并：审计台可以一条一条发，也可以攒够 30 条一次发。
  const prev = (readJson(path) as Decision[] | undefined) ?? [];
  const merged = new Map(prev.map((d) => [d.caseId, d]));
  // 这条路由是唯一合法的写入口，写进去的每条都是人的决定；类型上也只有这一个值。
  for (const d of decisions) merged.set(d.caseId, { ...d, decidedByKind: "human" });
  const all = [...merged.values()];
  writeFileSync(path, JSON.stringify(all, null, 2));
  return { path, count: all.length };
}

/** 读回来给 `read_decisions` 对账用（也给测试用）。 */
export function readDecisions(workspace: string, runId: string): Decision[] {
  const dir = resolveRunDir(workspace, runId);
  if (!dir) return [];
  return ((readJson(join(dir, "decisions.json")) as Decision[] | undefined) ?? []);
}
