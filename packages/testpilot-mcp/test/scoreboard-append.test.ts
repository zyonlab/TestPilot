import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scoreRun } from "../src/score.js";

/**
 * 记分板追加（07 T-18）：`score_run` 之后 `benchmark/<cap>/scoreboard.yaml` 多一行；
 * 头部注释原样保留；同一次运行同一份 gold 重打分换行不堆行；目录里没有 scoreboard.yaml 就不造一张。
 */
const REPO = resolve(__dirname, "../../..");
const FIXTURE_RUN = resolve(REPO, "benchmark/casegen/replay/fixture-run");
const GOLD = resolve(REPO, "benchmark/casegen/gold.json");

function bench(withBoard: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "tp-sb-"));
  cpSync(GOLD, join(dir, "gold.json"));
  if (withBoard) writeFileSync(join(dir, "scoreboard.yaml"), "# 头部注释要留着\n# 第二行\nentries: []\n");
  const runs = join(dir, "runs");
  cpSync(FIXTURE_RUN, join(runs, "fixture-run"), { recursive: true });
  return { dir, runs };
}

describe("appendScoreboard", () => {
  it("score_run 之后记分板多一行，头部注释原样，网关那条正则读得出", async () => {
    const { dir, runs } = bench(true);
    const entry = await scoreRun({ runId: "fixture-run", goldPath: join(dir, "gold.json"), runsDir: runs });
    const text = readFileSync(join(dir, "scoreboard.yaml"), "utf8");
    expect(text.startsWith("# 头部注释要留着\n# 第二行\n")).toBe(true);
    const m = /entries:\s*(\[[\s\S]*\])/.exec(text);
    const rows = JSON.parse(m![1]) as Array<{ id: string; runId: string; goldHash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].runId).toBe(entry.runId);
    expect(rows[0].goldHash).toBe(entry.goldHash);
    // 重打分：换行，不堆行
    await scoreRun({ runId: "fixture-run", goldPath: join(dir, "gold.json"), runsDir: runs });
    const again = JSON.parse(/entries:\s*(\[[\s\S]*\])/.exec(readFileSync(join(dir, "scoreboard.yaml"), "utf8"))![1]);
    expect(again).toHaveLength(1);
  });

  it("目录里没有 scoreboard.yaml 就不造一张", async () => {
    const { dir, runs } = bench(false);
    await scoreRun({ runId: "fixture-run", goldPath: join(dir, "gold.json"), runsDir: runs });
    expect(existsSync(join(dir, "scoreboard.yaml"))).toBe(false);
  });
});
