/**
 * hook 脚本共用的那点管子。
 *
 * 只用 Node 内建（`plugins/README.md` 的规矩），唯一的例外是 `loadRepo()`：
 * 它要把 TestPilot 仓库里的 **TypeScript 源码**加载进来跑。这是刻意的——
 * 校验规则（zod schema）和门禁规则（`runGate`）**必须和流水线用的是同一份**。
 * 在 hook 里抄一份规则，就等于让两份规则各自演化，然后某一天它们对同一批用例给出两个答案，
 * 而没有人会发现，因为两边都"正常"。
 *
 * 为什么是 tsx 而不是先构建：这个仓库的包**以 TS 源码被消费**（`exports` 直指 `src/*.ts`，
 * 没有构建产物），Phase 0 的 `packages/testpilot-mcp/bin/testpilot-mcp.mjs` 已经是这个做法。
 * 加一步 `tsup` 构建到 `hooks/dist/` 会引入一个新的失步来源：**忘了重新构建的那次，
 * hook 跑的是旧规则**，而它同样不会报错。源码没有这个问题。
 * 代价是每个 hook 首次调用要付一次 tsx 编译（实测 ~1.5s），远在 60s 超时之内。
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** hook 包自己的目录。cwd 也是它，但用 import.meta.url 更稳（cwd 由调用方决定）。 */
export const HOOK_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/\/lib$/, ""));

/** install.sh 写的那份：仓库在哪、门禁阈值是多少。 */
export function config() {
  // 测试用 `TP_HOOK_CONFIG` 指到一份临时配置；正常安装下它不存在，读 install.sh 写的那份。
  const file = process.env.TP_HOOK_CONFIG
    ? pathToFileURL(path.resolve(process.env.TP_HOOK_CONFIG))
    : new URL("../tp-config.json", import.meta.url);
  return JSON.parse(readFileSync(file, "utf8"));
}

/** 读 stdin 上那一行 JSON。 */
export async function input() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

/**
 * 回答。
 *
 * 空 stdout = 弃权，所以「什么都不说」要显式地什么都不打印。
 * 打印非 JSON 会被记成 hook 失败——所以这里只走 JSON.stringify。
 */
export function answer(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
}

/**
 * 一次拒绝落一行到 `runs/<runId>/holds.jsonl`。
 *
 * deny 的 reason 进模型上下文，但**不进任何文件**：trace 里它只是那次 write_file 的输出，
 * 审计台数不到它。而「一次运行被门禁拦了几次、被哪道门拦的」正是要量的东西——
 * 模型撞门禁的次数是它试图绕过来源印记、出处、谱系的直接度量
 * （借 commerce-agents 的 `ToolOutcome.blocked`：拦下是结果，不是错误，所以要记）。
 *
 * hook 是普通 Node 子进程，写 workspace 合法（契约 §4）。写失败不影响拒绝本身。
 * `gate` 用与 MCP `HeldResultSchema` 同一套词：binding / lineage / provenance / grounding / workspace，
 * 外加 hook 自己的两道：schema / gate1。
 */
export function recordHold(runDir, hold) {
  try {
    mkdirSync(runDir, { recursive: true });
    appendFileSync(
      path.join(runDir, "holds.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), ...hold }) + "\n",
    );
  } catch {
    // 记不下来不该改变这次拒绝。
  }
}

/** deny，并把它记进 holds.jsonl。`runDir` 为空就只 deny。 */
export function deny(runDir, hook, gate, reason, output = {}) {
  if (runDir) recordHold(runDir, { hook, gate, reason, ...output });
  answer({ decision: "deny", reason, output: { gate, ...output } });
  process.exit(0);
}

/** 弃权并退出。 */
export function abstain() {
  process.exit(0);
}

let repo = null;
/**
 * 把仓库里的 TS 模块加载进来。
 *
 * tsx 从 `packages/testpilot-mcp` 的位置解析——不是从 cwd（cwd 是 hook 包目录，
 * 那底下没有 node_modules），也不是从本文件（同理）。
 */
export async function loadRepo() {
  if (repo) return repo;
  const { repoRoot } = config();
  const req = createRequire(pathToFileURL(path.join(repoRoot, "packages/testpilot-mcp/package.json")));
  const { register } = await import(pathToFileURL(req.resolve("tsx/esm/api")).href);
  register();
  const url = (rel) => pathToFileURL(path.join(repoRoot, rel)).href;
  const [types, gate, provenance, fence, memory] = await Promise.all([
    import(url("packages/harness-testing/src/casegen/types.ts")),
    import(url("packages/harness-testing/src/casegen/gate.ts")),
    import(url("packages/harness-testing/src/casegen/provenance.ts")),
    import(url("packages/harness-testing/src/retrieve/fence.ts")),
    import(url("packages/testpilot-mcp/src/memory.ts")),
  ]);
  repo = { types, gate, provenance, fence, memory };
  return repo;
}

/**
 * trace 第一行的 `session_meta` 里有 workspace 的绝对路径。
 *
 * stdin 里没有 workspace（见 `docs/v3/03-penguin-hooks-契约.md` §4），这是唯一的正当来源。
 */
export function workspaceOf(tracePath) {
  if (!tracePath) return null;
  const first = readFileSync(tracePath, "utf8").split("\n", 1)[0];
  if (!first) return null;
  const meta = JSON.parse(first);
  return meta?.payload?.workspace ?? null;
}

/** `write_file` 的参数：模型原样写的 JSON 字符串，解析不出来是常态之一。 */
export function writeFileArgs(msg) {
  if (msg.hook !== "pre_tool_use" || msg.tool_name !== "write_file") return null;
  let args;
  try {
    args = JSON.parse(msg.arguments ?? "{}");
  } catch {
    return null; // 参数本身就坏了——审批层会处理，不是校验 hook 的事
  }
  if (typeof args.file_path !== "string" || typeof args.content !== "string") return null;
  return args;
}

/**
 * zod 的报错压成一句能塞进 `reason` 的话。
 *
 * 全量 issues 可能几百行，而 `reason` 是要进模型上下文的——太长会把上下文挤爆，
 * 也会让模型抓不到重点。取前 8 条，每条 `路径: 说明`。
 */
export function zodBrief(error, max = 8) {
  const issues = error?.issues ?? [];
  const lines = issues
    .slice(0, max)
    .map((i) => `${(i.path ?? []).join(".") || "<root>"}: ${i.message}`);
  const more = issues.length > max ? ` （还有 ${issues.length - max} 条同类问题）` : "";
  return lines.join(" · ") + more;
}
