import { z } from "zod";
import { checkModulePlan, type ModuleProposal, type PlanFinding } from "@testpilot/harness-testing/domain";
import { runLedger } from "./runService.js";
import { requireStageStarted, stageEvent } from "./workflowControls.js";
import { LedgerError } from "./runLedger.js";
import type { Principal } from "@testpilot/harness-core/run-contracts";

/**
 * `modules` 节点：产品模块树的提议、机检与冻结（docs/v3/history/24 §6、§7）。
 *
 * 在此之前这条链路上**没有**模块规划：`buildProductModel` 里是 `modules: pack.modules`，
 * 树从规则包原样抄，模型一个字都没参与，于是它的质量从来没被量过——没有节点就没有产物，
 * 没有产物就没有检查。
 *
 * 形状照抄 gold，因为模块树和 gold 是同一类东西：**产品事实，不是推导产物**。
 *   模型提议 → 服务端机检 → 人冻结。
 * 机器判得了「这棵树有没有漏掉材料、是不是一张伪装成树的清单」；
 * 判不了「这棵树切得对不对」——2026-09-11 实测里那条「点击持仓行的『全部关闭』」
 * （它其实是列头）机检一辈子也抓不到，只能靠人看。所以冻结那一步不能省。
 *
 * 它必须排在 stories 之前：`planUnits("stories")` 按根模块子树切单元，没有树就切不出单元。
 */

const ModuleProposalSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(120).optional(),
  parentId: z.string().min(1).max(120).nullable().optional(),
  purpose: z.string().max(2000).optional(),
  evidence: z.array(z.string().min(1)).default([]),
  /** 这个模块认领产品模型里的哪些功能。换了模块 id 时**必须写**，否则功能全成孤儿。 */
  featureIds: z.array(z.string().min(1)).default([]),
}).strict();

const ModulePlanSchema = z.object({
  modules: z.array(ModuleProposalSchema).min(1),
  outOfScope: z.array(z.object({ sectionId: z.string().min(1), reason: z.string().max(2000) }).strict()).default([]),
}).strict();

export type ModulePlan = z.infer<typeof ModulePlanSchema>;

/**
 * 这次运行的材料里有哪些**可引用的段**。
 *
 * 一个 `## ` 标题一段，id 是 `<材料名>#<序号>`，序号从 1 起。这个编号方式和材料里
 * 写给人看的引用格式必须一致——两边对不上的话，「每段都要有落点」这条检查会把
 * 全部段落都报成没人认领，而真正的问题只是编号口径不同。
 */
export function materialSections(runId: string, projectId: string): string[] {
  const l = runLedger();
  const out: string[] = [];
  for (const r of l.listRevisions(projectId, runId)) {
    if (r.kind !== "material") continue;
    const text = l.readRevision(r.id, projectId).content;
    if (typeof text !== "string") continue;
    /**
     * 分节符认两种：markdown 的 `## `，以及材料自己的 `===== … =====` 横幅。
     *
     * 2026-09-12 实测：探索材料整份只有一个 `# Observed product`，一个 `##` 都没有——
     * 于是段号集合是空的，而契约要求「每个模块至少引用一段」，
     * 结果是 80 条引用 80 条 `module_evidence_unknown`：这条契约在探索材料上
     * **根本无法被满足**，机检查出来的不是模型乱编，是我们从没给过它可引的段。
     * 探索材料的每一屏都是一条 `===== 第 N 屏 =====`，那就是它的段。
     */
    const n = text.split("\n").filter((line) => /^##\s+\S/.test(line) || /^=====\s+\S.*\s+=====$/.test(line.trim())).length;
    for (let i = 1; i <= n; i++) out.push(`${r.name}#${i}`);
  }
  return out;
}

/**
 * 回执表和别的节点共用一张（`runStages.ts::store`）。
 * 这里也建一次，是因为 `modules` 排在所有节点之前：一条运行可以在 `runStages` 的任何
 * 函数被调用之前就先写模块树，那时表还不存在。`IF NOT EXISTS` 保证两边不会打架。
 */
function store() {
  const l = runLedger();
  l.db.exec(`CREATE TABLE IF NOT EXISTS run_stage_receipts (
      runId TEXT NOT NULL REFERENCES wf_run_registrations(runId), stage TEXT NOT NULL,
      revisionId TEXT NOT NULL REFERENCES artifact_revisions(id), json TEXT NOT NULL,
      PRIMARY KEY(runId,stage));`);
  return l;
}

function receiptOf(runId: string) {
  const row = store().db.prepare("SELECT json FROM run_stage_receipts WHERE runId=? AND stage='modules'").get(runId) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as { revisionId: string; frozen?: boolean; findings?: number; frozenBy?: string; frozenAt?: string; frozenNote?: string }) : undefined;
}

