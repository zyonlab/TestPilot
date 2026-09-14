import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readGoldState } from "../src/gold.js";

/**
 * T-20 验收：① 改一个组件，挂在它上面的 gold 条目被标 stale；② 连续 N 次 unobservable 进待审（N 可配，默认 3）；
 * ③ 不自动删任何条目、gold.json 一个字节不动。
 */
const SCRIPT = resolve(__dirname, "../../scripts/gold-stale.mjs");

function bench() {
  const root = mkdtempSync(join(tmpdir(), "tp-stale-"));
  const dir = join(root, "benchmark", "demo");
  mkdirSync(dir, { recursive: true });
  const gold = {
    id: "demo-v1",
    items: [
      { id: "G-1", title: "Size 按步长截断", match: { any: ["截断"] }, anchors: ["public/index.html", "normalizeSize"] },
      { id: "G-2", title: "限价超出 80% 被拒", match: { any: ["80%"] }, anchors: ["server.mjs"] },
      { id: "G-3", title: "杠杆设为 5x", match: { any: ["杠杆"] }, cases: ["tc-lev"] },
    ],
  };
  writeFileSync(join(dir, "gold.json"), JSON.stringify(gold, null, 2) + "\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  return { root, dir, goldPath: join(dir, "gold.json") };
}
const run = (a: string[]) => execFileSync("node", [SCRIPT, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("gold-stale", () => {
  it("① 改一个组件 → 挂在它上面的条目 stale，其它不动；gold.json 字节不变", () => {
    const { root, dir, goldPath } = bench();
    const before = readFileSync(goldPath);
    run(["--gold", goldPath, "--changed", "public/index.html", "--write"]);
    const out = JSON.parse(readFileSync(join(dir, "gold.stale.json"), "utf8"));
    expect(out.items.map((m: { id: string }) => m.id)).toEqual(["G-1"]);
    expect(out.items[0].reason).toBe("anchor");
    expect(Buffer.compare(readFileSync(goldPath), before)).toBe(0);
    const state = readGoldState("demo", root);
    expect(state.gold!.items.find((i) => i.id === "G-1")!.stale).toBe(true);
    expect(state.gold!.items.find((i) => i.id === "G-2")!.stale).toBeUndefined();
    expect(state.gold!.items).toHaveLength(3); // ③ 不删条目
  });

  it("组件名 / 接口路径当 anchor 也命中（子串，不分大小写）", () => {
    const { goldPath } = bench();
    const out = JSON.parse(run(["--gold", goldPath, "--changed", "src/lib/NormalizeSize.ts"]));
    expect(out.items.map((m: { id: string }) => m.id)).toEqual(["G-1"]);
  });

  it("② 连续 N 次 unobservable 进待审；N-1 次不进；N 可配", () => {
    const { root, dir, goldPath } = bench();
    const runsPath = join(root, "runs.json");
    const mk = (caseId: string, caseTitle: string, statuses: string[]) =>
      statuses.map((status, i) => ({ caseId, caseTitle, status, startedAt: `2026-09-07T10:0${i}:00Z` }));
    writeFileSync(
      runsPath,
      JSON.stringify({
        runs: [
          ...mk("tc-lev", "杠杆设为 5x 后接口里的杠杆等于 5", ["passed", "unobservable", "unobservable", "unobservable"]),
          ...mk("tc-size", "Size 按步长截断：输入 0.0016", ["unobservable", "unobservable", "passed"]),
        ],
      }),
    );
    run(["--gold", goldPath, "--runs", runsPath, "--write"]);
    let out = JSON.parse(readFileSync(join(dir, "gold.stale.json"), "utf8"));
    expect(out.items).toEqual([expect.objectContaining({ id: "G-3", reason: "unobservable" })]);
    run(["--gold", goldPath, "--runs", runsPath, "--n", "2", "--write"]);
    out = JSON.parse(readFileSync(join(dir, "gold.stale.json"), "utf8"));
    expect(out.items.map((m: { id: string }) => m.id).sort()).toEqual(["G-3"]); // tc-size 最近两次是 unobservable, passed → 不算
    expect(existsSync(goldPath)).toBe(true);
  });
});
