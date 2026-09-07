import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HumanLabelSchema,
  NodeEventSchema,
  RunMetaSchema,
  ScoreboardEntrySchema,
  agentState,
  goldHashOf,
  goldHashOfFile,
  inputHashOf,
  missingBinding,
  sha16,
} from "../src/contracts.js";

const meta = {
  runId: "run-abc",
  stage: "g1" as const,
  skillVersion: "2026-09-03.1",
  promptsDigest: { entries: { a: "aaaa1111" }, combined: "bbbb2222" },
  params: { lang: "zh", limit: 2 },
  ablated: [],
  model: { baseUrl: "https://example.invalid/v1", model: "m", thinking: true },
  materialsHash: "0123456789abcdef",
  startedAt: "2026-09-03T00:00:00.000Z",
  finishedAt: "2026-09-03T00:01:00.000Z",
  spend: { calls: 3, tokens: 100, ms: 60_000 },
};

describe("RunMeta", () => {
  it("accepts a complete binding", () => {
    expect(RunMetaSchema.parse(meta).runId).toBe("run-abc");
    expect(missingBinding(meta)).toEqual([]);
  });

  // 拒收规则（契约 §2）：这四项里少任何一项都不许打分。逐项各测一次,
  // 因为「少了一项就拒」和「少了全部才拒」在实现上只差一个 `every`/`some`。
  for (const key of ["skillVersion", "promptsDigest", "model", "materialsHash"] as const) {
    it(`refuses a binding missing ${key}`, () => {
      const broken: Record<string, unknown> = { ...meta };
      delete broken[key];
      expect(missingBinding(broken)).toContain(key);
    });
  }

  it("reports a malformed field rather than claiming the binding is fine", () => {
    expect(missingBinding({ ...meta, promptsDigest: { combined: 1 } })).toContain("promptsDigest");
    expect(missingBinding({ ...meta, spend: "lots" })).not.toEqual([]);
  });
});

describe("agentState", () => {
  it("is 16 hex characters", () => {
    expect(agentState(meta)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable for the same skill version, prompts and params", () => {
    // 只有 skillVersion / promptsDigest / params 三样进指纹：换个 runId、花了多少钱，
    // 都不该让同一版 agent 看起来像两版。
    const other = { ...meta, runId: "run-other", spend: { calls: 9, tokens: 9, ms: 9 } };
    expect(agentState(meta)).toBe(agentState(other));
  });

  // 三样输入各动一次：一个只对其中两样敏感的指纹，会让第三样的改动悄悄进 scoreboard。
  it("moves when the skill version moves", () => {
    expect(agentState({ ...meta, skillVersion: "2026-09-04.1" })).not.toBe(agentState(meta));
  });
  it("moves when the prompts move", () => {
    expect(agentState({ ...meta, promptsDigest: { entries: {}, combined: "cccc3333" } })).not.toBe(agentState(meta));
  });
  it("moves when the params move", () => {
    expect(agentState({ ...meta, params: { lang: "zh", limit: 3 } })).not.toBe(agentState(meta));
  });
});

describe("goldHash", () => {
  it("follows the content, not the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-gold-"));
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    writeFileSync(a, '{"id":"x","items":[]}');
    writeFileSync(b, '{"id":"x","items":[]}');
    expect(goldHashOfFile(a)).toBe(goldHashOfFile(b));
    writeFileSync(b, '{"id":"y","items":[]}');
    expect(goldHashOfFile(a)).not.toBe(goldHashOfFile(b));
  });

  it("is the first 16 hex characters of sha256", () => {
    expect(goldHashOf("hello")).toBe(sha16("hello"));
    expect(goldHashOf("hello")).toHaveLength(16);
  });
});