/**
 * 新树装不下的功能。
 *
 * `planUnits` 按模块子树收功能：`model.features.filter(f => moduleIds.includes(f.moduleId))`。
 * 换一棵 id 全新的树之后，规则包里每个 feature 的 `moduleId` 都可能落空——单元照样切得出来，
 * 但每个单元的功能与规则都是空的，**领到单元的规划器什么材料都没有**，而且一路上不会报错。
 *
 * 这里查不了「该怎么重挂」（那要人判），只负责把这件事说出来：哪些功能没有落点、有几个。
 * 记成 warn 不是 error——一棵全新的树本来就会换 id，拦死它等于把这个节点作废；
 * 但冻结的时候这条会出现在「还剩几条没处理」里，谁按下冻结谁就看见过它。
 */
function droppedFeatures(runId: string, projectId: string, moduleIds: string[], claims: ModuleProposal[] = []): PlanFinding[] {
  const l = runLedger();
  const found = l.listRevisions(projectId, runId).filter((r) => r.name === "product/model-candidate").sort((a, b) => a.revision - b.revision).at(-1);
  if (!found) return [];
  const model = l.readRevision(found.id, projectId).content as { features?: Array<{ id: string; moduleId?: string }> };
  const ids = new Set(moduleIds);
  const features = model.features ?? [];
  // 新树可以自己认领功能（`featureIds`）；认领了就不算孤儿，哪怕模块 id 全换了。
  const claimed = new Set(claims.flatMap((c) => c.featureIds ?? []));
  const orphans = features.filter((f) => !claimed.has(f.id) && (!f.moduleId || !ids.has(f.moduleId)));
  const unknownClaims = [...claimed].filter((id) => !features.some((f) => f.id === id));
  const out: PlanFinding[] = [];
  if (unknownClaims.length)
    out.push({ code: "module_claims_unknown_feature", severity: "error",
      message: `认领了产品模型里没有的功能：${unknownClaims.slice(0, 6).join(" ")}` });
  if (!orphans.length) return out;
  const by = [...new Set(orphans.map((f) => f.moduleId ?? "（无）"))];
  /**
   * **一个功能都没接住 = 这不是重新切树，是断了线**，所以是 error 不是 warn。
   * 2026-09-12 实测：模型换了一套模块 id，21 个功能全成孤儿，机检只记了一条 warn，
   * 我冻结时把它当普通提示放过去了——结果每个故事单元 `features=0 / rules=0`，
   * 领域规则整份没流到下游，而故事看上去仍然「写出来了」。
   */
  out.push({ code: orphans.length === features.length ? "module_tree_drops_all_features" : "module_tree_drops_features",
    severity: orphans.length === features.length ? "error" : "warn",
    message: `${orphans.length}/${features.length} 个功能没有任何模块认领（原属 ${by.slice(0, 6).join(" ")}${by.length > 6 ? " …" : ""}）：按这棵树切单元时，它们不会进入任何单元的材料。换了模块 id 就在每个模块上写 featureIds 重新认领` });
  return out;
}

/** 提议一棵模块树。有 error 就整份拒收，和单元写入同一个口径：说清是哪一条、错在哪。 */
export function writeModulePlan(runId: string, projectId: string, raw: unknown) {
  const l = store();
  l.requireRun(runId, projectId);
  requireStageStarted(runId, projectId, "modules");
  const prior = receiptOf(runId);
  if (prior?.frozen) throw new LedgerError(409, "module_plan_frozen");
  const parsed = ModulePlanSchema.safeParse(typeof raw === "string" ? JSON.parse(raw) : raw);
  if (!parsed.success) {
    const errors = parsed.error.issues.slice(0, 20).map((i) => ({ code: "schema", jsonPointer: "/" + i.path.join("/"), message: i.message }));
    stageEvent(runId, projectId, "modules", "blocked", `schema · ${errors.length}`);
    return { status: "blocked" as const, gate: "schema" as const, errors };
  }

  const sections = materialSections(runId, projectId);
  /**
   * 提议阶段**没有故事**，所以扇出查不了——那一条要等 stories 合并之后才有意义。
   * 查不了的东西不装作查过：这里只查树本身与材料覆盖。
   */
  const findings = checkModulePlan({ modules: parsed.data.modules as ModuleProposal[], sections, outOfScope: parsed.data.outOfScope });
  findings.push(...droppedFeatures(runId, projectId, parsed.data.modules.map((m) => m.id), parsed.data.modules as ModuleProposal[]));
  const errors = findings.filter((f) => f.severity === "error");
  if (errors.length) {
    stageEvent(runId, projectId, "modules", "blocked", `module-plan · ${errors.length}`);
    return { status: "blocked" as const, gate: "module-plan" as const, findings,
      errors: errors.map((f) => ({ code: f.code, jsonPointer: f.moduleId ? `/modules/${f.moduleId}` : `/${f.sectionId ?? ""}`, message: f.message })) };
  }

  const revision = l.putRevision({ runId, projectId, name: "validated/modules", kind: "report",
    content: { ...parsed.data, findings, sections }, sourceRefs: [...new Set([...l.requireRun(runId,projectId).binding.materialRevisions,...l.listRevisions(projectId,runId).filter(r=>r.name==="product/model-candidate"||r.name==="exploration/report").map(r=>r.id)])], parentRevision: prior?.revisionId ?? null },
    { kind: "system", id: "stage-validator" });
  l.db.prepare(`INSERT INTO run_stage_receipts VALUES (?,?,?,?) ON CONFLICT(runId,stage)
    DO UPDATE SET revisionId=excluded.revisionId, json=excluded.json`)
    .run(runId, "modules", revision.id, JSON.stringify({ revisionId: revision.id, frozen: false, findings: findings.length }));
  // 提议过了机检还不算这个节点做完——要等人冻结，所以停在 waiting_review。
  stageEvent(runId, projectId, "modules", "waiting_review", undefined, revision.id);
  return { status: "validated" as const, revisionId: revision.id, modules: parsed.data.modules.length, findings, revision };
}

