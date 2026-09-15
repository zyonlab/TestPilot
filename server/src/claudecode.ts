import { currentDomainReference } from "./domainReferences.js";
import { recordHostSummary } from './roleSpend.js';
/**
 * 第二个运行时：Claude Code（07 T-05）。与 `penguin.ts` 同形——往上只暴露
 * `startRun / watchRun / readRun / writeDecisions`，`penguinRun.ts` 的接线按 `runtime` 选后端。
 *
 * 和 Penguin 的三处不同，都是运行时的事实，不是设计选择：
 * 1. **session 是我们自己的子进程**。`claude -p … --output-format stream-json` 每行一个事件，
 *    进程活着就是 running，退出就是 idle——`watchRun` 的其余部分（产物、events.jsonl、超时）照 Penguin 的用。
 * 2. **MCP 声明写 workspace 下的 `.mcp.json`**（Penguin 写 agent state 的 system_config.yaml）。
 * 3. **hook 真的执行**：`--plugin-dir plugins/testpilot-claude`（T-07）装上 skills + hooks + mcp，
 *    PreToolUse / Stop 走 `hooks/adapters/claude-code.mjs`（T-06）。stream-json 原样落到
 *    `<outDir>/claude-stream.jsonl`——审计台的「看 trace」深链指它，T-08 数 hook 事件也从它数。
 *
 * CLI 参数以 `claude --help`（2.1.263，2026-09-07 核对）为准：`-p/--print`、`--output-format stream-json`
 * 要配 `--verbose`、`--permission-mode`、`--allowedTools`、`--mcp-config`、`--plugin-dir`。
 */
import { generationMessage, prepareSkillLaunch, type GenerationMessageInput } from "./runtime/skill-launch.js";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPO_ROOT,
  defaultWorkspace,
  newRunId,
  readRun,
  watchRun as penguinWatchRun,
  writeDecisions,
  type NodeEvent,
  type RunProducts,
  type StartRunInput,
  type StartedRun,
} from "./penguin.js";

export { readRun, writeDecisions };

/** 一次 Claude Code 运行的子进程与它的状态。 */
interface Live {
  child: ChildProcess;
  sessionId: string;
  exited: boolean;
  exitCode: number | null;
  outDir: string;
}
const live = new Map<string, Live>();

/** stream-json 的一行。只认这里用到的字段，别的原样保留。 */
export interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: Array<{ type?: string; name?: string; id?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }> };
  [k: string]: unknown;
}

/** 第一行 `system/init` 里有 session_id。 */
export const sessionIdOf = (line: StreamLine): string | undefined =>
  line.type === "system" && line.subtype === "init" && typeof line.session_id === "string" ? line.session_id : undefined;

/**
 * 从 stream-json 里认出「hook 拦了一次」：PreToolUse 的 deny 在 Claude Code 里表现为那次 tool_result 带 `is_error`
 * 且文本以 hook 的 stderr 开头（适配器把 deny 的 reason 原样写到 stderr）。这里只做统计用的粗判，
 * 精确的记账在 `holds.jsonl`（`deny()` 写的）。
 */
export function isHookBlock(line: StreamLine): boolean {
  if (line.type !== "user") return false;
  for (const part of line.message?.content ?? []) {
    if (part.type !== "tool_result" || !part.is_error) continue;
    const text = typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "");
    if (/hook|拒绝|deny|blocked/i.test(text)) return true;
  }
  return false;
}

/** MCP 工具调用 → 契约 §1 的 NodeEvent（节点名用工具名，画布把它当一个节点画）。 */
export function nodeEventsOf(line: StreamLine, runId: string): NodeEvent[] {
  const out: NodeEvent[] = [];
  const at = new Date().toISOString();
  for (const part of line.message?.content ?? []) {
    if (line.type === "assistant" && part.type === "tool_use" && /^mcp__testpilot__/.test(String(part.name ?? "")))
      out.push({ runId, node: String(part.name).replace(/^mcp__testpilot__/, ""), phase: "start", at });
  }
  return out;
}

