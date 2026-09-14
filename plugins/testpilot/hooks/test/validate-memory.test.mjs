/** 记忆的形状与写过滤：一行不合规矩整份拒；合规的放行。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(HOOKS, "../../..");

function run(file, content) {
  const cfgPath = path.join(mkdtempSync(path.join(tmpdir(), "tp-cfg-")), "tp-config.json");
  writeFileSync(cfgPath, JSON.stringify({ repoRoot: REPO }));
  const msg = { hook: "pre_tool_use", session_id: "s", trace_path: "", tool_name: "write_file", tool_call_id: "w", arguments: JSON.stringify({ file_path: file, content }) };
  const r = spawnSync(process.execPath, [path.join(HOOKS, "validate-memory.mjs")], { input: JSON.stringify(msg), cwd: HOOKS, env: { ...process.env, TP_HOOK_CONFIG: cfgPath }, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

const FILE = "/x/agents/a/agent_state/memory/user/testpilot-episodes.md";

test("合规的几行：放行并数出条数（注释与空行跳过）", () => {
  const out = run(FILE, ["# episodes", "", "- [0123abcd] gate/gate.oracle-vague: oracle-vague ×7（gate 0.55）", "- [0123abcd] hold/hold.grounding: 被 grounding 门拦 2 次"].join("\n"));
  assert.equal(out.decision, undefined);
  assert.equal(out.output.episodes, 2);
});

test("一行带 token：整份拒，理由点到那一行", () => {
  const out = run(FILE, "- [0123abcd] infra/infra.key: 网关 key 是 sk-abcdefghijklmnopqrstuvwxyz\n");
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /写过滤/);
});

test("随手写的一句（不是那个形状）：拒", () => {
  assert.equal(run(FILE, "- 这次跑得不错\n").decision, "deny");
});

test("别的记忆文件：弃权", () => {
  assert.equal(run("/x/agents/a/agent_state/memory/user/MEMORY.md", "- anything"), null);
});
