import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelEnv } from "../bin/model-env.mjs";

function load(text, ambient = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tp-model-env-"));
  try {
    const path = join(dir, ".env"); writeFileSync(path, text);
    loadModelEnv(path, ambient); return ambient;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("host planner credentials stay unchanged; legacy file fields configure only Midscene", () => {
  const env = load('OPENAI_BASE_URL=https://executor.test/v1\nOPENAI_API_KEY="executor-key"\nMIDSCENE_MODEL_NAME=vision\nUNRELATED_SECRET=skip', {
    OPENAI_API_KEY: "host-key", OPENAI_BASE_URL: "https://host.test/v1",
  });
  assert.equal(env.OPENAI_API_KEY, "host-key");
  assert.equal(env.MIDSCENE_MODEL_API_KEY, "executor-key");
  assert.equal(env.MIDSCENE_MODEL_BASE_URL, "https://executor.test/v1");
  assert.equal(env.TP_PLANNER_MODEL_NAME, undefined);
  assert.equal(env.UNRELATED_SECRET, undefined);
});

test("explicit Midscene env wins over file aliases, including intentional empty credentials", () => {
  const env = load('OPENAI_API_KEY=legacy\nMIDSCENE_MODEL_NAME=vision', { MIDSCENE_OPENAI_API_KEY: "" });
  assert.equal(env.MIDSCENE_OPENAI_API_KEY, "");
  assert.equal(env.MIDSCENE_MODEL_API_KEY, undefined);
});

test("a file without executor credentials cannot borrow ambient host credentials", () => {
  const env = load('MIDSCENE_MODEL_NAME=vision', { OPENAI_API_KEY: "host-key", OPENAI_BASE_URL: "https://host.test/v1" });
  assert.equal(env.MIDSCENE_MODEL_API_KEY, "");
  assert.equal(env.MIDSCENE_MODEL_BASE_URL, "");
});

test("Web planner fields load independently and respect explicit env overrides", () => {
  const env = load('TP_PLANNER_MODEL_NAME=same-initial-model\nTP_PLANNER_API_KEY=planner-key\nMIDSCENE_MODEL_NAME=vision', { TP_PLANNER_MODEL_NAME: "override" });
  assert.equal(env.TP_PLANNER_MODEL_NAME, "override");
  assert.equal(env.TP_PLANNER_API_KEY, "planner-key");
  assert.equal(env.MIDSCENE_MODEL_NAME, "vision");
});
