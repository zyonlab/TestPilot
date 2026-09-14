/** 决定只能是人写的。agent 碰 decisions.json / holds.jsonl / gate.json 一律拒。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(tool, file, content = "{}") {
  const cfgPath = path.join(mkdtempSync(path.join(tmpdir(), "tp-cfg-")), "tp-config.json");
  writeFileSync(cfgPath, JSON.stringify({ repoRoot: path.resolve(HOOKS, "../../.."), minGateScore: 0.6, minNegativeRatio: 0.3 }));
  const msg = {
    hook: "pre_tool_use",
    session_id: "s",
    trace_path: "",
    tool_name: tool,
    tool_call_id: "w1",
    arguments: JSON.stringify(tool === "edit_file" ? { file_path: file, old: "a", new: "b" } : { file_path: file, content }),
  };
  const r = spawnSync(process.execPath, [path.join(HOOKS, "protect-decisions.mjs")], {
    input: JSON.stringify(msg),
    cwd: HOOKS,
    env: { ...process.env, TP_HOOK_CONFIG: cfgPath },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

const ws = mkdtempSync(path.join(tmpdir(), "tp-ws-"));
const runDir = path.join(ws, "runs", "20260904T000000");

test("write_file 写 decisions.json：拒，gate=workspace", () => {
  const out = run("write_file", path.join(runDir, "decisions.json"), JSON.stringify([{ caseId: "c1", decision: "approved" }]));
  assert.equal(out.decision, "deny");
  assert.equal(out.output.gate, "workspace");
  assert.match(out.reason, /审计台/);
});

test("edit_file 改 gate.json / holds.jsonl：拒", () => {
  assert.equal(run("edit_file", path.join(runDir, "gate.json")).decision, "deny");
  assert.equal(run("write_file", path.join(runDir, "holds.jsonl")).decision, "deny");
});

test("写 cases.json 或别处的 decisions.json：弃权（对照）", () => {
  assert.equal(run("write_file", path.join(runDir, "cases.json")), null);
  assert.equal(run("write_file", path.join(ws, "notes", "decisions.json")), null);
});
