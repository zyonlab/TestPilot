/**
 * hook 是子进程：喂一行 stdin JSON，读 stdout 的 JSON。这里不过模型，
 * 钉的是「写盘之前拦得住什么」——形状与出处两道，各有一条该放行的对照。
 *
 * 借 commerce-agents 的纪律：门禁类行为用脚本化输入做单测，eval 只留给模型自己的决策；
 * 每条拒绝配一条「该放行」的对照，防止门禁只会拒。
 *
 * 跑法（仓库根）：`node --test plugins/testpilot/hooks/test/`
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

/** 一个临时 workspace：materials/.index/index.json + 一份 trace。 */
function workspace({ indexIds = ["docs/a.md#1", "docs/a.md#2"], retrieved = ["docs/a.md#1", "docs/a.md#2"], calls = 1 } = {}) {
  const ws = mkdtempSync(path.join(tmpdir(), "tp-ws-"));
  const runDir = path.join(ws, "runs", "20260903T000000");
  mkdirSync(runDir, { recursive: true });
  if (indexIds) {
    mkdirSync(path.join(ws, "materials", ".index"), { recursive: true });
    writeFileSync(
      path.join(ws, "materials", ".index", "index.json"),
      JSON.stringify({ materialsHash: "x", chunks: indexIds.map((id) => ({ id, docId: "docs/a.md", heading: [], text: "t", tokens: 1 })), edges: [] }),
    );
  }
  const rows = [{ type: "session_meta", payload: { workspace: ws } }];
  for (let i = 0; i < calls; i++) {
    const id = `call_${i}`;
    rows.push({ type: "model_msg", payload: { type: "tool_call", name: "mcp__testpilot__retrieve_spec", arguments: "{}", tool_call_id: id } });
    const body = JSON.stringify({ chunks: retrieved.map((r) => ({ id: r })), dropped: 0, hint: "" });
    rows.push({ type: "model_msg", payload: { type: "tool_call_output", output: `<spec_material>\n${body}\n</spec_material>`, tool_call_id: id } });
  }
  const trace = path.join(ws, "trace.jsonl");
  writeFileSync(trace, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { ws, runDir, trace };
}

function bundle(cases) {
  return {
    origin: "materials/a.md",
    derivedFrom: "document",
    stories: [{ id: "US-01", title: "登录", acceptance: ["Given / When / Then"] }],
    flows: [],
    cases: cases.map((c, i) => ({
      id: `C-0${i + 1}`,
      storyId: "US-01",
      title: `case ${i + 1}`,
      designMethod: "negative",
      precondition: [],
      steps: ["do"],
      postSteps: [],
      expected: "页面显示「Error」",
      tier: 1,
      oracle: { kind: "text", value: "Error" },
      key: `k${i}`,
      covers: [],
      ...c,
    })),
  };
}

function runHook(name, { runDir, trace }, content, cfg = {}) {
  const cfgPath = path.join(mkdtempSync(path.join(tmpdir(), "tp-cfg-")), "tp-config.json");
  writeFileSync(cfgPath, JSON.stringify({ repoRoot: REPO, minGateScore: 0.6, minNegativeRatio: 0.3, ...cfg }));
  const msg = {
    hook: "pre_tool_use",
    session_id: "s",
    trace_path: trace,
    tool_name: "write_file",
    tool_call_id: "w1",
    arguments: JSON.stringify({ file_path: path.join(runDir, "cases.json"), content: JSON.stringify(content) }),
  };
  const r = spawnSync(process.execPath, [path.join(HOOKS, name)], {
    input: JSON.stringify(msg),
    cwd: HOOKS,
    env: { ...process.env, TP_HOOK_CONFIG: cfgPath },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(r.status, 0, `hook 自身出错：${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

test("形状与出处都对：放行，并报出处基底", () => {
  const ws = workspace();
  const out = runHook("validate-cases.mjs", ws, bundle([{ sourceRefs: ["docs/a.md#1"] }, { sourceRefs: ["docs/a.md#2", "docs/a.md#1"] }]));
  assert.equal(out.decision, undefined);
  assert.equal(out.output.valid, true);
  assert.equal(out.output.provenance, "trace");
  assert.equal(out.output.anchored, 2);
});

test("一条用例没有 sourceRefs：拒，理由点名那条用例", () => {
  const ws = workspace();
  const out = runHook("validate-cases.mjs", ws, bundle([{ sourceRefs: ["docs/a.md#1"] }, { sourceRefs: [] }]));
  assert.equal(out.decision, "deny");
  assert.equal(out.output.gate, "provenance");
  assert.equal(out.output.unreferenced, 1);
  assert.match(out.reason, /C-02/);
});

test("引用了这次没取到的段：拒，理由带那个 id", () => {
  const ws = workspace({ indexIds: ["docs/a.md#1", "docs/a.md#2", "docs/a.md#3"], retrieved: ["docs/a.md#1"] });
  const out = runHook("validate-cases.mjs", ws, bundle([{ sourceRefs: ["docs/a.md#3"] }]));
  assert.equal(out.decision, "deny");
  assert.equal(out.output.basis, "trace");
  assert.match(out.reason, /docs\/a\.md#3/);
  assert.match(out.reason, /chunkIds/);
});

test("这次运行没调过 retrieve_spec：拒，要求先读再写", () => {
  const ws = workspace({ calls: 0 });
  const out = runHook("validate-cases.mjs", ws, bundle([{ sourceRefs: ["docs/a.md#1"] }]));
  assert.equal(out.decision, "deny");
  assert.equal(out.output.gate, "grounding");
});

test("取过但输出读不出 id 时退到索引基底", () => {
  const ws = workspace({ retrieved: [] });
  const out = runHook("validate-cases.mjs", ws, bundle([{ sourceRefs: ["docs/a.md#1"] }]));
  assert.equal(out.decision, undefined);
  assert.equal(out.output.provenance, "index");
});

test("形状不对仍然先拒形状，不谈出处", () => {
  const ws = workspace();
  const bad = bundle([{ sourceRefs: ["docs/a.md#1"] }]);
  bad.cases[0].steps = [];
  const out = runHook("validate-cases.mjs", ws, bad);
  assert.equal(out.decision, "deny");
  assert.equal(out.output.kind, "schema");
});

test("配置关掉出处核对时只校形状（消融臂用）", () => {
  const ws = workspace({ calls: 0 });
  const out = runHook("validate-cases.mjs", ws, bundle([{}]), { requireProvenance: false });
  assert.equal(out.decision, undefined);
  assert.equal(out.output.valid, true);
  assert.equal(out.output.provenance, undefined);
});

test("不是 cases.json 的写入：弃权（空 stdout）", () => {
  const ws = workspace();
  const out = runHook("validate-cases.mjs", { ...ws, runDir: path.join(ws.ws, "elsewhere") }, bundle([{}]));
  assert.equal(out, null);
});

test("每次拒绝在 runs/<id>/holds.jsonl 留一行，带 gate 名", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const ws = workspace({ calls: 0 });
  runHook("validate-cases.mjs", ws, bundle([{ sourceRefs: ["docs/a.md#1"] }]));
  const p = path.join(ws.runDir, "holds.jsonl");
  assert.ok(existsSync(p), "holds.jsonl 没写");
  const rows = readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hook, "validate-cases");
  assert.equal(rows[0].gate, "grounding");
  assert.ok(rows[0].at);
});

test("放行时不写 holds.jsonl", async () => {
  const { existsSync } = await import("node:fs");
  const ws = workspace();
  runHook("validate-cases.mjs", ws, bundle([{ sourceRefs: ["docs/a.md#1"] }]));
  assert.equal(existsSync(path.join(ws.runDir, "holds.jsonl")), false);
});
