/**
 * 写盘前的校验——**一份实现，两个入口**（07 T-09）。
 *
 * Penguin / Claude Code 上它跑在 hook 里（`plugins/testpilot/hooks/validate-*.mjs` 经 `loadRepo()` 调这里）；
 * Codex 没有 PreToolUse 这类 hook，门禁挪进 MCP 的 `write_stories` / `write_cases` 工具，调的也是这里。
 * `00-架构.md §12` 记过一次「同一条规则有了两份实现」的教训：两份各自演化，某天对同一批用例给出两个答案，
 * 而没有人会发现——所以这里是唯一的一份。
 *
 * 返回值是**判决**，不是异常：`{ ok: true, … }` 或 `{ ok: false, gate, reason, output }`。
 * 怎么把判决说给模型听（hook 的 deny / MCP 的 Held）由入口决定。
 */
import { CaseBundleSchema, StoryBundleSchema, type CaseBundle, type StoryBundle } from "./types.js";
import { checkDesignEvidence } from "./designEvidence.js";
import { checkProvenance, describeProvenance, type ProvenanceReport } from "./provenance.js";
import type { ZodError } from "zod";

export type Gate = "schema" | "provenance" | "grounding";

export type ValidationVerdict<T> =
  | { ok: true; data: T; output: Record<string, unknown>; reason: string }
  | { ok: false; gate: Gate; reason: string; output: Record<string, unknown> };

/** zod 的报错压成一句能进 `reason` 的话：取前 8 条，每条 `路径: 说明`。 */
export function zodBrief(error: ZodError, max = 8): string {
  const issues = error.issues ?? [];
  const lines = issues.slice(0, max).map((i) => `${(i.path ?? []).join(".") || "<root>"}: ${i.message}`);
  const more = issues.length > max ? ` （还有 ${issues.length - max} 条同类问题）` : "";
  return lines.join(" · ") + more;
}

/** 文本先过 JSON，再过 schema。`text` 可以是已经解析过的对象。 */
function parseJson(text: unknown, file: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (typeof text !== "string") return { ok: true, value: text };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, reason: `${file} 不是合法 JSON：${(err as Error).message}。重写一遍这个文件，只写 JSON，不要带 Markdown 代码围栏。` };
  }
}

export function validateStories(text: unknown): ValidationVerdict<StoryBundle> {
  const NAME = "stories.json";
  const p = parseJson(text, NAME);
  if (!p.ok) return { ok: false, gate: "schema", reason: p.reason, output: { file: NAME, valid: false, kind: "json" } };
  const r = StoryBundleSchema.safeParse(p.value);
  if (!r.success)
    return {
      ok: false,
      gate: "schema",
      reason: `${NAME} 不符合 StoryBundleSchema：${zodBrief(r.error)}。形状见 skill testpilot-stories 的 REFERENCE.md；改完再写一次。`,
      output: { file: NAME, valid: false, kind: "schema", issues: r.error.issues.length },
    };
  return {
    ok: true,
    data: r.data,
    output: { file: NAME, valid: true, stories: r.data.stories.length },
    reason: `${NAME} 通过 StoryBundleSchema：${r.data.stories.length} 条故事`,
  };
}

export interface ProvenanceBasis {
  /** 这次会话里 `retrieve_spec` 真正返回过的段 id。 */
  retrieved: Iterable<string>;
  /** `retrieve_spec` 被调过几次。0 = 先读再写这条规矩没守。 */
  retrieveCalls: number;
  /** 材料索引里的全部段 id；`null` = 没有索引。比 `retrieved` 弱：存在不等于取过。 */
  indexed: Iterable<string> | null;
}

export function validateCases(text: unknown, basis?: ProvenanceBasis): ValidationVerdict<CaseBundle> {
  const NAME = "cases.json";
  const p = parseJson(text, NAME);
  if (!p.ok) return { ok: false, gate: "schema", reason: p.reason, output: { file: NAME, valid: false, kind: "json" } };
  const r = CaseBundleSchema.safeParse(p.value);
  if (!r.success)
    return {
      ok: false,
      gate: "schema",
      reason: `${NAME} 不符合 CaseBundleSchema：${zodBrief(r.error)}。形状见 skill testpilot-design 的 REFERENCE.md；改完再写一次。`,
      output: { file: NAME, valid: false, kind: "schema", issues: r.error.issues.length },
    };
  const b = r.data;
  /**
   * v2 设计证据的交叉校验。只在那些可选字段真的出现时才会报错，
   * 所以旧归档（一个都没有）不受影响——见 `designEvidence.ts` 开头那段。
   */
  const evidence = checkDesignEvidence(b.cases);
  if (evidence.length)
    return {
      ok: false,
      gate: "schema",
      reason:
        `${NAME} 的设计证据自相矛盾：` +
        evidence.slice(0, 5).map((e) => `${e.caseId} ${e.code}（${e.message}）`).join("；") +
        (evidence.length > 5 ? ` 等 ${evidence.length} 处` : "") +
        "。这些是结构上就能判的错，改完再写一次。",
      output: { file: NAME, valid: false, kind: "design-evidence", issues: evidence.length },
    };
  if (!basis)
    return {
      ok: true,
      data: b,
      output: { file: NAME, valid: true, cases: b.cases.length, stories: b.stories.length },
      reason: `${NAME} 通过 CaseBundleSchema：${b.cases.length} 条用例 / ${b.stories.length} 条故事`,
    };

  const traced = new Set(basis.retrieved);
  const indexed = basis.indexed ? new Set(basis.indexed) : null;
  // 基底：取过的段优先；一次都没取过就退到索引；索引也没有就没有基底。
  const known = traced.size ? traced : (indexed ?? new Set<string>());
  const kind = traced.size ? "trace" : indexed ? "index" : "none";

  if (basis.retrieveCalls === 0)
    return {
      ok: false,
      gate: "grounding",
      reason:
        `这次运行还没有调用过 retrieve_spec，${NAME} 里的用例没有任何一段材料可以作为出处。` +
        `顺序是先读再写：先用 retrieve_spec 取和每条故事相关的规格段，把返回的 chunk id 逐字写进每条用例的 sourceRefs，再写 ${NAME}。`,
      output: { file: NAME, valid: false, kind: "provenance", cases: b.cases.length },
    };

  const report: ProvenanceReport = checkProvenance(b.cases, known);
  if (report.unreferenced.length || report.unknown.length || kind === "none") {
    const what = describeProvenance(report);
    const how =
      kind === "none"
        ? "本次没有任何可核对的段 id（trace 里 retrieve_spec 没有返回段，materials/.index 也没有）——先调 retrieve_spec。"
        : `sourceRefs 只能填 retrieve_spec 这次返回过的 chunk id（形如 docs/x.md#3），逐字抄；没取到的段先用 retrieve_spec 的 chunkIds 参数取一遍再引用。`;
    return {
      ok: false,
      gate: "provenance",
      reason: `${NAME} 的出处对不上：${what || "没有可核对的基底"}。${how}`,
      output: { file: NAME, valid: false, kind: "provenance", basis: kind, known: report.known, unreferenced: report.unreferenced.length, unknown: report.unknown.length, cases: b.cases.length },
    };
  }
  return {
    ok: true,
    data: b,
    output: { file: NAME, valid: true, cases: b.cases.length, stories: b.stories.length, provenance: kind, anchored: report.anchored, known: report.known },
    reason: `${NAME} 通过 CaseBundleSchema：${b.cases.length} 条用例 / ${b.stories.length} 条故事；出处全部对上（基底 ${kind}，${report.known} 个已知段）`,
  };
}