/**
 * 冻结。**这一步必须是人**，理由和 gold 一样：这棵树的价值来自有人认过它。
 *
 * 冻结之后 `planUnits` 按它切单元；再改就是新的一版，要先解冻或开新 run。
 * warning 不拦冻结——机检判不了「切得对不对」，拦下去只会让人学会绕过它；
 * 但未处理的 warning 会随冻结一起记进回执，谁冻的、冻的时候还剩几条，都留痕。
 */
/**
 * 冻结这棵树。**只有人能按**，而「人」这一层在本机是免身份验证的（`reviewerPrincipal`），
 * 于是账本里所有冻结都长得一样：`frozenBy: local-operator`。
 *
 * 2026-09-16 实测：Hyperliquid 那一跑的冻结是 Claude 按用户当轮授权代按的，而事后
 * 从账本上**看不出人按还是代理代按**——两者写进去的是同一行字。`note` 就是为这件事加的：
 * 代按的人把「谁授权、代谁按」写进来，审计才追得回去。不写也能冻（本人按就是常态），
 * 但写了就留得下。
 */
export function freezeModulePlan(runId: string, projectId: string, actor: Principal, note?: string) {
  if (actor.kind !== "human") throw new LedgerError(403, "module_plan_freeze_requires_human");
  const l = store();
  l.requireRun(runId, projectId);
  const r = receiptOf(runId);
  if (!r) throw new LedgerError(409, "modules_required");
  if (r.frozen) return { frozen: true, revisionId: r.revisionId, alreadyFrozen: true };
  const content = l.readRevision(r.revisionId, projectId).content as { findings?: PlanFinding[] };
  const open = (content.findings ?? []).filter((f) => f.severity !== "error");
  const value = { revisionId: r.revisionId, frozen: true, findings: (content.findings ?? []).length,
    openFindings: open.length, frozenBy: actor.id, frozenAt: new Date().toISOString(),
    ...(note?.trim() ? { frozenNote: note.trim().slice(0, 2000) } : {}) };
  l.db.prepare("UPDATE run_stage_receipts SET json=? WHERE runId=? AND stage='modules'").run(JSON.stringify(value), runId);
  stageEvent(runId, projectId, "modules", "done", open.length ? `frozen with ${open.length} open findings` : undefined, r.revisionId);
  return { frozen: true, revisionId: r.revisionId, openFindings: open.length, openCodes: [...new Set(open.map((f) => f.code))] };
}

export function modulePlanState(runId: string, projectId: string) {
  const r = receiptOf(runId);
  if (!r) return { exists: false as const };
  const content = runLedger().readRevision(r.revisionId, projectId).content as ModulePlan & { findings?: PlanFinding[] };
  // 谁按的、什么时候、代按的说明，一并回出去：界面与审计此前只看得到一个 frozen 布尔值。
  return { exists: true as const, frozen: !!r.frozen, revisionId: r.revisionId,
    ...(r.frozenBy ? { frozenBy: r.frozenBy } : {}), ...(r.frozenAt ? { frozenAt: r.frozenAt } : {}),
    ...(r.frozenNote ? { frozenNote: r.frozenNote } : {}),
    modules: content.modules.length, outOfScope: content.outOfScope?.length ?? 0, findings: content.findings ?? [] };
}

/** 冻结过的模块树；没冻结就返回 undefined，调用方回落到规则包里那一棵。 */
export function frozenModules(runId: string, projectId: string): ModuleProposal[] | undefined {
  const r = receiptOf(runId);
  if (!r?.frozen) return undefined;
  const content = runLedger().readRevision(r.revisionId, projectId).content as ModulePlan;
  return content.modules as ModuleProposal[];
}
