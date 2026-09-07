import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EPISODE_REJECTED_TEXT, extractEpisodes, formatEpisode, parseEpisodeLine, runTag, validateEpisode } from "../src/memory.js";

/** 记忆有形状、有写过滤、从产物里算——三件事各一组，每个拒绝配一个该收的对照。 */
describe("episodic 记忆", () => {
  const tag = runTag("run-x");

  it("形状：key ≤64 小写、value ≤200、category 枚举、runTag 8 位", () => {
    const ok = validateEpisode({ key: "gate.oracle-vague", value: "oracle-vague ×7", category: "gate", runTag: tag });
    expect(ok.key).toBe("gate.oracle-vague");
    expect(() => validateEpisode({ key: "Bad Key", value: "x", category: "gate", runTag: tag })).toThrow();
    expect(() => validateEpisode({ key: "k", value: "x".repeat(201), category: "gate", runTag: tag })).toThrow();
    expect(() => validateEpisode({ key: "k", value: "x", category: "feeling", runTag: tag })).toThrow();
    expect(() => validateEpisode({ key: "k", value: "x", category: "gate", runTag: "abc" })).toThrow();
  });

  it("写过滤：凭证、邮箱、长串、claim 链接一律拒；普通的坑照收", () => {
    const bad = [
      "网关 key 是 sk-abcdefghijklmnopqrstuvwxyz",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "联系 someone@example.com",
      "cookie: session=abc",
      "claim 链接 http://127.0.0.1:7364/claim?token=abcdef123456",
      "卡号 4111 1111 1111 1111",
      "会话串 " + "A".repeat(48),
    ];
    for (const value of bad)
      expect(() => validateEpisode({ key: "k", value, category: "infra", runTag: tag })).toThrow(EPISODE_REJECTED_TEXT);
    expect(() => validateEpisode({ key: "infra.gateway", value: "api.runinfra.ai 连接层失败约 2/5（fetch failed），配对评测 n≥3 要按这个失败率预留", category: "infra", runTag: tag })).not.toThrow();
  });

  it("markdown 行：format 与 parse 互逆；不是这个形状就 undefined", () => {
    const e = validateEpisode({ key: "hold.grounding", value: "被 grounding 门拦 2 次", category: "hold", runTag: tag });
    const line = formatEpisode(e);
    expect(line).toBe(`- [${tag}] hold/hold.grounding: 被 grounding 门拦 2 次`);
    expect(parseEpisodeLine(line)).toEqual(e);
    expect(parseEpisodeLine("- 随手写的一句")).toBeUndefined();
  });

  it("抽取：gate warn 规则、holds 的门、scan 的 kind 各一条，每条说得出来源；没有产物就没有候选", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-mem-"));
    writeFileSync(join(dir, "gate.json"), JSON.stringify({ score: 0.55, findings: [
      { rule: "oracle-vague", severity: "warn", message: "「正常」不是现象", caseId: "C-1" },
      { rule: "oracle-vague", severity: "warn", message: "x", caseId: "C-2" },
      { rule: "tier-unbacked", severity: "warn", message: "tier 1 没 oracle", caseId: "C-3" },
      { rule: "granularity", severity: "info", message: "ok" },
    ] }));
    writeFileSync(join(dir, "holds.jsonl"), [
      JSON.stringify({ at: "t", hook: "validate-cases", gate: "grounding", reason: "先读再写。别的话" }),
      JSON.stringify({ at: "t", hook: "validate-cases", gate: "grounding", reason: "又一次" }),
    ].join("\n") + "\n");
    const scanDir = mkdtempSync(join(tmpdir(), "tp-scan-"));
    writeFileSync(join(scanDir, "r.json"), JSON.stringify({ findings: [{ kind: "unanchored", caseId: "C-9", evidence: "无出处", severity: "warn" }] }));

    const out = extractEpisodes({ runId: "run-x", runDir: dir, scanPath: join(scanDir, "r.json") });
    expect(out.runTag).toBe(tag);
    const keys = out.candidates.map((c) => c.key);
    expect(keys).toEqual(["gate.oracle-vague", "gate.tier-unbacked", "hold.grounding", "scan.unanchored"]);
    expect(out.candidates[0].value).toContain("×2");
    expect(out.candidates[0].source).toBe("gate.json");
    expect(out.candidates[2].value).toContain("2 次");
    expect(out.candidates[2].value).toContain("又一次");
    expect(out.skipped).toEqual([]);

    const empty = extractEpisodes({ runId: "run-y", runDir: mkdtempSync(join(tmpdir(), "tp-mem-")) });
    expect(empty.candidates).toEqual([]);
  });

  it("抽取出来的候选若撞写过滤，进 skipped 而不是静默丢", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-mem-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "holds.jsonl"), JSON.stringify({ at: "t", hook: "h", gate: "workspace", reason: "token sk-abcdefghijklmnopqrstuvwxyz 泄露" }) + "\n");
    const out = extractEpisodes({ runId: "run-z", runDir: dir });
    expect(out.candidates).toEqual([]);
    expect(out.skipped[0]).toMatch(/hold\.workspace/);
  });
});
