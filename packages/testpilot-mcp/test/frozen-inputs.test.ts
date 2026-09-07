import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipeline } from "../src/pipeline.js";
import { bindingDrift, pairedEval, scoreRun } from "../src/score.js";
import type { RunMeta } from "../src/contracts.js";

/* ---------------------------------------------------------------- 夹具 */

const baseMeta = (over: Partial<RunMeta>): RunMeta => ({
  runId: "run-x",
  stage: "g1",
  skillVersion: "2026-09-03.1",
  promptsDigest: { entries: { a: "aaaa1111" }, combined: "bbbb2222" },
  params: { lang: "zh", from: "design" },
  ablated: [],
  model: { baseUrl: "https://example.invalid/v1", model: "m", thinking: true },
  materialsHash: "0123456789abcdef",
  startedAt: "2026-09-03T00:00:00.000Z",
  finishedAt: "2026-09-03T00:01:00.000Z",
  spend: { calls: 1, tokens: 10, ms: 1000 },
  ...over,
});

const GOLD = JSON.stringify({
  id: "g",
  items: [{ id: "G-1", title: "t", match: { anyOf: ["zzz"], assertAnyOf: ["zzz"] } }],
});

/** 写一个最小可打分的运行目录：meta.json（完整印记）+ cases.json。 */
function writeRun(runId: string, over: Partial<RunMeta>): string {
  const runsRoot = mkdtempSync(join(tmpdir(), "tp-runs-"));
  const dir = join(runsRoot, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(baseMeta({ runId, ...over })));
  writeFileSync(
    join(dir, "cases.json"),
    JSON.stringify({ runId, cases: [{ id: "c1", title: "hello", steps: ["do"], expected: "ok" }] }),
  );
  return dir;
}

function writeGold(): string {
  const dir = mkdtempSync(join(tmpdir(), "tp-gold-"));
  const p = join(dir, "gold.json");
  writeFileSync(p, GOLD);
  return p;
}

/* ------------------------------------------- run_pipeline 的入参校验 */

describe("run_pipeline frozenInputsDir validation", () => {
  it("refuses frozenInputsDir without from — a frozen input only means something when resuming", async () => {
    const materials = mkdtempSync(join(tmpdir(), "tp-mat-"));
    writeFileSync(join(materials, "spec.md"), "# Spec\n\nSome text.\n");
    const outDir = mkdtempSync(join(tmpdir(), "tp-out-"));
    await expect(
      runPipeline({ stage: "g1", materialsDir: materials, outDir, frozenInputsDir: "/somewhere" }),
    ).rejects.toThrow(/frozenInputsDir was given without from/);
  });

  it("refuses resuming from a frozen dir that has no upstream artefact", async () => {
    const materials = mkdtempSync(join(tmpdir(), "tp-mat-"));
    writeFileSync(join(materials, "spec.md"), "# Spec\n\nSome text.\n");
    const outDir = mkdtempSync(join(tmpdir(), "tp-out-"));
    const emptyFrozen = mkdtempSync(join(tmpdir(), "tp-frozen-"));
    await expect(
      runPipeline({ stage: "g1", materialsDir: materials, outDir, from: "design", frozenInputsDir: emptyFrozen }),
    ).rejects.toThrow(/frozenInputsDir .* has no "stories" artefact/);
  });
});

/* ------------------------------------------------ inputHash 谱系判定 */

describe("inputHash lineage in paired_eval", () => {
  it("refuses two runs frozen from different inputs — different evolution experiments", async () => {
    const a = writeRun("run-a", { inputHash: "1111111111111111" });
    const b = writeRun("run-b", { inputHash: "2222222222222222" });
    await expect(pairedEval({ a, b, goldPath: writeGold() })).rejects.toThrow(
      /different frozen inputs .*different evolution experiments/,
    );
  });

  it("compares two runs frozen from the same input, and carries that inputHash onto the entry", async () => {
    const a = writeRun("run-a", { inputHash: "1111111111111111" });
    const b = writeRun("run-b", { inputHash: "1111111111111111" });
    const entry = await pairedEval({ a, b, goldPath: writeGold() });
    expect(entry.inputHash).toBe("1111111111111111");
  });

  // 两边都没有 inputHash = 冻结机制之前的旧运行 / 整条流水线从 docs 起跑 → 老路，照比。
  it("compares two runs that both have no inputHash (the old whole-pipeline path)", async () => {
    const a = writeRun("run-a", {});
    const b = writeRun("run-b", {});
    const entry = await pairedEval({ a, b, goldPath: writeGold() });
    expect(entry.inputHash).toBeUndefined();
  });
});

describe("score_run carries inputHash from the binding", () => {
  it("copies a frozen run's inputHash onto the scoreboard entry", async () => {
    const dir = writeRun("run-a", { inputHash: "abcd1234abcd1234" });
    const entry = await scoreRun({ runId: dir, goldPath: writeGold() });
    expect(entry.inputHash).toBe("abcd1234abcd1234");
  });

  it("leaves inputHash undefined for a run with no frozen input", async () => {
    const dir = writeRun("run-a", {});
    const entry = await scoreRun({ runId: dir, goldPath: writeGold() });
    expect(entry.inputHash).toBeUndefined();
  });
});

describe("bindingDrift counts a frozen-input mismatch", () => {
  // 混搭（一臂冻结、一臂没冻结）不硬拒，但要在 note 里现形。
  it("names frozenInput when one arm is frozen and the other is not", () => {
    const a = baseMeta({ runId: "a", inputHash: "1111111111111111" });
    const b = baseMeta({ runId: "b" });
    expect(bindingDrift(a, b)).toContain("frozenInput");
  });

  it("does not name frozenInput when both share the same inputHash", () => {
    const a = baseMeta({ runId: "a", inputHash: "1111111111111111" });
    const b = baseMeta({ runId: "b", inputHash: "1111111111111111" });
    expect(bindingDrift(a, b)).not.toContain("frozenInput");
  });
});
