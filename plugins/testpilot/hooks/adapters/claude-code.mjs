#!/usr/bin/env node
/**
 * Claude Code → Penguin hook 载荷适配器（07 T-06）。六个 hook 一行不动，只翻译。
 *
 * Claude Code 的 hook 契约（`code.claude.com/docs/hooks`，2.1.x）：
 *   stdin  {session_id, transcript_path, cwd, hook_event_name: "PreToolUse"|"Stop",
 *           tool_name: "Write"|"Edit"|…, tool_input: {file_path, content | old_string,new_string}}
 *   拦截   PreToolUse：退出码 2 + stderr（stderr 进模型上下文）；
 *          Stop：stdout `{"decision":"block","reason":…}`（reason 成为下一轮的 user 消息）。
 * Penguin 的（`docs/v3/03`）：stdin `{hook:"pre_tool_use", tool_name:"write_file", arguments:"<json 字符串>", trace_path}`，
 *   stdout `{decision:"deny", reason}`；`stop` 用 `{decision:"continue", input}`。
 *
 * 两处不是改名就能对上的：
 * 1. **workspace**。Penguin hook 从 trace 第一行 `session_meta.payload.workspace` 拿；Claude Code 给的是 `cwd`
 *    （T-05 起 `claude` 时 cwd 就是 workspace）。这里把 Claude Code 的 transcript 翻成一份 Penguin 形状的 trace：
 *    第一行 session_meta，后面是 `retrieve_spec` 的 tool_use / tool_result——出处核对（validate-cases）
 *    读的就是这些，不翻它们，出处就只剩「材料索引里存在」那条弱基底。
 * 2. **holds 记账**照旧：`deny()` 写 `runs/<id>/holds.jsonl`，这里不碰。
 *
 * 用法（hooks.json 里）：`node <this> ` —— 事件从 stdin 的 hook_event_name 判，不用两个入口。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(HOOKS, "..", "plugin.json"), "utf8"));

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const raw = Buffer.concat(chunks).toString("utf8").trim();
const msg = raw ? JSON.parse(raw) : {};
const event = msg.hook_event_name;
const sessionId = String(msg.session_id ?? "s");
const workspace = msg.cwd ? path.resolve(msg.cwd) : process.cwd();

/** transcript（Claude Code 的 JSONL）→ Penguin 形状的 trace，落在 hook 包自己的 .state/ 下。 */
function traceFor() {
  const dir = path.join(HOOKS, ".state");
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${sessionId}.trace.jsonl`);
  const rows = [{ type: "session_meta", payload: { session_id: sessionId, workspace, runtime: "claude-code" } }];
  const tp = msg.transcript_path;
  if (tp && existsSync(tp)) {
    for (const line of readFileSync(tp, "utf8").split("\n")) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const content = row?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (row.type === "assistant" && part?.type === "tool_use")
          rows.push({ type: "model_msg", payload: { type: "tool_call", name: part.name, arguments: JSON.stringify(part.input ?? {}), tool_call_id: part.id } });
        else if (row.type === "user" && part?.type === "tool_result") {
          const text = typeof part.content === "string" ? part.content : (part.content ?? []).map((c) => (c?.type === "text" ? c.text : "")).join("");
          rows.push({ type: "model_msg", payload: { type: "tool_call_output", output: text, tool_call_id: part.tool_use_id } });
        }
      }
    }
  }
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return out;
}

function runHook(script, penguinMsg, timeoutS) {
  const r = spawnSync(process.execPath, [path.join(HOOKS, script)], {
    input: JSON.stringify(penguinMsg),
    cwd: HOOKS,
    env: process.env,
    encoding: "utf8",
    timeout: (timeoutS ?? 60) * 1000,
  });
  // 契约：崩溃 / 超时 / 非 JSON 一律当弃权——但要在 stderr 留痕，别静悄悄地什么都不拦。
  if (r.status !== 0) { process.stderr.write(`[testpilot hook ${script}] 出错，当作弃权：${(r.stderr || "").slice(-400)}\n`); return null; }
  const text = (r.stdout || "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

if (event === "PreToolUse") {
  const tool = String(msg.tool_name ?? "");
  const input = msg.tool_input ?? {};
  let penguinTool = null, args = null;
  if (tool === "Write") { penguinTool = "write_file"; args = { file_path: input.file_path, content: input.content ?? "" }; }
  else if (tool === "Edit") { penguinTool = "edit_file"; args = { file_path: input.file_path, old: input.old_string ?? "", new: input.new_string ?? "" }; }
  else if (tool === "MultiEdit") { penguinTool = "edit_file"; args = { file_path: input.file_path, edits: input.edits ?? [] }; }
  if (!penguinTool || typeof args.file_path !== "string") process.exit(0);
  const trace = traceFor();
  const penguinMsg = { hook: "pre_tool_use", session_id: sessionId, trace_path: trace, tool_name: penguinTool, tool_call_id: `cc-${Date.now()}`, arguments: JSON.stringify(args) };
  for (const h of manifest.hooks?.pre_tool_use ?? []) {
    const out = runHook(h.command, penguinMsg, h.timeout);
    if (out?.decision === "deny") {
      process.stderr.write(String(out.reason ?? `${h.command} 拒绝了这次写入`));
      process.exit(2);
    }
  }
  process.exit(0);
}

if (event === "Stop") {
  const trace = traceFor();
  const penguinMsg = { hook: "stop", session_id: sessionId, trace_path: trace };
  for (const h of manifest.hooks?.stop ?? []) {
    const out = runHook(h.command, penguinMsg, h.timeout);
    if (out?.decision === "continue") {
      process.stdout.write(JSON.stringify({ decision: "block", reason: String(out.input ?? out.reason ?? "产物未齐") }));
      process.exit(0);
    }
  }
  process.exit(0);
}

process.exit(0);
