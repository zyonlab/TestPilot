import { describe, it, expect } from "vitest";
import { parseHostStream, attribute, rankLayers } from "../src/runReport.js";

/**
 * 归因报表的两块纯逻辑：宿主流水去重，与固定归因规则。
 * 组装那一层（runReport）读真实账本，由脚本对真跑验证；这里只锁住口径。
 */
describe("parseHostStream", () => {
  const usage = (read: number) => ({ input_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: 10, output_tokens: 5 });
  const lines = [
    { type: "system", subtype: "init" },
    // 同一条消息拆成三行，每行都带同一份 usage：只能算一次。
    { type: "assistant", message: { id: "m1", usage: usage(100), content: [{ type: "thinking" }] } },
    { type: "assistant", message: { id: "m1", usage: usage(100), content: [{ type: "text", text: "x" }] } },
    { type: "assistant", message: { id: "m1", usage: usage(100), content: [{ type: "tool_use", id: "t1", name: "mcp__testpilot__claim_unit" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] } },
    { type: "assistant", message: { id: "m2", usage: usage(300), content: [{ type: "tool_use", id: "t2", name: "Bash" }] } },
    { type: "result", total_cost_usd: 1.25 },
  ].map((l) => JSON.stringify(l)).join("\n");

  it("按 message.id 去重，不按行累加", () => {
    const h = parseHostStream(lines);
    expect(h.turns).toBe(2);
    expect(h.duplicateLines).toBe(2);
    expect(h.cacheReadTokens).toBe(400);
    expect(h.cacheReadPeak).toBe(300);
    expect(h.outputTokens).toBe(10);
  });

  it("工具调用去掉 MCP 前缀，报错与收尾都记上", () => {
    const h = parseHostStream(lines + "\nnot json");
    expect(h.toolCalls).toEqual({ claim_unit: 1, Bash: 1 });
    expect(h.toolErrors).toBe(1);
    expect(h.reportedUsd).toBe(1.25);
    expect(h.completed).toBe(true);
  });

  it("没有 result 行就是没正常收尾", () => {
    expect(parseHostStream(lines.split("\n").slice(0, -1).join("\n")).completed).toBe(false);
  });
});

describe("attribute", () => {
  const none = { 有产物: false as const };
  const base = { structure: none, stories: none, cases: none, code: { 有产物: false as const, 说明: "" }, units: null, host: null, plannerCoverage: null, execution: null };
  const execution = (failing: Array<Record<string, unknown>>, comparison: unknown = null) => ({
    executionId: "e1", status: "failed", cases: failing.length, byStatus: {}, byAttribution: {}, byCode: {},
    failing: failing.map((f) => ({ caseId: "C", status: "failed", code: null, attribution: null, change: null, reason: "", ...f })),
    comparison,
  }) as never;

  it("什么都没有就不出信号", () => {
    expect(attribute(base as never)).toEqual([]);
  });

  it("基线里过、这次挂的判定失败归到产品；来回翻的归到模型", () => {
    const signals = attribute({ ...base, execution: execution([
      { caseId: "C-1", attribution: "assert", change: "regressed" },
      { caseId: "C-2", attribution: "assert", change: "flaky" },
    ], { regressed: 1 }) } as never);
    expect(signals.find((s) => s.code === "exec_regressed")).toMatchObject({ layer: "product", level: "problem", evidence: { cases: ["C-1"] } });
    expect(signals.find((s) => s.code === "exec_flaky")).toMatchObject({ layer: "model", alternatives: ["tool"] });
    // flaky 的那条不再算成「一直失败」。
    expect(signals.find((s) => s.code.startsWith("exec_assert"))).toBeUndefined();
  });

  it("没有基线时不装作知道：程序判挂的标成产品或用例，并说明分不开", () => {
    const [s] = attribute({ ...base, execution: execution([{ caseId: "C-3", attribution: "assert", decidedBy: "machine" }]) } as never);
    expect(s).toMatchObject({ code: "exec_assert_no_baseline", layer: "product", alternatives: ["case"] });
  });

  it("模型判官判挂的先怀疑模型与用例，不先怀疑产品", () => {
    const signals = attribute({ ...base, execution: execution([
      { caseId: "C-6", attribution: "assert", decidedBy: "judge" },
      { caseId: "C-7", attribution: "assert", decidedBy: "machine" },
    ]) } as never);
    expect(signals.find((s) => s.code === "exec_assert_by_judge")).toMatchObject({ layer: "model", alternatives: ["case", "product"], evidence: { cases: ["C-6"] } });
    expect(signals.find((s) => s.code === "exec_assert_no_baseline")).toMatchObject({ evidence: { cases: ["C-7"] } });
  });

  it("定位失败先怀疑用例措辞，环境失败归工具", () => {
    const signals = attribute({ ...base, execution: execution([
      { caseId: "C-4", attribution: "locate", code: "EXEC_PLAN" },
      { caseId: "C-5", attribution: "infra", code: "MODEL_UNAVAILABLE" },
    ]) } as never);
    expect(signals.find((s) => s.code === "exec_locate")).toMatchObject({ layer: "case", alternatives: ["model"] });
    expect(signals.find((s) => s.code === "exec_infra")).toMatchObject({ layer: "tool", alternatives: ["model"] });
  });

  it("故事里零动作型的比例超阈值才提示，展示型故事少量不算问题", () => {
    const stories = (n: number) => ({ 有产物: true, 故事: 30, 验收准则: 90, 动作型占比: 60, 空叶子: 0, 出处覆盖率: 95, 词表: 9, 机检按码: { story_has_no_actionable_criterion: n } });
    expect(attribute({ ...base, stories: stories(2) } as never).map((s) => s.code)).not.toContain("stories_without_action");
    expect(attribute({ ...base, stories: stories(5) } as never).find((s) => s.code === "stories_without_action")).toMatchObject({ layer: "context" });
  });

  it("反复领取的单元指向上下文：契约多半没交出校验要的数", () => {
    const units = { enabled: true, summary: { total: 2, pending: 0, claimed: 0, done: 2, failed: 0 },
      units: [{ unitId: "cases:a", status: "done", attempt: 4 }, { unitId: "cases:b", status: "done", attempt: 1 }] };
    const s = attribute({ ...base, units } as never).find((x) => x.code === "units_retried");
    expect(s).toMatchObject({ layer: "context", evidence: { units: [{ unitId: "cases:a", attempt: 4 }] } });
  });

  it("层排序：问题 2 分、观察 1 分", () => {
    const ranked = rankLayers([
      { layer: "tool", level: "watch", code: "a", message: "", evidence: {} },
      { layer: "tool", level: "watch", code: "b", message: "", evidence: {} },
      { layer: "product", level: "problem", code: "c", message: "", evidence: {} },
      { layer: "case", level: "watch", code: "d", message: "", evidence: {} },
    ]);
    expect(ranked.map((r) => [r.layer, r.score])).toEqual([["product", 2], ["tool", 2], ["case", 1]]);
  });
});
