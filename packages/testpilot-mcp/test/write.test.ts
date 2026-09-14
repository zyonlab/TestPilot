import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeArtifact } from "../src/write.js";
import { Held } from "../src/contracts.js";

/** T-09：门禁挪进工具。不过就拒写并记 holds.jsonl；过了才落盘。 */
const bundle = (cases: Array<Record<string, unknown>>) => ({
  origin: "materials/a.md", derivedFrom: "document",
  stories: [{ id: "US-01", title: "登录", acceptance: ["a"] }], flows: [],
  cases: cases.map((c, i) => ({ id: `C-0${i + 1}`, storyId: "US-01", title: `case ${i + 1}`, designMethod: "negative", precondition: [], steps: ["do"], postSteps: [], expected: "页面显示「Error」", tier: 1, oracle: { kind: "text", value: "Error" }, key: `k${i}`, covers: [], ...c })),
});
const ws = () => { const w = mkdtempSync(join(tmpdir(), "tp-write-")); mkdirSync(join(w, "runs"), { recursive: true }); mkdirSync(join(w, "materials", ".index"), { recursive: true }); writeFileSync(join(w, "materials", ".index", "index.json"), JSON.stringify({ chunks: [{ id: "docs/a.md#1" }, { id: "docs/a.md#2" }] })); return w; };

describe("write_cases（T-09）", () => {
  it("没调过 retrieve_spec：拒，gate=grounding，holds.jsonl 多一条，文件没写", () => {
    const w = ws();
    expect(() => writeArtifact("cases", { runId: "r1", runsDir: join(w, "runs"), content: bundle([{ sourceRefs: ["docs/a.md#1"] }]) }, { retrievedIds: new Set(), retrieveCalls: 0 })).toThrow(Held);
    const holds = readFileSync(join(w, "runs", "r1", "holds.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ hook: "write_cases", gate: "grounding" });
    expect(existsSync(join(w, "runs", "r1", "cases.json"))).toBe(false);
  });

  it("缺 provenance：拒，gate=provenance，理由点名用例", () => {
    const w = ws();
    let err: Held | undefined;
    try { writeArtifact("cases", { runId: "r2", runsDir: join(w, "runs"), content: JSON.stringify(bundle([{ sourceRefs: ["docs/a.md#1"] }, { sourceRefs: [] }])) }, { retrievedIds: new Set(["docs/a.md#1"]), retrieveCalls: 1 }); } catch (e) { err = e as Held; }
    expect(err).toBeInstanceOf(Held);
    expect(err!.gate).toBe("provenance");
    expect(err!.message).toMatch(/C-02/);
  });

  it("形状与出处都对：写盘，返回 written 与基底", () => {
    const w = ws();
    const r = writeArtifact("cases", { runId: "r3", runsDir: join(w, "runs"), content: bundle([{ sourceRefs: ["docs/a.md#1"] }]) }, { retrievedIds: new Set(["docs/a.md#1"]), retrieveCalls: 1 });
    expect(r.written).toBe(join(w, "runs", "r3", "cases.json"));
    expect(r.provenance).toBe("trace");
    expect(JSON.parse(readFileSync(join(w, "runs", "r3", "cases.json"), "utf8")).cases).toHaveLength(1);
  });

  it("形状不对先拒形状（gate=schema）", () => {
    const w = ws();
    expect(() => writeArtifact("stories", { runId: "r4", runsDir: join(w, "runs"), content: "{\"stories\": 1}" }, { retrievedIds: new Set(), retrieveCalls: 0 })).toThrow(/StoryBundleSchema/);
  });
});