/** 写 workspace 下的 `.mcp.json`。内容没变就不写。 */
export function writeMcpConfig(workspace: string, extraEnv: Record<string, string> = {}): { path: string; written: boolean } {
  const path = join(workspace, ".mcp.json");
  const cfg = {
    mcpServers: {
      testpilot: {
        command: "node",
        args: [join(REPO_ROOT, "packages/testpilot-mcp/bin/testpilot-mcp.mjs")],
        env: { TP_RUNS_DIR: join(workspace, "runs"), TP_RUNTIME: "claude-code",
          ...(existsSync(join(REPO_ROOT, "server", ".env")) ? { TP_MODEL_ENV_FILE: join(REPO_ROOT, "server", ".env") } : {}), ...extraEnv },
      },
    },
  };
  const text = JSON.stringify(cfg, null, 2) + "\n";
  if (existsSync(path) && readFileSync(path, "utf8") === text) return { path, written: false };
  writeFileSync(path, text);
  return { path, written: true };
}

/** 起跑那句话——和 Penguin 的同一句：outDir 说死，模型不编 id。 */
export function runMessage(input: GenerationMessageInput): string { return generationMessage(input); }

/** Claude Code plugin 目录（T-07 构建出来的）。没有就不带 `--plugin-dir`，hook 也就不执行——日志里要说出来。 */
export const pluginDir = (): string | undefined => {
  const dir = join(REPO_ROOT, "plugins", "testpilot-claude");
  return existsSync(join(dir, ".claude-plugin", "plugin.json")) ? dir : undefined;
};

/** `claude` 可执行文件：PATH 里的，或 `TP_CLAUDE_BIN`。 */
export const claudeBin = (): string => process.env.TP_CLAUDE_BIN || "claude";

export function claudeArgs(message: string, workspace: string, plugin?: string): string[] {
  return [
    "-p",
    message,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "mcp__testpilot__*",
    "Read",
    "Write",
    "Edit",
    "Bash(node *)",
    "--mcp-config",
    join(workspace, ".mcp.json"),
    ...(plugin ? ["--plugin-dir", plugin] : []),
  ];
}

/**
 * 起一个 Claude Code 会话，拿到 session id 就返回。
 * 跑完与否由 `watchRun` 从产物目录看（与 Penguin 同），子进程的退出只回答「还在跑吗」。
 */