describe("inputHash", () => {
  // 冻结上游产物的谱系。和 goldHash 一样按内容算，不按路径——但它是逐文件的一组内容。
  function freeze(files: Record<string, string>): { dir: string; rels: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "tp-frozen-"));
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return { dir, rels: Object.keys(files) };
  }

  it("is the same for the same frozen content and moves when a file changes", () => {
    const a = freeze({ "nodes/spec.json": '{"spec":1}', "nodes/stories.json": '{"stories":[1,2]}' });
    const b = freeze({ "nodes/spec.json": '{"spec":1}', "nodes/stories.json": '{"stories":[1,2]}' });
    expect(inputHashOf(a.dir, a.rels)).toBe(inputHashOf(b.dir, b.rels));

    const c = freeze({ "nodes/spec.json": '{"spec":1}', "nodes/stories.json": '{"stories":[1,2,3]}' });
    expect(inputHashOf(c.dir, c.rels)).not.toBe(inputHashOf(a.dir, a.rels));
  });

  it("does not depend on the order the files are listed in", () => {
    const { dir } = freeze({ "nodes/spec.json": "s", "nodes/stories.json": "t" });
    expect(inputHashOf(dir, ["nodes/spec.json", "nodes/stories.json"])).toBe(
      inputHashOf(dir, ["nodes/stories.json", "nodes/spec.json"]),
    );
  });

  // 人冻了 spec+stories 就只哈这两份：不存在的上游（如 docs.json）跳过，不替它补全。
  it("hashes only the files that exist, skipping the ones the human did not freeze", () => {
    const { dir } = freeze({ "nodes/spec.json": "s", "nodes/stories.json": "t" });
    const withMissing = inputHashOf(dir, ["nodes/docs.json", "nodes/spec.json", "nodes/stories.json"]);
    const present = inputHashOf(dir, ["nodes/spec.json", "nodes/stories.json"]);
    expect(withMissing).toBe(present);
  });

  it("is 16 hex characters", () => {
    const { dir, rels } = freeze({ "nodes/spec.json": "s" });
    expect(inputHashOf(dir, rels)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("optional lineage fields", () => {
  // 冻结机制上线前的 meta 没有这两个字段，仍然要解析得过（缺省 = 无冻结输入）。
  it("RunMeta parses with and without frozenInputsDir / inputHash", () => {
    expect(RunMetaSchema.parse(meta).inputHash).toBeUndefined();
    const withFrozen = RunMetaSchema.parse({ ...meta, frozenInputsDir: "/f", inputHash: "abcd1234abcd1234" });
    expect(withFrozen.inputHash).toBe("abcd1234abcd1234");
    expect(withFrozen.frozenInputsDir).toBe("/f");
    // 缺印记的判定不受影响：新字段是 optional，不进拒收清单。
    expect(missingBinding({ ...meta, inputHash: "x" })).toEqual([]);
  });

  it("ScoreboardEntry carries an optional inputHash", () => {
    const entry = {
      id: "sb-1",
      at: "2026-09-03T00:02:00.000Z",
      agentState: agentState(meta),
      goldHash: "abcdef0123456789",
      goldPath: "/tmp/gold.json",
      runId: "run-abc",
      coverage: 0.5,
      heldOutCoverage: 0,
      cases: 15,
      frozen: false,
      binding: meta,
    };
    expect(ScoreboardEntrySchema.parse(entry).inputHash).toBeUndefined();
    expect(ScoreboardEntrySchema.parse({ ...entry, inputHash: "abcd1234abcd1234" }).inputHash).toBe("abcd1234abcd1234");
  });
});

describe("NodeEvent", () => {
  it("carries the artefact an end event wrote, which is what resume reads", () => {
    const e = NodeEventSchema.parse({
      runId: "run-abc",
      node: "stories",
      phase: "end",
      at: "2026-09-03T00:00:30.000Z",
      ms: 30_000,
      wrote: "nodes/stories.json",
    });
    expect(e.wrote).toBe("nodes/stories.json");
  });

  it("rejects a phase that is not start/end/error", () => {
    expect(NodeEventSchema.safeParse({ runId: "r", node: "n", phase: "middle", at: "" }).success).toBe(false);
  });
});

describe("ScoreboardEntry", () => {
  it("requires the full binding, not a run id", () => {
    const entry = {
      id: "sb-1",
      at: "2026-09-03T00:02:00.000Z",
      agentState: agentState(meta),
      goldHash: "abcdef0123456789",
      goldPath: "/tmp/gold.json",
      runId: "run-abc",
      coverage: 0.5,
      heldOutCoverage: 0,
      cases: 15,
      frozen: false,
      binding: meta,
    };
    expect(ScoreboardEntrySchema.parse(entry).binding.skillVersion).toBe("2026-09-03.1");
    expect(ScoreboardEntrySchema.safeParse({ ...entry, binding: "run-abc" }).success).toBe(false);
  });
});

describe("HumanLabel", () => {
  it("insists on the held-out flag", () => {
    const base = { goldId: "G-01", caseId: "c1", runId: "run-abc", covered: true, by: "joe", at: "now" };
    expect(HumanLabelSchema.safeParse(base).success).toBe(false);
    expect(HumanLabelSchema.parse({ ...base, heldOut: false }).heldOut).toBe(false);
  });
});
