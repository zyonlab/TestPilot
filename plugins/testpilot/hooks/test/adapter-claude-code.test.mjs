/**
 * T-06：Claude Code 载荷进、Penguin hook 判、Claude Code 约定出。
 * 三条验收各一条：缺 sourceRefs 的 Write 退出码 2 且 stderr 点名用例；合法的退出码 0；Stop 时产物没齐 → {"decision":"block"}。
 * 跑法：`node --test plugins/testpilot/hooks/test/`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(HOOKS, "../../..");
const ADAPTER = path.join(HOOKS, "adapters", "claude-code.mjs");

/** Claude Code 形状的 workspace：materials 索引 + 一份 Claude Code 的 transcript（tool_use / tool_result）。 */
function workspace({ retrieved = ["docs/a.md#1", "docs/a.md#2"] } = {}) {
  const ws = mkdtempSync(path.join(tmpdir(), "tp-cc-ws-"));
  const runDir = path.join(ws, "runs", "20260907T000000");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(path.join(ws, "materials", ".index"), { recursive: true });
  writeFileSync(
    path.join(ws, "materials", ".index", "index.json"),
    JSON.stringify({ materialsHash: "x", chunks: ["docs/a.md#1", "docs/a.md#2"].map((id) => ({ id, docId: "docs/a.md", heading: [], text: "t", tokens: 1 })), edges: [] }),
  );
  const body = JSON.stringify({ chunks: retrieved.map((r) => ({ id: r })), dropped: 0, hint: "" });
  const rows = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "mcp__testpilot__retrieve_spec", input: { query: "登录" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: `<spec_material>\n${body}\n</spec_material>` }] }] } },
  ];
  const transcript = path.join(ws, "transcript.jsonl");
  writeFileSync(transcript, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { ws, runDir, transcript };
}

function bundle(cases) {
  return {
    origin: "materials/a.md",
    derivedFrom: "document",
    stories: [{ id: "US-01", title: "登录", acceptance: ["Given / When / Then"] }],
    flows: [],
    cases: cases.map((c, i) => ({
      id: `C-0${i + 1}`, storyId: "US-01", title: `case ${i + 1}`, designMethod: "negative", precondition: [], steps: ["do"], postSteps: [],
      expected: "页面显示「Error」", tier: 1, oracle: { kind: "text", value: "Error" }, key: `k${i}`, covers: [], ...c,
    })),
  };
}

function adapter(payload) {
  const cfgPath = path.join(mkdtempSync(path.join(tmpdir(), "tp-cfg-")), "tp-config.json");
  writeFileSync(cfgPath, JSON.stringify({ repoRoot: REPO, minGateScore: 0.6, minNegativeRatio: 0.3 }));
  return spawnSync(process.execPath, [ADAPTER], {
    input: JSON.stringify(payload),
    cwd: HOOKS,
    env: { ...process.env, TP_HOOK_CONFIG: cfgPath },
    encoding: "utf8",
    timeout: 120_000,
  });
}

const write = (w, content) => ({
  session_id: `cc-${Math.random().toString(36).slice(2, 8)}`, transcript_path: w.transcript, cwd: w.ws, hook_event_name: "PreToolUse",
  tool_name: "Write", tool_input: { file_path: path.join(w.runDir, "cases.json"), content: JSON.stringify(content) },
});

test("Write cases.json 缺 sourceRefs：退出码 2，stderr 点名那条用例", () => {
  const w = workspace();
  const r = adapter(write(w, bundle([{ sourceRefs: ["docs/a.md#1"] }, { sourceRefs: [] }])));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /C-02/);
});

test("Write cases.json 出处齐全：退出码 0，stderr 为空", () => {
  const w = workspace();
  const r = adapter(write(w, bundle([{ sourceRefs: ["docs/a.md#1"] }, { sourceRefs: ["docs/a.md#2"] }])));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.trim(), "");
});

test("出处是从 Claude Code transcript 里翻出来的：transcript 没取过的段 id 被拒", () => {
  const w = workspace({ retrieved: ["docs/a.md#1"] });
  const r = adapter(write(w, bundle([{ sourceRefs: ["docs/a.md#2"] }])));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /docs\/a\.md#2/);
});

test("与门禁无关的工具（Bash）：直接放行", () => {
  const w = workspace();
  const r = adapter({ session_id: "cc-x", transcript_path: w.transcript, cwd: w.ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal(r.status, 0);
});

test("Stop 时产物没齐：stdout 是 {decision: block}，reason 说缺什么", () => {
  const w = workspace();
  writeFileSync(path.join(w.runDir, "stories.json"), "{}");
  const r = adapter({ session_id: `cc-stop-${Date.now()}`, transcript_path: w.transcript, cwd: w.ws, hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /cases\.json/);
});

test("Stop 时产物齐了：不说话（stdout 为空）", () => {
  const w = workspace();
  for (const f of ["stories.json", "cases.json", "gate.json", "meta.json"]) writeFileSync(path.join(w.runDir, f), "{}");
  mkdirSync(path.join(w.ws, "scans"), { recursive: true });
  writeFileSync(path.join(w.ws, "scans", "20260907T000000.json"), "{}");
  const r = adapter({ session_id: `cc-stop-ok-${Date.now()}`, transcript_path: w.transcript, cwd: w.ws, hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "");
});
