import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HumanLabelSchema, ScoreboardEntrySchema } from "../src/contracts.js";
import { loadEvalCases } from "../src/evalcase.js";
import { loadGold } from "../src/score.js";

/**
 * 每个基准目录都要满足的契约。一份测试，星号式地跑在所有 `benchmark/<cap>/` 上。
 *
 * 借 commerce-agents 的 `examples/demo_common/tests/contract.py`：四个垂类共享一份契约测试，
 * 垂类差异用 fixture 缺席时 skip 表达，而不是各写一份。这里的「垂类」是能力目录：
 * casegen 与 binance-futures 两份，以后每加一份基准都自动进这张网。
 *
 * `loadGold` 找不到就抛、不兜底（`score.ts`）是这份契约在代码里的另一半。
 */
const ROOT = join(__dirname, "..", "..", "..");
const caps = readdirSync(join(ROOT, "benchmark")).filter((d) => statSync(join(ROOT, "benchmark", d)).isDirectory());

describe.each(caps)("benchmark/%s", (cap) => {
  const dir = join(ROOT, "benchmark", cap);
  const read = (rel: string) => JSON.parse(readFileSync(join(dir, rel), "utf8")) as unknown;

  it("gold.json 是合法的黄金清单，且至少有一条留出项", () => {
    const { gold } = loadGold(join(dir, "gold.json"));
    expect(gold.items.length).toBeGreaterThan(0);
    expect(gold.items.some((i) => i.heldOut)).toBe(true);
    // 每条至少一个匹配锚：没有 match 的清单项谁也覆盖不了，那是一条永远的 miss。
    for (const i of gold.items) expect((i.match?.anyOf?.length ?? 0) + (i.match?.assertAnyOf?.length ?? 0)).toBeGreaterThan(0);
  });

  it("gold.draft.json 若在，不是 gold.json 本身——草稿未审阅前任何工具不得读它（P2）", () => {
    if (!existsSync(join(dir, "gold.draft.json"))) return;
    expect(readFileSync(join(dir, "gold.draft.json"), "utf8")).not.toBe(readFileSync(join(dir, "gold.json"), "utf8"));
  });

  it("human-labels.json 每条合法", () => {
    if (!existsSync(join(dir, "human-labels.json"))) return;
    const raw = read("human-labels.json") as { labels?: unknown[] } | unknown[];
    const list = Array.isArray(raw) ? raw : (raw.labels ?? []);
    for (const l of list) HumanLabelSchema.parse(l);
  });

  it("scoreboard.yaml 的每条条目带完整 binding（缺项拒收）", () => {
    if (!existsSync(join(dir, "scoreboard.yaml"))) return;
    const text = readFileSync(join(dir, "scoreboard.yaml"), "utf8");
    // 没有条目时是 `entries: []`；有条目时是 JSON 兼容的 YAML（score_run 这么写）。
    if (/^entries:\s*\[\]\s*$/m.test(text)) return;
    const m = /entries:\s*(\[[\s\S]*\])/.exec(text);
    if (!m) return;
    for (const e of JSON.parse(m[1]) as unknown[]) ScoreboardEntrySchema.parse(e);
  });

  it("rubric/ 与 held-out/ 存在且不在 statement/ 里（agent 不可见的那半边）", () => {
    expect(existsSync(join(dir, "rubric"))).toBe(true);
    expect(existsSync(join(dir, "held-out"))).toBe(true);
    if (existsSync(join(dir, "statement"))) {
      const listed = readdirSync(join(dir, "statement"));
      expect(listed).not.toContain("gold.json");
      expect(listed).not.toContain("rubric");
    }
  });

  it("cases/*.json 都是合法的评测用例；投毒材料只在 cases/poison/", () => {
    const casesDir = join(dir, "cases");
    if (!existsSync(casesDir)) return;
    const cases = loadEvalCases(casesDir);
    for (const c of cases) for (const p of c.state.poison) expect(p.startsWith("cases/poison/")).toBe(true);
    // 每个投毒文件都被至少一条用例引用；一份没人用的投毒材料就是一份放错地方的材料。
    const poisonDir = join(casesDir, "poison");
    if (existsSync(poisonDir))
      for (const f of readdirSync(poisonDir)) expect(cases.some((c) => c.state.poison.includes(`cases/poison/${f}`))).toBe(true);
  });

  it("replay/ 里每次冻结运行都有 expected.json", () => {
    const replayDir = join(dir, "replay");
    if (!existsSync(replayDir)) return;
    for (const run of readdirSync(replayDir)) {
      const rd = join(replayDir, run);
      if (!statSync(rd).isDirectory()) continue;
      expect(existsSync(join(rd, "meta.json"))).toBe(true);
      expect(existsSync(join(rd, "expected.json"))).toBe(true);
    }
  });
});
