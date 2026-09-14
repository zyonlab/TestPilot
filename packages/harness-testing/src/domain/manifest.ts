import { z } from "zod";

/**
 * 节点上下文清单（ContextManifest v2，docs/v3/21 §3）。
 *
 * 由服务构建，记录**实际下发**了什么：知识包的 revision 与哈希、规则 ID、输入版本、
 * 工具授权、预算。模型回显 manifestId；它不能自签「已加载」。
 * 这一版只接了 source 节点；其余节点在 P-27 里接。
 */
export const ContextManifestSchema = z
  .object({
    schemaVersion: z.literal("context-manifest.v2"),
    manifestId: z.string().min(1),
    projectId: z.string().optional(),
    runId: z.string().optional(),
    node: z.string().min(1),
    attempt: z.number().int().nonnegative(),
    role: z.object({ id: z.string(), version: z.string() }).strict(),
    skills: z.array(z.object({ id: z.string(), version: z.string(), digest: z.string() }).strict()).default([]),
    knowledge: z.array(z.object({ packId: z.string(), revision: z.string(), hash: z.string(), ruleIds: z.array(z.string()), purpose: z.string() }).strict()).default([]),
    inputs: z.array(z.object({ revision: z.string().optional(), pointer: z.string(), digest: z.string() }).strict()).default([]),
    toolGrants: z.array(z.string()).default([]),
    budget: z.record(z.number()).default({}),
    truncation: z.object({ omittedOptionalRefs: z.array(z.string()).default([]), missingRequiredRefs: z.array(z.string()).default([]) }).strict().default({}),
    /** 宿主证明不了上下文隔离时记 unknown，不能宣称严格隔离。 */
    isolationEvidence: z.enum(["service-scoped", "host-best-effort", "unknown"]),
  })
  .strict();
export type ContextManifest = z.infer<typeof ContextManifestSchema>;

/** 必需引用缺失 → 这次输出不能被接受。返回原因列表，空即可继续。 */
export const manifestBlockers = (m: ContextManifest): string[] =>
  m.truncation.missingRequiredRefs.map((r) => `missing_required_ref:${r}`);
