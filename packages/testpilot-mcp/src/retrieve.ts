/**
 * `retrieve_spec` 的 MCP 面。
 *
 * 实现在 `harness-testing/src/retrieve/`，不在这里——因为 `design.cases` 节点也要用它，
 * 而节点在 `harness-testing` 里：把实现放在 MCP 包会让那个包反过来依赖这个包，
 * 而「同进程内直接调函数」就会变成「MCP 自己调自己」。
 *
 * 所以这一层只做两件事：把索引落到契约 §4 说的 `materials/.index/`，
 * 以及把结果整理成工具的返回形状。
 */
import {
  loadOrBuildIndex,
  retrieve,
  compactDiagnostics,
  SPEC_FENCE,
  type RetrieveResult,
} from "@testpilot/harness-testing/retrieve";

export interface RetrieveSpecOptions {
  materialsDir: string;
  query: string;
  budgetTokens: number;
  chunkIds?: string[];
  rebuild?: boolean;
  diagnosticOffset?: number;
}

export interface RetrieveSpecResult extends Omit<RetrieveResult, "diagnostics"> {
  diagnostics: ReturnType<typeof compactDiagnostics>;
  indexed: number;
  materialsHash: string;
  /** 提示词里那句话，随结果一起回去：没有按请求上下文块的路径（MCP 就是），notice 只能跟着结果走。 */
  notice: string;
}

/**
 * 段落文本在**出口**过滤，索引里存原文。
 *
 * 索引的 `materialsHash` 是材料内容的指纹，过滤后存进去会让「材料没变但过滤规则变了」
 * 表现成材料变了；而出口是唯一一处所有读者都经过的地方——MCP 的模型、hook 的核对、
 * 审计台的展示，读到的都是同一份过滤后的文本。
 */
export function retrieveSpec(opts: RetrieveSpecOptions): RetrieveSpecResult {
  const index = loadOrBuildIndex(opts.materialsDir, { rebuild: opts.rebuild });
  const out = retrieve(index, opts.query, opts.budgetTokens, { chunkIds: opts.chunkIds });
  return {
    ...out,
    diagnostics: compactDiagnostics(out.diagnostics, opts.diagnosticOffset),
    indexed: index.chunks.length,
    materialsHash: index.materialsHash,
    notice: SPEC_FENCE.notice,
  };
}

/** 模型读到的那份：整个结果包进 `<spec_material>`。`structuredContent` 另给宿主，不包。 */
export function fencedRetrieveText(result: RetrieveSpecResult): string {
  return SPEC_FENCE.wrap(result);
}