export async function startRun(input: StartRunInput = {}): Promise<StartedRun> {
  const workspace = input.workspace ?? defaultWorkspace();
  const materialsDir = input.materialsDir ?? join(workspace, "materials");
  const runId = input.runId ?? newRunId();
  const outDir = join(workspace, "runs", runId);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  /**
   * 流水线模式（run_pipeline）读项目当前的领域参考：写成工作区里的一个文件，经 TP_DOMAIN_REFERENCE_FILE 交给 MCP。
   * 没有就不写——流水线不替任何产品补一段。
   */
  const domainRef = input.generationMode === "pipeline" && input.scopeProjectId ? currentDomainReference(input.scopeProjectId) : undefined;
  const domainFile = domainRef ? join(workspace, "domain-reference.md") : undefined;
  if (domainRef && domainFile) writeFileSync(domainFile, domainRef.text);
  const stageEnv = input.generationMode === "pipeline"
    ? { TP_GENERATION_MODE: "pipeline", ...(domainFile ? { TP_DOMAIN_REFERENCE_FILE: domainFile } : {}) }
    : prepareSkillLaunch({ runId, scopeProjectId: input.scopeProjectId, materialsDir, runtime: "claude-code", limit: input.limit, ablate: input.ablate });

  writeMcpConfig(workspace, {
    ...stageEnv,
    TP_SERVER_URL: process.env.TP_SERVER_URL ?? `http://127.0.0.1:${process.env.PORT ?? 5301}`,
    ...(input.scopeProjectId ? { TP_PROJECT_ID: input.scopeProjectId } : {}),
    ...(input.envRef ? { TP_ENV_ID: input.envRef } : {}),
    // 消融开关走 env 兜底（`pipeline.ts::ablateFromEnv`）：话术里的 `ablate` agent 会丢，env 不会。每次都写，空串即清掉。
    TP_ABLATE: (input.ablate ?? []).join(","),
  });

  const message = input.message ?? runMessage({ materialsDir, outDir, limit: input.limit, ablate: input.ablate, generationMode: input.generationMode });
  const plugin = pluginDir();
  const streamPath = join(outDir, "claude-stream.jsonl");
  const child = spawn(claudeBin(), claudeArgs(message, workspace, plugin), {
    cwd: workspace,
    env: { ...process.env, ...stageEnv, TP_RUNTIME: "claude-code" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entry: Live = { child, sessionId: "", exited: false, exitCode: null, outDir };
  live.set(runId, entry);
  if (!plugin) appendFileSync(streamPath, JSON.stringify({ type: "testpilot", note: "plugins/testpilot-claude 不存在：这次没有 hook（T-07）" }) + "\n");

  let buf = "";
  let stderr = "", nativeModel: string | null = null;
  const sessionId = await new Promise<string>((ok, fail) => {
    let settled = false;
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!raw.trim()) continue;
        appendFileSync(streamPath, raw + "\n");
        try {
          const line = JSON.parse(raw) as StreamLine;
          const sid = sessionIdOf(line);
          if (line.type === "system" && line.subtype === "init" && typeof line.model === "string") nativeModel = line.model;
          if (line.type === "result" && line.usage && entry.sessionId && input.scopeProjectId) recordHostSummary(runId, "claude-code", entry.sessionId, line.usage as Record<string, unknown>, nativeModel, line.total_cost_usd);
          if (sid && !settled) {
            settled = true;
            entry.sessionId = sid;
            ok(sid);
          }
        } catch {
          /* 非 JSON 行：原样留在 stream 文件里就够了 */
        }
      }
    });
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      entry.exited = true;
      if (!settled) fail(new Error(`起不了 claude：${e.message}`));
    });
    child.on("close", (code) => {
      entry.exited = true;
      entry.exitCode = code;
      appendFileSync(streamPath, JSON.stringify({ type: "testpilot", note: `claude exited ${code}`, stderr: stderr.slice(-400) }) + "\n");
      if (!settled) fail(new Error(`claude 退出码 ${code}，没拿到 session_id：${stderr.slice(0, 400)}`));
    });
  });
  return { sessionId, workspace, runId, outDir };
}

/** 与 `penguin.watchRun` 同一个看门狗，只换「session 还在跑吗」这一问。 */
export function watchRun(opts: Parameters<typeof penguinWatchRun>[0]): void {
  penguinWatchRun({
    ...opts,
    stateOf: () => {
      const l = live.get(opts.runId);
      if (!l) return "gone";
      return l.exited ? "idle" : "running";
    },
  });
}

/** 停掉一次运行的子进程。 */
export function cancelRun(runId: string): boolean {
  const l = live.get(runId);
  if (!l || l.exited) return false;
  l.child.kill("SIGTERM");
  return true;
}

export const isRunning = (runId: string): boolean => !!live.get(runId) && !live.get(runId)!.exited;

/** 这次运行的 stream 文件里有几条 hook 拦截、几次 MCP 调用（T-08 用）。 */
export function streamStats(outDir: string): { lines: number; hookBlocks: number; mcpCalls: number } {
  const p = join(outDir, "claude-stream.jsonl");
  const stats = { lines: 0, hookBlocks: 0, mcpCalls: 0 };
  if (!existsSync(p)) return stats;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    stats.lines += 1;
    try {
      const line = JSON.parse(raw) as StreamLine;
      if (isHookBlock(line)) stats.hookBlocks += 1;
      stats.mcpCalls += nodeEventsOf(line, "x").length;
    } catch {
      /* skip */
    }
  }
  return stats;
}

export type { RunProducts };
