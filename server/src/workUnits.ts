import { STORY_PLANNING_CONTRACT, storyPlanningIssues } from '@testpilot/harness-testing/casegen';
import { boundDomainReference } from "./domainReferences.js";
import { randomUUID } from "node:crypto";
import { acceptanceIndex } from "./acceptanceIndex.js";
import { z } from "zod";
import { canonicalJSON } from "@testpilot/harness-core/run-contracts";
import { StorySchema, TextCaseSchema, checkDesignEvidence, checkProvenance, type Story, type StoryBundle, type TextCase, type SpecModule } from "@testpilot/harness-testing/casegen";
import { checkModulePlan, ContextManifestSchema, ProductModelSchema, validateRulePack, type ContextManifest, type ProductModel, type ProductRulePack } from "@testpilot/harness-testing/domain";
import { runLedger } from "./runService.js";
import { contentHash, LedgerError } from "./runLedger.js";
import { requireStageStarted } from "./workflowControls.js";
/** 门禁的负例下限（`casegen/gate.ts` 的 `minNegativeRatio` 默认值）——契约里要把它说出来。 */
const MIN_NEGATIVE_RATIO = 0.3;
import { materialSections } from "./moduleStage.js";
import { retrievalChunkCount } from "./runStages.js";
import { writeRunStage } from "./runStages.js";
import { frozenModules, modulePlanState } from "./moduleStage.js";

/**
 * 工作单元（WorkUnit）：把 stories / cases 两个节点从「一次写整份 bundle」拆成
 * 「代码按产品模型拆单元 → 规划器一次只领一个单元 → 服务端逐单元校验 → 全部完成后代码合并」。
 *
 * 循环在这里，不在模型手里：拆分由 `product/model-candidate` 的模块树决定，可复现、可消融；
 * 合并只认稳定 ID；一个单元的写入不会碰到别的单元。宿主 / Penguin 只是叶子。
 *
 * 只对 `parameters.workUnits === 1` 的 run 生效；旧 run 与没有产品模型的 spec run 仍走整份写入。
 */
export const UNIT_NODES = ["stories", "cases"] as const;
export type UnitNode = (typeof UNIT_NODES)[number];
export type UnitStatus = "pending" | "claimed" | "done" | "failed";

export interface WorkUnit {
  runId: string;
  unitId: string;
  node: UnitNode;
  /** 拆分依据：故事单元是模块子树，用例单元是一条故事。 */
  scope: { kind: "module"; moduleIds: string[]; featureIds: string[]; ruleIds: string[] } | { kind: "journeys"; moduleIds: string[] } | { kind: "story"; storyId: string; featureIds: string[]; ruleIds: string[] } | { kind: "all" };
  order: number;
  dependsOn: string[];
  status: UnitStatus;
  attempt: number;
  claimedBy?: string;
  claimedAt?: string;
  manifestId?: string;
  outputRevision?: string;
  reason?: string;
  /**
   * 门禁对这个单元里的用例说了什么（docs/v3/history/23 F-11）。
   *
   * 门禁把整批判为不通过之后，规划器原来拿不到「该改哪几条」——两次实测它都是就地停住。
   * 而门禁其实什么都说了：`scoreBasis.flagged` 是被扣分的用例 id，每条 finding 都带 `caseId`。
   * 缺的只是把这些话按单元分好、送回领单元的那一步。
   */
  repair?: { round: number; cases: Array<{ caseId: string; rule: string; severity: string; message: string }> };
  updatedAt: string;
}

/**
 * 一个单元最多重来几次。
 *
 * 原来没有上限：`claimUnit` 会把 `failed` 的单元一直发回给规划器，`attempt` 只加不判，
 * 唯一的止损是 run 预算跑完。写测试时当场撞上一次死循环（F-8）。
 * 5 次是「够改几轮」和「别把预算烧在同一个错上」之间的取值。
 */
export const MAX_UNIT_ATTEMPTS = 5;

function table() {
  const l = runLedger();
  l.db.exec(`CREATE TABLE IF NOT EXISTS run_work_units (
    runId TEXT NOT NULL, unitId TEXT NOT NULL, node TEXT NOT NULL, json TEXT NOT NULL,
    PRIMARY KEY(runId, unitId))`);
  return l;
}
const load = (runId: string, node?: UnitNode): WorkUnit[] =>
  (table().db.prepare(`SELECT json FROM run_work_units WHERE runId=?${node ? " AND node=?" : ""} ORDER BY json`).all(...(node ? [runId, node] : [runId])) as Array<{ json: string }>)
    .map((r) => JSON.parse(r.json) as WorkUnit)
    .sort((a, b) => a.order - b.order);
const save = (u: WorkUnit) => {
  u.updatedAt = new Date().toISOString();
  table().db.prepare("INSERT INTO run_work_units VALUES (?,?,?,?) ON CONFLICT(runId,unitId) DO UPDATE SET json=excluded.json").run(u.runId, u.unitId, u.node, JSON.stringify(u));
};

export const unitsEnabled = (runId: string, projectId: string): boolean =>
  runLedger().requireRun(runId, projectId).input.parameters?.workUnits === 1;

function latestByName(runId: string, projectId: string, prefix: string) {
  const l = runLedger();
  const rows = l.listRevisions(projectId, runId).filter((r) => r.name === prefix || r.name.startsWith(prefix));
  const last = rows.sort((a, b) => a.revision - b.revision).at(-1);
  return last ? { revision: last, content: l.readRevision(last.id, projectId).content } : undefined;
}
/**
 * 切单元真正需要的那几样东西。
 *
 * 不是整份 `ProductModel`——那份东西只有跑过探索（`source` 节点）的运行才有。
 * 而切故事单元要的只是**一棵树**：功能、规则、声明、冲突有就用，没有就是空的。
 * 把类型收窄到这五个数组，是为了让「只有冻结的模块树」这种运行也能进单元循环，
 * 而不必在内存里伪造一份 schemaVersion / charterId / summary 俱全的产品模型——
 * 伪造出来的那份迟早会被人当成「这次运行真的有产品模型」。
 */
type UnitBasis = Pick<ProductModel, "modules" | "features" | "ruleBindings" | "claims" | "conflicts"> &
  Partial<Pick<ProductModel, "roles" | "lifecycle">>;

function productModel(runId: string, projectId: string): { model: UnitBasis; revisionId: string } {
  const found = latestByName(runId, projectId, "product/model-candidate");
  if (!found) {
    /**
     * 没有产品模型，但有一棵**人冻结过的**模块树：照样能切单元。
     *
     * 2026-09-12 实测的直接原因（docs/v3/history/24 §12）：这条链路上没跑探索，于是整个 stories 节点
     * 退回「一次调用写完整份」——26 条故事、46 条验收，全部挤在一次 7k token 的可见输出里。
     * 不是模型不想写，是一次答复里写不下。而那棵冻结的树本身就是最好的切分依据。
     */
    const frozen = frozenModules(runId, projectId);
    const receipt = latestByName(runId, projectId, "validated/modules");
    if (!frozen?.length || !receipt) throw new LedgerError(409, "work_units_require_product_model");
    return {
      model: { modules: frozen.map((m) => ({ id: m.id, name: m.name ?? m.id, parentId: m.parentId ?? null })) as ProductModel["modules"],
        features: [], ruleBindings: [], claims: [], conflicts: [] },
      revisionId: receipt.revision.id,
    };
  }
  const model = ProductModelSchema.parse(found.content);
  /**
   * **冻结过的模块树压过规则包里那一棵。**
   *
   * 在此之前模块树只能是 `pack.modules`——人手写在规则包里，模型一个字没参与，
   * 于是「产品模块规划」这件事在流程里根本不存在（docs/v3/history/24 §0）。现在 `modules`
   * 节点可以提议一棵、由人冻结；冻结了就按它切单元，没冻结就照旧回落到规则包。
   *
   * 只换 `modules`，不动 `features` 与 `ruleBindings`：功能与规则的归属仍由规则包说了算，
   * 模块树改的是**怎么分组**，不是**有哪些东西**。改了分组之后 feature 的 moduleId
   * 可能指向一个不存在的模块，那种情况在下面 planUnits 里会表现为某个单元没有功能——
   * 所以冻结前的机检要保证树能装下所有 feature 的 moduleId。
   */
  const frozen = frozenModules(runId, projectId);
  if (!frozen?.length) return { model, revisionId: found.revision.id };
  return {
    model: { ...model, modules: frozen.map((m) => ({ id: m.id, name: m.name ?? m.id, parentId: m.parentId ?? null })) } as UnitBasis,
    revisionId: found.revision.id,
  };
}
function rulePack(runId: string, projectId: string): { pack: ProductRulePack; revisionId: string; hash: string } | undefined {
  const found = latestByName(runId, projectId, "knowledge/rulepack/");
  if (!found) return undefined;
  const v = validateRulePack((found.content as { rulePack?: unknown }).rulePack);
  if (!v.ok) throw new LedgerError(409, "bound_rule_pack_invalid");
  return { pack: v.pack, revisionId: found.revision.id, hash: v.hash };
}
const subtree = (model: Pick<ProductModel, "modules">, rootId: string): string[] => {
  const out = [rootId];
  for (let i = 0; i < out.length; i++) for (const m of model.modules) if (m.parentId === out[i] && !out.includes(m.id)) out.push(m.id);
  return out;
};

/** 拆单元。幂等：已经拆过就原样返回。 */
export function planUnits(runId: string, projectId: string, node: UnitNode): WorkUnit[] {
  if (!unitsEnabled(runId, projectId)) throw new LedgerError(409, "work_units_disabled_for_run");
  const existing = load(runId, node);
  if (existing.length) return existing;
  const now = new Date().toISOString();
  const units: WorkUnit[] = [];
  if (node === "stories") {
    /**
     * 故事是导入的（`importStories`）——这一节点没有单元可拆。
     *
     * 单节点对照要求两条臂领到**同一批用例单元**，而用例单元是按 `validated/stories`
     * 一条故事一条拆的。导入之后再让规划器写一遍故事，单元名和范围就又各走各的，
     * 后面比的不是同一件事。返回空集：claimUnit 会直接说这一节点没东西可领。
     */
    if (latestByName(runId, projectId, "validated/stories")) return [];
    /**
     * **提议了却没冻结的树，不许被绕过去。**
     *
     * `productModel()` 在没冻结时回落到规则包那棵——对**从来没提议过**的旧 run 这是对的，
     * 但对刚提议完的 run 就不是了：规划器会拿着自己刚写的那棵树的印象，去领按另一棵树切的单元，
     * 而且一路不报错。人还没看过的树不生效，是这个节点的全部意义；那就得说出来，不能默默换一棵。
     */
    const plan = modulePlanState(runId, projectId);
    if (plan.exists && !plan.frozen) throw new LedgerError(409, "module_plan_freeze_required");
    const { model } = productModel(runId, projectId);
    const roots = model.modules.filter((m) => !m.parentId);
    /**
     * 冻结的树自己认领的功能优先（`featureIds`），认领了就按它算。
     * 树被重新切过时，功能挂的还是上一棵树的模块 id——不认这份认领，
     * 每个单元就是 `features=0 / rules=0`，领域规则整份流不到下游（2026-09-12 实测）。
     */
    const frozen = frozenModules(runId, projectId) ?? [];
    const claimsOf = (ids: string[]): string[] => [...new Set(frozen.filter((m) => ids.includes(m.id)).flatMap((m) => m.featureIds ?? []))];
    roots.forEach((root, i) => {
      const moduleIds = subtree(model, root.id);
      const claimed = claimsOf(moduleIds);
      const features = claimed.length
        ? model.features.filter((f) => claimed.includes(f.id))
        : model.features.filter((f) => moduleIds.includes(f.moduleId));
      units.push({ runId, unitId: `stories:${root.id}`, node, scope: { kind: "module", moduleIds, featureIds: features.map((f) => f.id), ruleIds: [...new Set(features.flatMap((f) => f.ruleIds))] }, order: i, dependsOn: [], status: "pending", attempt: 0, updatedAt: now });
    });
    // 跨模块旅程最后做：它需要各模块故事的索引，只拿 ID 和标题，不拿正文。
    if (roots.length > 1)
      units.push({ runId, unitId: "stories:journeys", node, scope: { kind: "journeys", moduleIds: roots.map((r) => r.id) }, order: roots.length, dependsOn: units.map((u) => u.unitId), status: "pending", attempt: 0, updatedAt: now });
  } else {
    const stories = latestByName(runId, projectId, "validated/stories");
    if (!stories) throw new LedgerError(409, "stories_required");
    const { model } = productModel(runId, projectId);
    const all = (stories.content as StoryBundle).stories;
    /**
     * **被覆盖的故事不单独出单元。**
     *
     * 见 `StorySchema.subsumes` 上的注释：一条走完就顺带走完了几条短故事的长故事，
     * 应该把那几条的验收准则收进自己的用例里当路上的断言，而不是让每条短故事
     * 各自长出一个「打开页面 + 看一眼」的两步用例。
     *
     * 这里是这件事真正生效的地方——少一个单元，就少一批短用例。
     * 覆盖方的单元材料里会带上被覆盖故事的验收准则（见 `unitMaterials` 的 `subsumed`）。
     */
    const subsumedBy = new Map<string, string>();
    for (const s of all) for (const id of s.subsumes ?? []) if (id !== s.id && all.some((x) => x.id === id)) subsumedBy.set(id, s.id);
    all.filter((s) => !subsumedBy.has(s.id)).forEach((s, i) => {
      const featureIds = s.featureRefs?.length ? s.featureRefs : model.features.filter((f) => s.moduleIds?.includes(f.moduleId)).map((f) => f.id);
      /**
       * 范围里也要放**故事自己声明的规则**。
       *
       * 原来只按 featureRefs 反推：一条故事写了 `ruleRefs: ["R-SUBMIT-SIDE-EFFECT"]`
       * （「整条旅程停在提交之前」），却因为 featureRefs 里没有 `order.submit`，
       * 这条 P0 规则被判成 out of scope——用例引用它会被拒。**一条故事无法为自己
       * 声明的规则写用例**，这不是隔离，是把故事的意图丢掉了。
       *
       * 仍然只认产品模型里存在的规则 id：故事写错的 id 不会因此混进范围。
       */
      const known = new Set(model.features.flatMap((f) => f.ruleIds));
      const ruleIds = [...new Set([
        ...model.features.filter((f) => featureIds.includes(f.id)).flatMap((f) => f.ruleIds),
        ...(s.ruleRefs ?? []).filter((r) => known.has(r)),
      ])];
      units.push({ runId, unitId: `cases:${s.id}`, node, scope: { kind: "story", storyId: s.id, featureIds, ruleIds }, order: i, dependsOn: [], status: "pending", attempt: 0, updatedAt: now });
    });
  }
  for (const u of units) save(u);
  return units;
}

export function unitStatus(runId: string, projectId: string, node?: UnitNode) {
  runLedger().requireRun(runId, projectId);
  const units = load(runId, node);
  const count = (s: UnitStatus) => units.filter((u) => u.status === s).length;
  return { enabled: unitsEnabled(runId, projectId), units: units.map(({ runId: _r, ...u }) => u), summary: { total: units.length, pending: count("pending"), claimed: count("claimed"), done: count("done"), failed: count("failed") } };
}

/** 一个单元的材料：只给这个范围的功能 / 规则 / 观察，其他模块只有 ID 索引。 */
export function unitMaterials(runId: string, projectId: string, unit: WorkUnit) {
  const { model, revisionId } = productModel(runId, projectId);
  const pack = rulePack(runId, projectId);
  const report = latestByName(runId, projectId, "exploration/report")?.content as { observations?: Array<{ id: string; stateBefore?: string; stateAfter?: string; evidenceRefs?: string[]; action?: unknown; controlsAfter?: string[]; targetSpecId: string; featureId: string; status: string; reason?: string; effect?: { controlsAdded: string[]; stateChanged: string[]; textAdded: string[] } }>; plannedTargets?: Array<{ targetSpecId: string; featureId: string; status: string; reason?: string }> } | undefined;
  const featureIds = unit.scope.kind === "module" || unit.scope.kind === "story" ? unit.scope.featureIds : model.features.map((f) => f.id);
  const ruleIds = unit.scope.kind === "module" || unit.scope.kind === "story" ? unit.scope.ruleIds : model.ruleBindings.map((b) => b.ruleId);
  const features = model.features.filter((f) => featureIds.includes(f.id)).map((f) => ({ id: f.id, moduleId: f.moduleId, name: f.name, applicability: f.applicability, verification: f.verification, verificationReason: f.verificationReason, ruleIds: f.ruleIds, claims: model.claims.filter((c) => f.claimIds.includes(c.id)).map((c) => ({ id: c.id, claimType: c.claimType, statement: c.statement, support: c.support, sourceRefs: c.sourceRefs })) }));
  const rules = (pack?.pack.rules ?? []).filter((r) => ruleIds.includes(r.id)).map((r) => ({ id: r.id, featureIds: r.featureIds, claimType: r.claimType, statement: r.statement, appliesWhen: r.appliesWhen, riskFloor: r.riskFloor, unit: r.unit, constants: r.constants, verification: r.verification, sourceRefs: r.sourceRefs, binding: model.ruleBindings.find((b) => b.ruleId === r.id)?.status }));
  const observations = (report?.observations ?? []).filter((o) => featureIds.includes(o.featureId)).map((o) => ({ id: o.id, stateBefore:o.stateBefore,stateAfter:o.stateAfter,evidenceRefs:o.evidenceRefs,action:o.action,controlsAfter:o.controlsAfter, targetSpecId: o.targetSpecId, featureId: o.featureId, status: o.status, reason: o.reason, effect: o.effect ? { controlsAdded: o.effect.controlsAdded, stateChanged: o.effect.stateChanged, textAdded: o.effect.textAdded } : undefined }));
  /**
   * 模块表带上冻结树自己认领的功能（`featureIds`）——单元契约要按它算「这个叶子该写几条故事」。
   * 产品模型里的模块没有这个字段：功能挂在模块上是反过来的（`feature.moduleId`），
   * 而树被重新切过之后那条关系指的是上一棵树。
   */
  const claims = new Map((frozenModules(runId, projectId) ?? []).map((m) => [m.id, m.featureIds ?? []]));
  const withClaims = model.modules.map((m) => ({ ...m, featureIds: claims.get(m.id) ?? [] }));
  const modules = unit.scope.kind === "module" ? withClaims.filter((m) => unit.scope.kind === "module" && unit.scope.moduleIds.includes(m.id)) : withClaims;
  const storyIndex = unit.scope.kind === "journeys" || unit.scope.kind === "story"
    ? load(runId, "stories").filter((u) => u.status === "done" && u.outputRevision).flatMap((u) => ((runLedger().readRevision(u.outputRevision!, projectId).content as { stories: Story[] }).stories).map((s) => ({ id: s.id, title: s.title, moduleIds: s.moduleIds ?? [], featureRefs: s.featureRefs })))
    : [];
  const allStories = unit.scope.kind === "story" ? (latestByName(runId, projectId, "validated/stories")!.content as StoryBundle).stories : [];
  const story = unit.scope.kind === "story" ? allStories.find((s) => s.id === (unit.scope as { storyId: string }).storyId) : undefined;
  /**
   * 这条故事**覆盖**的那几条短故事，连同它们的验收准则一起交出去。
   *
   * 被覆盖的故事不再有自己的单元（`planUnits`），所以它们的准则必须在这里出现——
   * 否则那几条准则就从流水线上消失了，而「不单独出单元」会从「收进长用例里」
   * 退化成「干脆不测」。
   */
  const subsumed = (story?.subsumes ?? []).flatMap((id) => allStories.filter((x) => x.id === id));
  const sources = pack?.pack.sources.filter((s) => rules.some((r) => r.sourceRefs.includes(s.id))) ?? [];
  /**
   * 角色与生命周期跟着单元一起发下去（2026-09-12）。
   *
   * 不发的话，规划器只能自己编一个角色——实测一次运行 26 条故事，`role` 全是同一个词；
   * 优先级也只能靠感觉，因为它手上没有「主链是哪几段」这个事实。
   * 只发和这个单元有关的那几段生命周期，加上全部角色（角色是全局的，就那么几个）。
   */
  const lifecycle = (model.lifecycle ?? []).filter((l) => !l.featureIds.length || l.featureIds.some((f) => featureIds.includes(f)));
  return { domainReference: boundDomainReference(runId, projectId), actionVocabulary: pack?.pack.actionVocabulary ?? [], volatileReadings: pack?.pack.volatileReadings ?? [], productModelRevision: revisionId, rulePack: pack ? { id: pack.pack.id, version: pack.pack.version, hash: pack.hash, revision: pack.revisionId } : undefined, modules, features, rules, sources, observations, storyIndex, story, subsumed, roles: model.roles ?? [], lifecycle, conflicts: model.conflicts.filter((c) => featureIds.includes(c.featureId)) };
}

function manifestFor(runId: string, projectId: string, unit: WorkUnit, materials: ReturnType<typeof unitMaterials>, claimedBy: string): ContextManifest {
  const run = runLedger().requireRun(runId, projectId);
  const isolation = run.binding.models.entry === "host" ? "host-best-effort" : "service-scoped";
  return ContextManifestSchema.parse({
    schemaVersion: "context-manifest.v2", manifestId: `ctx-${runId}-${unit.unitId}-${unit.attempt}`, projectId, runId, node: unit.node, attempt: unit.attempt,
    role: { id: unit.node === "stories" ? "story-analyst" : "test-designer", version: "1" },
    skills: [], knowledge: materials.rulePack ? [{ packId: materials.rulePack.id, revision: materials.rulePack.revision, hash: materials.rulePack.hash, ruleIds: materials.rules.map((r) => r.id), purpose: unit.node === "stories" ? "story acceptance basis" : "expected behavior" }] : [],
    inputs: [{ revision: materials.productModelRevision, pointer: unit.scope.kind === "module" ? `/modules/${unit.scope.moduleIds[0]}` : unit.scope.kind === "story" ? `/stories/${unit.scope.storyId}` : "/journeys", digest: contentHash(canonicalJSON({ features: materials.features.map((f) => f.id), rules: materials.rules.map((r) => r.id) })) }],
    toolGrants: ["retrieve_spec", "write_unit"], budget: { inputChars: JSON.stringify(materials).length },
    truncation: { omittedOptionalRefs: [], missingRequiredRefs: materials.rulePack ? [] : ["rule-pack"] }, isolationEvidence: isolation,
  });
}

/** 领一个单元：第一个依赖已满足的 pending 单元。没有了返回 null，表示该合并。 */
export function claimUnit(runId: string, projectId: string, raw: unknown, claimedBy = "planner") {
  const { node } = z.object({ node: z.enum(UNIT_NODES) }).parse(raw);
  requireStageStarted(runId, projectId, node);
  return table().db.transaction(() => {
    const units = planUnits(runId, projectId, node);
    const doneIds = new Set(units.filter((u) => u.status === "done").map((u) => u.unitId));
    // 已领未写的单元重新领（同一个规划器重试）；不并发。
    const next = units.find((u) => (u.status === "pending" || u.status === "claimed" || u.status === "failed")
      && u.attempt < MAX_UNIT_ATTEMPTS && u.dependsOn.every((d) => doneIds.has(d)));
    if (!next) {
      const stuck = units.filter((u) => u.status !== "done" && u.attempt >= MAX_UNIT_ATTEMPTS);
      return { unit: null, remaining: units.filter((u) => u.status !== "done").length, summary: unitStatus(runId, projectId, node).summary,
        instruction: units.every((u) => u.status === "done")
          ? "All units are done: the server merges them; call gate_run next (stories: call claim_unit with node=cases)."
          : stuck.length
            ? `Gave up on ${stuck.length} unit(s) after ${MAX_UNIT_ATTEMPTS} attempts each — ${stuck.map((u) => `${u.unitId}: ${u.reason ?? "unknown"}`).join("; ")}. A person has to look at these; retrying the same write again will not help.`
            : "Remaining units are blocked by failed dependencies." };
    }
    next.status = "claimed"; next.attempt += 1; next.claimedBy = claimedBy; next.claimedAt = new Date().toISOString();
    const materials = unitMaterials(runId, projectId, next);
    const manifest = manifestFor(runId, projectId, next, materials, claimedBy);
    next.manifestId = manifest.manifestId;
    const manifestName='context/'+next.node+'/'+manifest.manifestId;
    const priorManifest=runLedger().listRevisions(projectId,runId).filter(r=>r.name===manifestName).at(-1);
    runLedger().putRevision({runId,projectId,name:manifestName,kind:'report',content:manifest,sourceRefs:manifest.knowledge.map(k=>k.revision),parentRevision:priorManifest?.id??null},{kind:'system',id:'context-recorder'});

    save(next);
    const contract = unitContract(next, materials.modules, materials.features, materials.story, materials.subsumed, materials.actionVocabulary);
    /**
     * **整跑不变的东西不随每个单元重发。**
     *
     * 2026-09-16 实测：40 个单元的 `claim_unit` 返回合计 110 万字符，其中 `domainReference`
     * 40 次完全相同（16.8 万）、`storyIndex` 只有两种取值（17.2 万）。它们每一轮都进
     * `cache_read`——那一跑 7,780 万 token 缓存读、$36，而 output 只有 3,200 token。
     *
     * **但第一版剔多了，当天就量出了代价。** 同项目、同 16 个模块、同一份 9 词词表的 A/B：
     * 动作型验收准则从 74/115（64.3%）掉到 49/130（37.7%），`checkStories` 的
     * `story_has_no_actionable_criterion` 从 0 条变 5 条，逐模块看多数模块都降
     * （提交与挂单管理 11/12 → 7/13，持仓与风控 7/13 → 2/11）。故事从写「用户做什么」
     * 漂成写「屏幕上有什么」——而词表（下单/撤单/平仓/转账…）既是判定动作型的那把尺，
     * 也是模型写单元时眼前唯一的动词来源。**把词表从眼前拿走，它就不写动作了。**
     *
     * 所以只剔大的：`domainReference` 一个字段占被剔总量的 91.5%（4,207 / 4,598 字符），
     * 其余四样合计 391 字符——40 个单元也才 1.6 万，放回去等于不要钱。
     *
     * `storyIndex` 例外：它按节点固定（stories 阶段为空，cases 阶段一份），
     * 所以只在这个节点的**第一个**单元发一次。
     */
    const firstOfNode = units.every((u) => u.unitId === next.unitId || u.status === "pending");
    const { domainReference: _dr, productModelRevision: _pm, storyIndex, ...perUnit } = materials;
    const slim = { ...perUnit, ...(firstOfNode && storyIndex.length ? { storyIndex } : {}) };
    return { unit: { ...next, runId: undefined }, manifest, materials: slim, contract,
      runScope: "领域参考全文在 load_run_instructions() 的 runScope 里，整跑发一次；这里不重发。词表、易变读数、角色、规则包照常随每个单元发。",
      ...(next.repair ? { repair: repairBrief(next.repair) } : {}),
      remaining: units.filter((u) => u.status !== "done").length - 1 };
  })();
}

/**
 * 故事单元的写入可以带 `moduleAmendments`：**只提议，不生效**（docs/v3/history/24 §6.4）。
 *
 * 模块树冻结之后故事节点碰不得它，于是会出现「一条故事装不下、模型默默挂到最近的模块上」——
 * 那条挂错的边没人看得见。这个出口不改变本次拆分、不进 validated/stories，
 * 只落成一条提案给人冻结下一版时看。**关键不是让模型改树，是让它把装不下这件事说出来。**
 */
const ModuleAmendmentSchema = z.object({
  kind: z.enum(["missing-module", "move-feature", "split-module", "merge-modules"]),
  reason: z.string().min(1).max(2000),
  storyId: z.string().min(1).optional(),
  featureId: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  evidence: z.array(z.string().min(1)).default([]),
}).strict();
const UnitStoriesSchema = z.object({
  stories: z.array(StorySchema).min(1),
  moduleAmendments: z.array(ModuleAmendmentSchema).max(20).default([]),
});
const UnitCasesSchema = z.object({ cases: z.array(TextCaseSchema).min(1) });

/** 写一个单元。校验只针对这个单元的范围；全部完成后自动合并成 validated/<node>。 */
/**
 * 规划器用 `null` 表示「这个可选字段不适用」——而 zod 的 `.optional()` 只接受缺席。
 *
 * 2026-09-11 单节点对照连着撞了两次：`testData.fixtureRef: null`、`oracle.body: null`，
 * 整条用例因此过不了 schema。这不是「编了一个值」，是「说了没有」，两者在这里必须
 * 区别对待：显式的 null 等同于没写，去掉它比让整条产出作废诚实。
 *
 * 只去掉**恰好是 null** 的键，别的一概不动。
 */
function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropNulls) as unknown as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)])) as T;
  return value;
}

export function writeUnit(runId: string, projectId: string, raw: unknown) {
  const { unitId, content } = z.object({ unitId: z.string().min(1), content: z.unknown() }).parse(dropNulls(raw));
  const units = load(runId);
  const unit = units.find((u) => u.unitId === unitId);
  if (!unit) throw new LedgerError(404, "unit_not_found");
  requireStageStarted(runId, projectId, unit.node);
  if (unit.status !== "claimed") throw new LedgerError(409, `unit_not_claimed:${unit.status}`);
  const materials = unitMaterials(runId, projectId, unit);
  const featureIds = new Set(materials.features.map((f) => f.id));
  const ruleIds = new Set(materials.rules.map((r) => r.id));
  const errors: Array<{ code: string; jsonPointer: string; message: string }> = [];
  let payload: unknown;
  if (unit.node === "stories") {
    const parsed = UnitStoriesSchema.safeParse(typeof content === "string" ? JSON.parse(content) : content);
    if (!parsed.success) return { status: "blocked", gate: "schema", errors: parsed.error.issues.slice(0, 20).map((i) => ({ code: "schema", jsonPointer: "/" + i.path.join("/"), message: i.message })) };
    errors.push(...storyPlanningIssues(parsed.data.stories));
    const otherIds = new Set(units.filter((u) => u.node === "stories" && u.unitId !== unitId && u.outputRevision).flatMap((u) => ((runLedger().readRevision(u.outputRevision!, projectId).content as { stories: Story[] }).stories).map((s) => s.id)));
    // 每份材料有多少段：判据里的 `file.md#N` 要对得上，见下面 acceptance_cites_missing_section。
    const sectionCounts = new Map<string, number>();
    for (const id of materialSections(runId, projectId)) {
      const [name, n] = id.split("#");
      if (name && n) sectionCounts.set(name, Math.max(sectionCounts.get(name) ?? 0, Number(n)));
    }
    // 检索块的编号空间（见上）：`retrieve_spec` 把材料切成这么多块，块 id 也写作 file.md#N。
    const retrievalChunks = retrievalChunkCount(runId, projectId);
    const allowedModules = unit.scope.kind === "module" ? new Set(unit.scope.moduleIds) : unit.scope.kind === "journeys" ? new Set(materials.modules.map((m) => m.id)) : undefined;
    parsed.data.stories.forEach((s, i) => {
      if (otherIds.has(s.id)) errors.push({ code: "duplicate_story_id_across_units", jsonPointer: `/stories/${i}/id`, message: s.id });
      if (!s.moduleIds?.length) errors.push({ code: "story_without_module", jsonPointer: `/stories/${i}/moduleIds`, message: s.id });
      for (const m of s.moduleIds ?? []) if (allowedModules && !allowedModules.has(m)) errors.push({ code: "module_out_of_unit_scope", jsonPointer: `/stories/${i}/moduleIds`, message: m });
      if (unit.scope.kind === "journeys" && new Set((s.moduleIds ?? []).map((m) => materials.modules.find((x) => x.id === m)?.parentId ?? m)).size < 2) errors.push({ code: "journey_needs_two_modules", jsonPointer: `/stories/${i}/moduleIds`, message: s.id });
      for (const f of s.featureRefs ?? []) if (!featureIds.has(f)) errors.push({ code: "feature_out_of_unit_scope", jsonPointer: `/stories/${i}/featureRefs`, message: f });
      for (const r of s.ruleRefs ?? []) if (!ruleIds.has(r)) errors.push({ code: "rule_out_of_unit_scope", jsonPointer: `/stories/${i}/ruleRefs`, message: r });
      const exploration = latestByName(runId, projectId, "exploration/report")?.content as { observations?: Array<{id:string;featureId:string}> } | undefined;
      const linked = new Set<number>();
      for (const link of s.observationLinks ?? []) {
        if (linked.has(link.acceptanceIndex) || link.acceptanceIndex >= s.acceptance.length) errors.push({code:'invalid_acceptance_link',jsonPointer:`/stories/${i}/observationLinks`,message:s.id});
        linked.add(link.acceptanceIndex);
        if (link.status !== 'unobserved' && !link.observationIds.length) errors.push({code:'observation_evidence_required',jsonPointer:`/stories/${i}/observationLinks`,message:s.id});
        for (const id of link.observationIds) if (!exploration?.observations?.some(o=>o.id===id && s.featureRefs?.includes(o.featureId))) errors.push({code:'unknown_observation_reference',jsonPointer:`/stories/${i}/observationLinks`,message:id});
      }
      if (!s.acceptance.length) errors.push({ code: "story_without_acceptance", jsonPointer: `/stories/${i}/acceptance`, message: s.id });
      /**
       * 判据里的出处要**真的存在**（2026-09-13）。
       *
       * 契约要求每条判据以 `（依据 <file>.md#N）` 收尾，「说不出出处的判据是猜的」，
       * 而服务端从来没核对过那个 N——模块节点核对 `evidence`，故事节点不核对。
       *
       * **但 `file.md#N` 有两套编号，写法一模一样**：材料分节（`##` / `=====` 数出来的，
       * 这份材料是 1..24）和 `retrieve_spec` 返回的检索块（1..50）。
       * 我第一版只比对了分节数，于是把合法的 `exploration.md#35`（第 35 个检索块）
       * 判成了「引了不存在的段」——**误伤**。所以这里取两者的上界：
       * 只有两套编号都容不下的号才是真的不存在。
       * 两套编号共用一个写法这件事本身是设计债，记在 docs/v3/history/24 §33。
       */
      for (const [j, a] of s.acceptance.entries())
        for (const m of String(a).matchAll(/([\w.-]+\.md)#(\d+)/g)) {
          const total = sectionCounts.get(m[1]!);
          if (total !== undefined && Number(m[2]) > Math.max(total, retrievalChunks))
            errors.push({ code: "acceptance_cites_missing_section", jsonPointer: `/stories/${i}/acceptance/${j}`,
              message: `${s.id} 引了 ${m[0]}，而 ${m[1]} 只有 ${total} 段、检索索引也只有 ${retrievalChunks} 块` });
        }
      if (!s.role || !s.benefit) errors.push({ code: "story_without_role_or_benefit", jsonPointer: `/stories/${i}`, message: s.id });
      /**
       * 角色要**认领**包里写好的那几个，不能现编（2026-09-12）。
       * 实测 26 条故事的 role 全是同一个词——那不是角色，是个口头禅。
       * 包里没声明角色时这条不生效：通用产品不该被逼着先写角色表。
       */
      if (materials.roles.length && s.role && !materials.roles.some((r) => r.id === s.role || r.name === s.role))
        errors.push({ code: "story_role_not_declared", jsonPointer: `/stories/${i}/role`,
          message: `${s.role} 不在规则包声明的角色里（${materials.roles.map((r) => r.name).join(" / ")}）` });
      /**
       * 有生命周期就必须给优先级，而且 **P0 要说得出压在主链的哪一段**。
       * 「看起来重要」不是判据；「少了它这条链走不完」是。
       * 规则自带 riskFloor P0 的也算——那是领域里已经认领过的风险下限。
       */
      if (materials.lifecycle.length) {
        if (!s.priority) errors.push({ code: "story_without_priority", jsonPointer: `/stories/${i}/priority`, message: s.id });
        if (s.lifecycleId && !materials.lifecycle.some((l) => l.id === s.lifecycleId))
          errors.push({ code: "story_lifecycle_unknown", jsonPointer: `/stories/${i}/lifecycleId`, message: s.lifecycleId });
        const floorP0 = (s.ruleRefs ?? []).some((r) => materials.rules.find((x) => x.id === r)?.riskFloor === "P0");
        if (s.priority === "P0" && !s.lifecycleId && !floorP0)
          errors.push({ code: "p0_without_lifecycle", jsonPointer: `/stories/${i}/priority`,
            message: `${s.id} 判了 P0，却没说它压在生命周期的哪一段，引用的规则也没有 P0 风险下限` });
      }
    });
    if (new Set(parsed.data.stories.map((s) => s.id)).size !== parsed.data.stories.length) errors.push({ code: "duplicate_story_id", jsonPointer: "/stories", message: "ids must be unique" });
    // 提案单独落一条修订，不进故事正文——它不是故事，是对产品事实的意见。
    if (parsed.data.moduleAmendments.length)
      runLedger().putRevision({ runId, projectId, name: `module-amendment/${unitId}`, kind: "report",
        content: { unitId, at: new Date().toISOString(), amendments: parsed.data.moduleAmendments } }, { kind: "agent", id: "planner" });
    payload = { stories: parsed.data.stories };
  } else {
    const parsed = UnitCasesSchema.safeParse(typeof content === "string" ? JSON.parse(content) : content);
    if (!parsed.success) return { status: "blocked", gate: "schema", errors: parsed.error.issues.slice(0, 20).map((i) => ({ code: "schema", jsonPointer: "/" + i.path.join("/"), message: i.message })) };
    const storyId = (unit.scope as { storyId: string }).storyId;
    const acceptanceIds = acceptanceIndex(materials.story ? [materials.story, ...materials.subsumed] : [], materials.actionVocabulary);
    const norm = (x: string) => x.replace(/[\s“”"'（）()、,，。.]/g, "");
    parsed.data.cases.forEach((c, i) => {
      // 覆盖方的用例仍然挂在覆盖方的故事上；被覆盖故事的准则通过 acRefs 引用，不换 storyId。
      if (c.storyId !== storyId) errors.push({ code: "case_story_out_of_unit", jsonPointer: `/cases/${i}/storyId`, message: c.storyId });
      /**
       * **`acRefs` 必须是编号，而且必须是这条故事的编号。**
       *
       * 2026-09-13 实测：85 条 acRefs 里 21 条是模型自己改写的一句话，16 条连 When 都换了。
       * 契约现在把编号连同原文一起交出去（见 `unitContract` 里那段），这里把门关上——
       * 允许自由文本的话，契约说什么都没用。
       *
       * 旧写法（一整句 Given/When/Then 原文）也认：逐字等于某条准则就换成它的编号。
       * 认不出来的就是改写，拒收。
       */
      const acIds = new Set(acceptanceIds.map((e) => e.id));
      for (const [j, r] of (c.acRefs ?? []).entries()) {
        if (acIds.has(r)) continue;
        const verbatim = acceptanceIds.find((e) => norm(e.text) === norm(r));
        if (verbatim) continue;
        errors.push({ code: "acceptance_ref_unknown", jsonPointer: `/cases/${i}/acRefs/${j}`,
          message: `${c.id}: 「${r.slice(0, 40)}」不是 ${storyId} 的验收准则。只能填编号：${acceptanceIds.map((e) => e.id).join(", ") || "（这条故事没有验收准则）"}` });
      }
      for (const f of c.featureRefs ?? []) if (!featureIds.has(f)) errors.push({ code: "feature_out_of_unit_scope", jsonPointer: `/cases/${i}/featureRefs`, message: f });
      for (const r of c.ruleRefs ?? []) if (!ruleIds.has(r)) errors.push({ code: "rule_out_of_unit_scope", jsonPointer: `/cases/${i}/ruleRefs`, message: r });
      const floor = materials.rules.filter((r) => (c.ruleRefs ?? []).includes(r.id)).map((r) => r.riskFloor).filter(Boolean) as string[];
      if (floor.includes("P0") && c.priority && c.priority !== "P0") errors.push({ code: "priority_below_rule_floor", jsonPointer: `/cases/${i}/priority`, message: `${c.id}: rule floor P0` });
    });
    if (new Set(parsed.data.cases.map((c) => c.id)).size !== parsed.data.cases.length) errors.push({ code: "duplicate_case_id", jsonPointer: "/cases", message: "ids must be unique" });
    /**
     * v2 设计证据的交叉校验，在单元这一层就给出来（21 §5）。
     *
     * 合并时 validateCases 也会查一遍，但那时候已经是最后一个单元写完之后——修复范围会跳到
     * 整批，而单元循环存在的意义正是"错在哪一单元就修哪一单元"。
     */
    for (const e of checkDesignEvidence(parsed.data.cases)) errors.push({ code: e.code, jsonPointer: e.jsonPointer.replace("/cases/", "/cases/"), message: `${e.caseId}: ${e.message}` });
    /**
     * **出处也要在单元这一层查。**
     *
     * 2026-09-14 实测（run-cae32c41）：38 个单元、约 80 分钟模型时间全部写完之后，
     * 合并时才报「170 条里 41 条的 sourceRefs 对不上」——修复范围从「一个单元」
     * 跳到「整批」。上面 `checkDesignEvidence` 当初就是因为这个被下放的，`sourceRefs` 漏了。
     *
     * 模型填错的东西很具体：`SRC-OBSERVED-2026-09-11`、`SRC-DOMAIN-REF` ——那是**规则包里
     * 那个同名字段**的值域。规则和用例上都叫 `sourceRefs`，一个指规则包的来源条目，
     * 一个指本次 `retrieve_spec` 返回的 chunk id，而单元材料把规则连同它的 `sourceRefs`
     * 一起交到了模型手上。**同名不同义**，不点破就只能猜。契约里现在把两者并排写清。
     */
    const retrieved = new Set(runLedger().db.prepare("SELECT json FROM run_retrievals WHERE runId=?").all(runId)
      .flatMap((r) => JSON.parse((r as { json: string }).json).chunkIds as string[]));
    if (retrieved.size) {
      const prov = checkProvenance(parsed.data.cases, retrieved);
      for (const u of prov.unknown)
        errors.push({ code: "source_ref_not_retrieved", jsonPointer: `/cases/${parsed.data.cases.findIndex((c) => c.id === u.caseId)}/sourceRefs`,
          message: `${u.caseId}: ${u.refs.slice(0, 4).join(" ")} 不是本次 retrieve_spec 返回过的 chunk id（规则自带的 sourceRefs 是另一个东西，别照抄）` });
      for (const id of prov.unreferenced)
        errors.push({ code: "source_ref_missing", jsonPointer: `/cases/${parsed.data.cases.findIndex((c) => c.id === id)}/sourceRefs`,
          message: `${id}: 一条出处都没写` });
    }
    payload = parsed.data;
  }
  if (errors.length) { unit.status = "failed"; unit.reason = errors.slice(0, 5).map((e) => `${e.code}@${e.jsonPointer}`).join(";"); save(unit); return { status: "blocked", gate: "unit", errors, repairScope: unitId }; }
  const rev = runLedger().putRevision({ runId, projectId, name: `units/${unit.node}/${unitId}`, kind: unit.node, content: payload, sourceRefs: [materials.productModelRevision] }, { kind: "system", id: "unit-validator" });
  unit.status = "done"; unit.outputRevision = rev.id; unit.reason = undefined; save(unit);
  const all = load(runId, unit.node);
  const merged = all.every((u) => u.status === "done") ? mergeUnits(runId, projectId, unit.node) : undefined;
  return { status: "validated", unitId, revisionId: rev.id, remaining: all.filter((u) => u.status !== "done").length, ...(merged ? { merged } : {}) };
}

/** 全部单元完成 → 代码拼成整份 bundle，走原有的整份校验与落盘（同一条 validated/<node> 路径）。 */
export function mergeUnits(runId: string, projectId: string, node: UnitNode) {
  const units = load(runId, node);
  // 故事整份导入的 run 在这一节点没有单元，合并是空操作而不是错误。
  if (!units.length && node === "stories" && latestByName(runId, projectId, "validated/stories"))
    return { status: "validated", file: "stories.json", valid: true, imported: true };
  if (!units.length || units.some((u) => u.status !== "done")) throw new LedgerError(409, "units_incomplete");
  const outputs = units.map((u) => runLedger().readRevision(u.outputRevision!, projectId).content as { stories?: Story[]; cases?: TextCase[] });
  if (node === "stories") {
    const { model } = productModel(runId, projectId);
    const modules: SpecModule[] = model.modules.map((m) => ({ id: m.id, name: m.name, parentId: m.parentId, kind: m.parentId ? "submodule" : "module", flowIds: [], routes: [] }));
    const stories = outputs.flatMap((o) => o.stories ?? []);
    const bundle: StoryBundle = { origin: "work-units", flows: [], modules, derivedFrom: "exploration", stories };
    const written = writeRunStage(runId, projectId, "stories", bundle, { viaUnits: true });
    /**
     * **扇出只有到这里才查得了。**
     *
     * 提议模块树的时候还没有故事，「叶子模块平均几条故事」无从算起——所以那一条不在
     * `modules` 节点，在这里。它回答的是「这棵树是不是一张故事清单穿了树的外衣」：
     * 叶子和故事接近 1:1 时树没有在提供结构。2026-09-11 实测三臂分别是 0.86 / 1.22 / 1.35，
     * 下限 1.5，**三臂都没过**，包括人写的那一臂。
     *
     * 记成 report 不拦合并：它判的是树的粗细，而树这时已经冻结了，拦在这里只能让人
     * 把故事硬塞进模块里凑数——那比一个诚实的低分更糟。
     */
    const findings = checkModulePlan({
      modules: model.modules.map((m) => ({ id: m.id, name: m.name, parentId: m.parentId })),
      stories: stories.map((st) => ({ id: st.id, moduleIds: st.moduleIds })),
    }).filter((f) => f.code === "leaf_fanout_too_low" || f.code === "leaf_without_story" || f.code === "story_module_unknown");
    /**
     * 主链上每一段都得有人认领（2026-09-12）。
     *
     * 单元是按模块切的，谁也看不见「整条生命周期」——一段没有任何 P0 故事，
     * 在单元那一层查不出来，只有合并时才看得见。和 fanout 一样记成 report，不拦合并：
     * 它判的是这批故事的分布，而故事已经写完了；拦在这里只会逼着人硬塞一条凑数。
     */
    for (const stage of model.lifecycle ?? []) {
      const p0 = stories.filter((st) => st.lifecycleId === stage.id && st.priority === "P0");
      if (!p0.length)
        findings.push({ code: "lifecycle_stage_without_p0", moduleId: stage.id,
          message: `生命周期「${stage.name}」上没有任何 P0 故事：这一段断了，整条链就走不完，不该没人认领` } as never);
    }
    const roleUsed = new Set(stories.map((st) => st.role).filter(Boolean));
    for (const r of model.roles ?? [])
      if (!roleUsed.has(r.id) && !roleUsed.has(r.name))
        findings.push({ code: "role_without_story", moduleId: r.id,
          message: `角色「${r.name}」一条故事都没有：包里声明了它，这批故事却没人从它的角度看过产品` } as never);
    if (findings.length) {
      // 合并可以重试，所以这一份也要可以重写：接在上一版后面，内容里不放时间戳
      // （放了的话同一次合并重跑两遍会被账本判成版本冲突，而那次合并其实什么都没变）。
      const prior = latestByName(runId, projectId, "report/module-fanout");
      runLedger().putRevision({ runId, projectId, name: "report/module-fanout", kind: "report",
        content: { stories: stories.length, findings }, parentRevision: prior?.revision.id ?? null }, { kind: "system", id: "stage-validator" });
    }
    return { ...written, modulePlan: findings };
  }
  const stories = latestByName(runId, projectId, "validated/stories")!.content as StoryBundle;
  const bundle = { origin: "work-units", derivedFrom: stories.derivedFrom, stories: stories.stories, flows: stories.flows, cases: outputs.flatMap((o) => o.cases ?? []) };
  return writeRunStage(runId, projectId, "cases", bundle, { viaUnits: true });
}

/** 有单元的 run 不许整份写入：这是单元边界的唯一强制点。 */
export function assertWholeWriteAllowed(runId: string, projectId: string, node: UnitNode) {
  if (!unitsEnabled(runId, projectId)) return;
  const units = load(runId, node);
  if (!units.length || units.some((u) => u.status !== "done")) throw new LedgerError(409, `stage_requires_units:${node}:call claim_unit/write_unit; ${units.filter((u) => u.status !== "done").length || "un-planned"} unit(s) not done`);
}

/** 领取一个单元时交给规划器的契约文本。抽出来是为了能单独对照：换一版措辞，产出会不会不一样。 */
/**
 * 这个单元名下的**叶子模块**：故事必须把它们填满。
 *
 * 「FILL EVERY LEAF」写在契约里很久了，但规划器手上从来没有「我名下有哪几个叶子」这份名单——
 * 它只有一串 moduleIds（父子混在一起）。2026-09-12 实测：34 条故事里
 * `position-risk.close`（平仓）一条都没有，而「离场」那一段因此也没有任何 P0。
 * 和交出冻结的树、交出可引段号同一条教训：**是事实就当数据交出去，别写在散文里让它猜。**
 */
function leavesOf(next: WorkUnit, all: Array<{ id: string; parentId: string | null; name?: string }>): string[] {
  if (next.scope.kind !== "module") return [];
  const inUnit = new Set(next.scope.moduleIds);
  return next.scope.moduleIds.filter((id) => inUnit.has(id) && !all.some((m) => m.parentId === id));
}

/**
 * 用例节点的结构契约，**不依赖单元**——整份路径也要拿到它。
 *
 * 2026-09-13 双臂实测：机器臂走单元循环，这份点名 `design` / `risk` / `readiness` 的契约
 * **每个单元都重新发一遍**，于是它的 163 条用例设计证据 100%、风险标注 100%；
 * Claude 臂走整份路径，`beginStage` 只给 stories 发 `structureContract`、给 cases 什么都不发，
 * 于是 75 条里设计证据 9%、风险 12%。**不是模型更懒，是提醒根本没送到。**
 */
export function caseStructureContract(): string {
  return unitContract({ node: "cases", unitId: "cases:<storyId>", scope: { kind: "story", storyId: "<storyId>", featureIds: [], ruleIds: [] } } as unknown as WorkUnit);
}

export function unitContract(
  next: WorkUnit,
  modules: Array<{ id: string; parentId: string | null; name?: string; featureIds?: string[] }> = [],
  features: Array<{ id: string; moduleId: string }> = [],
  story?: { id: string; title?: string; acceptance?: string[] },
  subsumed: Array<{ id: string; title?: string; acceptance?: string[] }> = [],
  /** 这个产品特有的动作词（规则包 actionVocabulary）；判哪条准则要人动手时接在通用词后面。 */
  vocabulary: readonly string[] = [],
): string {
  const leaves = leavesOf(next, modules);
  /**
   * 叶子后面跟着**它认领了几个功能**，以及**这个单元至少要写几条故事**。
   *
   * 2026-09-12 第一版我只写了「每个叶子至少一条」——它就精确地每个叶子写一条，
   * 包括一个认领了 4 个功能的叶子（`trade-panel.order-entry`：4 功能 → 1 条故事），
   * 于是 13 个叶子 16 条故事、平均 1.23，机检报 `leaf_fanout_too_low`
   * 「一张故事清单穿了树的外衣」。而契约本文写的是「每个叶子至少两条」。
   * **给的数和要的数不一样，它照给的那个做。** 现在两边说同一个数，
   * 并且把「一个功能至少一条」也变成可数的：4 个功能的叶子就该有 4 条。
   */
  const counted = leaves.map((id) => {
    const claimed = modules.find((m) => m.id === id)?.featureIds ?? [];
    const n = claimed.length || features.filter((f) => f.moduleId === id).length;
    return { id, features: n, want: Math.max(2, n) };
  });
  const leafLine = counted.length
    ? ` LEAVES YOU MUST FILL — each needs stories of its OWN, not only a parent-level one, at least two, and at least one per feature it claims: ${counted.map((c) => `${c.id}(features=${c.features}, stories>=${c.want})`).join(", ")}. That is ${counted.reduce((a, c) => a + c.want, 0)} stories for this unit at the very least. A leaf the exploration never reached still gets its stories — write behavior supported by requirements or normative rules, and record missing observation separately in observationLinks; skipping it silently hides the hole.`
    : "";
  /**
   * **验收准则要带编号交出去，`acRefs` 只能填编号。**
   *
   * 2026-09-13 实测（81 条用例）：`acRefs` 共 85 条，**21 条是模型自己改写的**——
   * 故事里根本没有那句话——16 条连 `When` 都改了，而且方向一致：
   * 「When 用户勾选 Reduce Only 并提交」被改成「When 用户查看面板」。
   * **故事里那个有业务含量的动作，被换成了「看一眼」**，于是用例理所当然地不需要动作
   * （81 条里 24 条除了导航什么都不做），判据退化成「页面上有这个字面量」，
   * 而那种判据在初始页面上就成立——通过时什么都没证明。
   *
   * 原来这里只说「acRefs 说的是这条用例了结了故事的哪几条验收准则」，
   * **却从不把那几条是什么交出去**。同 §29 叶子扇出、§34 负例比例：
   * 给不出数的时候，模型只能自己编一个。现在连编号带原文一起给，
   * 并且把「哪几条要求用户动手」标出来、把「这个单元至少要覆盖几条动作型准则」算成具体条数。
   */
  /**
   * **一条长故事走完，就顺带走完了几条短故事——说出来。**
   *
   * 2026-09-14 实测：38 条故事里一大半是展示型短故事，各自长出一个用例单元，
   * 于是 170 条用例里 22 条除了导航什么都不做，判据在初始页面上就成立。
   * 声明 `subsumes` 之后被覆盖的故事不再单独出单元，它的准则改由长用例路上的断言了结。
   *
   * 只对跨模块旅程单元说这句：模块内的短故事之间互相覆盖，会让「哪条故事该出单元」
   * 变成一张需要传递闭包的图，而人在界面上看不懂它。
   */
  const subsumeAdvice = next.node === "stories" && next.scope.kind === "journeys"
    ? ` A journey that walks through what a shorter story already covers SHOULD say so: subsumes:["<storyId>", ...]. A subsumed story gets no cases of its own — this journey's cases discharge its criteria as checks along the way. Use it for short display-only stories ("the header shows the page title") that a real journey passes through anyway; that is how a suite stops being a pile of two-step cases. Only journeys may subsume, only one level deep, and never a story that itself subsumes.`
    : "";
  const acs = story?.acceptance ?? [];
  const entries = acceptanceIndex(story ? [story, ...subsumed] : [], vocabulary);
  const actionable = entries.filter((e) => e.actionable);
  /**
   * 覆盖别人的故事：那几条短故事的准则也归这个单元。
   *
   * 这句是「长故事覆盖短故事」在契约里的落点——不写清楚，模型只会为本故事写用例，
   * 被覆盖的那几条准则就悄悄没人管了。
   */
  const subsumeLine = subsumed.length
    ? `\n    THIS STORY SUBSUMES ${subsumed.length} shorter one(s): ${subsumed.map((x) => `${x.id}「${x.title ?? ""}」`).join(", ")}. They have no unit of their own — their criteria are listed above with their own ids and MUST be discharged here. Do not write a separate two-step case for each: walk ONE longer path and check them along the way as assertions. That is the point of subsuming.`
    : "";
  const acceptanceLines = acs.length
    ? `acRefs MUST be ids from THIS story's acceptance list, verbatim — never a sentence you write yourself. The write is rejected otherwise. This story's criteria:\n`
      + entries.map((e) => `      ${e.id}${e.actionable ? " [需要用户动手]" : " [只要求看到]"} ${e.text}`).join("\n")
      + `\n    ${actionable.length} of them require the user to DO something${actionable.length ? ` (${actionable.map((e) => e.id).join(", ")})` : ""}, and EVERY ONE must be discharged by at least one case whose steps actually perform that When. A case claiming ${actionable.length ? actionable[0]!.id : "an actionable criterion"} whose steps are only "open the page" and "look at X" has not tested it: its oracle would already hold before any step ran.`
      + subsumeLine
      + `\n    Do not re-word a criterion to make it easier. If this story's criteria do not cover what you want to test, say so in the case title and cite the rule instead — but never invent an acRef.`
    : "acRefs MUST be ids from this story's acceptance list, verbatim.";

  return next.node === "stories"
      ? `${STORY_PLANNING_CONTRACT}\nWrite ONLY stories for this unit via write_unit(unitId=${JSON.stringify(next.unitId)}, content={stories:[...]}). Each story: stable id, title, role, benefit, acceptance[] (each criterion states precondition, trigger, business result), moduleIds ⊆ ${JSON.stringify(next.scope.kind === "module" ? next.scope.moduleIds : next.scope.kind === "journeys" ? next.scope.moduleIds : [])}, featureRefs ⊆ this unit's features, ruleRefs ⊆ this unit's rules. ${next.scope.kind === "journeys" ? "This unit is for cross-module journeys only: each story must reference ≥2 modules and cite existing storyIndex ids in acceptance text where it composes them; do not repeat module stories." : "Do not write stories for other modules."} Features marked blocked/unverified may still get stories when a normative rule supports them; keep its business acceptance intact and record observation gaps separately instead of dropping it. For every acceptance return observationLinks:[{acceptanceIndex:0-based,status:observed|partial|unobserved,reason:not_attempted|route_blocked|requires_session|requires_fixture|budget_exhausted|not_found|insufficient_evidence|observed,observationIds:[],nextSteps:[]}]. Copy observationIds only from supplied observations in this run. Observed means evidence supports this criterion, not merely that its feature was clicked. Empty evidence must be unobserved. Review all supplied observations for this feature before choosing unobserved. If records show only the entry or part of a business outcome, cite those records as partial only when they support a concrete part of this criterion. A feature match alone is not evidence. Cite relevant attempted records with unobserved/insufficient_evidence when they do not establish the outcome; use not_attempted only for the specific action not attempted. Avoid blanket empty IDs and generic nextSteps: identify the last observed state and the remaining action or missing result. nextSteps are proposed, NEVER executed history. Do not append requires-fixture to every acceptance: static visible labels require no trading funds or positions. Separate observed evidence, normative rules and hypotheses from execution prerequisites. Hypothesis claims may only produce open questions, not acceptance. If a story does not fit any module in this unit, do NOT force it onto the nearest one: write it anyway and add moduleAmendments:[{kind,reason,storyId?,featureId?,from?,to?,evidence[]}] saying what the tree cannot hold. Amendments change nothing in this run — they are a proposal for whoever freezes the next tree. Saying it out loud is the point; quietly mis-filing a story is the failure this exists to prevent.${leafLine}${subsumeAdvice}`
      : [
          `Write ONLY cases for story ${JSON.stringify((next.scope as { storyId: string }).storyId)} via write_unit(unitId=${JSON.stringify(next.unitId)}, content={cases:[...]}).`,
          /**
           * 必填字段要点名。
           *
           * 2026-09-11 单节点对照：只说「carry the design evidence」而不点名必填项，
           * 规划模型把 `designMethod` / `steps` / `expected` / `key` 全漏了——五条用例
           * 一条都过不了 schema，而它同时把 v2 的证据字段写得相当好。它不是不会写，
           * 是没被告知这些是必填的。
           */
          STORY_PLANNING_CONTRACT,
          "REQUIRED on every case, or the write is rejected: id, storyId (this story), title, designMethod, steps[], expected, tier, key, priority, scenarioType.",
          "  designMethod ∈ equivalence | boundary | state-transition | decision-table | negative | exploratory, and it must agree with design.technique.",
          "  key is a dedupe triple 'transition|parameters|assertion'. steps are short end-agnostic actions. priority takes the rule's riskFloor as its lower bound.",
          "  expected is ONE independently checkable result, phrased for a person to read.",
          /**
           * **两个 `sourceRefs`，同名不同义。**
           *
           * 2026-09-14 实测：41/170 条用例把规则包里那个 `sourceRefs` 的值
           * （`SRC-OBSERVED-2026-09-11`、`SRC-DOMAIN-REF`）照抄进了用例的 `sourceRefs`。
           * 不能怪模型——单元材料把规则连同它自己的 `sourceRefs` 一起交到它手上，
           * 而契约只说了一句「chunk ids returned by retrieve_spec」，没说另一个不是这个。
           */
          "  sourceRefs = chunk ids that retrieve_spec returned IN THIS RUN, copied verbatim — they look like `exploration.md#12`. The rules you were handed also carry a field spelled `sourceRefs` (values like `SRC-OBSERVED-2026-09-11`): that is the rule pack's own bibliography and is NOT what goes here. Cite a rule with ruleRefs; cite the material with sourceRefs. A case with no sourceRefs, or with an id retrieve_spec never returned, is rejected.",
          "  featureRefs/ruleRefs ⊆ this unit.",
          acceptanceLines,
          "conditionRefs is NOT optional decoration: it says which test conditions the case covers.",
          "tier and oracle move together. tier 1 or 2 REQUIRES a machine-checkable oracle on the case or on at least one assertion; a tier claimed without one is a label with nothing behind it. Write one of these shapes verbatim:",
          '    {"kind":"text","value":"<a literal the page shows>"}   {"kind":"noText","value":"<a literal the page must NOT show>"}',
          '    {"kind":"count","value":"<a literal>","op":"eq|gte|lte","n":<int>}   {"kind":"delta","value":"<label a number sits beside>","direction":"increased|decreased|unchanged"}   ← tier 2',
          /**
           * 这里原来是一行 `{"kind":"api",…}` 的写法——紧接着的下一句却说「永远不要对产品自己的接口下判断」。
           * 契约先教一种写法再禁止它，门禁（`oracle-offsite`）又会把照写的用例点名扣分。换成 tier 3 的 judge。
           */
          '    {"kind":"judge","criteria":["<one yes/no statement about the screen>", ...],"samples":3,"minPass":2}   ← tier 3, for GENERATED content only (an image, a summary, a caption, a translation)',
          /**
           * **判决从屏幕读**（CLAUDE.md 红线，2026-09-12 用户口径）。
           *
           * 这两句原来写的是反的：「真值活在接口里的产品（余额、持仓、挂单），
           * 接口判据才是对的，读屏幕是错的」。它和红线正面冲突，而且是**第三处**
           * 在教模型写接口判据（另两处：规则包的 R-PANEL-API-CONSISTENCY、
           * skill 的 REFERENCE.md 示例）。2026-09-13 复核 163 条用例时驳回的
           * TC-OO-06 / TC-OO-07 就是照这几句写出来的。
           * 会动的数字不是写接口判据的理由——那恰恰是「只断言存在、或两次读数的关系」的理由。
           */
          "  The verdict is read from the SCREEN. This product generates end-to-end UI tests: a case drives the interface and then judges what the interface shows. Never assert against the product's own API — an API that says the order was placed while the screen shows nothing means the case passes on a broken product.",
          "  Numbers that move (counts, countdowns, live prices, balances, timestamps) are not a reason to reach for the API: assert that the field EXISTS, or a RELATION between two readings (kind=delta), or a literal the product itself renders — a label, a status word, a count.",
          "  If nothing can decide it by program, say tier 3 and leave oracle out — and in readiness.reason say what judge or capability is missing.",
          "  Exception: when the outcome is generated content that differs on every run, give tier 3 a judge oracle. Each criterion is ONE statement a reader answers yes or no by looking (\"the image shows a cat\", \"the title is at most 20 characters\") — never \"looks good\" or \"is reasonable\" (the gate flags those). samples ≥ 3 and minPass ≤ samples; the case passes when at least minPass samples hold every criterion.",
          "covers must be exactly the transition ids in design.transitionIds — the edges this case walks. A rule id (R-…) is NOT a transition and must never appear there; neither is a human-readable summary line. A case that walks no edge leaves covers empty.",
          "Carry the design evidence, not just the method label. The server checks these deterministically and rejects contradictions:",
          /**
           * **把门禁的那个数说出来。**
           *
           * 门禁要求负例/边界至少占 30%（`gate.ts` 的 `minNegativeRatio`），而契约与 skill
           * 从头到尾没提过这个数。2026-09-13 双臂实测：机器臂 25%、Claude 臂 19%，两边都没到——
           * 不是不肯写拒绝路径，是**没人告诉过它们靶子在哪**。
           * 和叶子扇出那次（§29）同一条教训：给的数和要的数不一样，模型照给的那个做；
           * 一个数都不给，它就只能猜。
           */
          `  AT LEAST ${Math.round(MIN_NEGATIVE_RATIO * 100)}% OF THE CASES YOU WRITE MUST BE scenarioType=negative OR designMethod=boundary — the gate counts them together and flags a suite below that line. A story with N cases therefore needs about ${Math.max(1, Math.round(MIN_NEGATIVE_RATIO * 3))} refusal or edge case for every ${3 - Math.max(1, Math.round(MIN_NEGATIVE_RATIO * 3))} happy-path ones. Ask of each story: what must this product REFUSE here, and what does it say when it refuses?`,
          "  • Two different axes, never mixed. scenarioType ∈ positive | negative | recovery | concurrency (WHAT situation). design.technique ∈ equivalence | boundary | decision-table | state-transition | exploratory (HOW it was derived). `negative` is a scenario and never a technique; `exploratory` is a technique and never a scenario. A negative case is still derived by some technique.",
          "  • design.technique is REQUIRED inside design and must equal designMethod — except designMethod `negative`, which pairs with whichever technique actually derived the case.",
          "  • design enums: validity ∈ valid | invalid; inclusivity ∈ inclusive | exclusive; points[].at ∈ below | at | above. Use the value itself, never a value with an explanation glued onto it.",
          "  • design: equivalence needs inputDimension/partitionId/predicate/validity/representative; boundary needs ruleId/dimension/unit/bound/inclusivity and points including the one AT the bound; decision-table needs conditionIds, rowId and an assignment covering exactly those conditions; state-transition needs stateModelRef/from/event/to and transitionIds that also appear in covers; exploratory needs charterRef and observedResultRefs[].",
          "  • risk: {impact, reason, ruleRefs}. impact is one of funds-and-exposure | authorization | data-integrity | availability | information | cosmetic — a category, NOT a sentence. reason is the sentence: why this priority, not a restatement of it.",
          "  • testData is an OBJECT: {fixtureRef?, accountRef?, values:[{name, value, unit?, source?}]} — not a bare array. Every value carries where it came from (a rule id or the asset metadata). Never invent a constant.",
          "  • assertions: one entry per independently checkable expectation, each {id, statement, ruleRefs[], oracle?, afterStep?} — the field is `statement`, not `expected`. Do not fold two checks into one sentence. Assertions are checked after the LAST step unless you set afterStep: n (1-based) — if an assertion describes a screen the case passes THROUGH (「the labels page shows the empty state」 before the step that opens the form), set afterStep to the step that reaches that screen, or it will be judged on the wrong page. An open question is not an assertion: never put 「待确认 / 开放问题 / not a failure criterion」 text into assertions[] — it cannot pass or fail; put it in readiness.reason.",
          "  • The domain reference from load_run_instructions (runScope.domainReference), when present, is THIS product's own list of invariants (supplied by the project): a case may be written to contradict one; anything it marks as a hypothesis may only become an open question. materials.volatileReadings names readings that change on their own — assert they exist or relate, never pin their value.",
          "  • readiness: {design, execution, reason?}. design ∈ candidate | reviewed. execution ∈ ready | requires-fixture | requires-session | blocked | not-executable. When execution is not `ready` you MUST give reason and say what is missing. requirements may list {id,kind:session|fixture|locator|calculation|applicability,status:missing|unverified|verified,evidenceRefs:[]}. Never invent verification evidence. ready must have no missing prerequisites and a machine oracle for EVERY independent assertion; the top-level oracle only covers the primary expected statement. Static display checks must not inherit trading-fixture reasons. Numeric checks require independent decimal calculation, timestamp/scope/rounding evidence; prose formulas alone are not executable. The decimal-equation oracle accepts scope:{start,end} (unique visible boundaries), inputs:[{id,label,unit,decimals,rounding:exact|nearest|truncate}], actual:inputId, formula:[inputId,inputId,operator] in postfix notation (+,-,*,/), maxAgeMs:1..60000. Each input must match one visible line label:number unit. Never use the actual result in its own formula. Use only observed labels/units and documented rounding; otherwise leave execution blocked. This checks consistency within display precision, not ledger precision.",
          "A bound, a step or a constant you cannot trace to a rule or to the asset metadata does not belong in the case. Leave the field out rather than fabricate it — the server treats a missing field and a fabricated one differently.",
          "Preparation handoff: when execution is not ready, enumerate each missing prerequisite in readiness.requirements with kind, status and evidenceRefs. Do not claim verified without evidence. Design approval is separate from execution admission. For a numeric field, noText substring matching cannot establish inequality: 10x contains 0x. Use a scoped numeric comparison or leave the oracle unresolved. Test-runner/reporting policies belong in audit constraints, not invented product UI cases; flag an upstream amendment when an acceptance criterion only constrains the tester.",
          "steps are ACTIONS a browser agent performs, one per line, in order. They are not narration: never put a cross-reference (\"as in S-MKT-01\"), a precondition (\"on an account with no balance\"), or an API call into a step — the agent will try to perform it and the case dies before its oracle is checked. Preconditions go in precondition[], cross-references stay in the story, API checks stay in the oracle.",
          /**
           * **「确认 X 显示 Y」不是一个动作。**
           *
           * 上面那句只举了账户状态（"on an account with no balance"），而 2026-09-13 实测
           * 写出来的是另一种形状：一句**祈使的状态确认**——TC-001 第 2 步
           * 「确认右侧区域显示订单簿（Order Book 标签处于激活态…）」，81 条里 14 条这样。
           * 执行侧把每个 step 交给 `aiAction`，它只规划动作，于是抛
           * `Failed to plan actions: 右侧区域当前显示的是交易下单面板…`，
           * 一条措辞问题被记成产品缺陷。门禁的 `step-not-an-action` 现在会拦，
           * 但拦住之前先把话说清楚：模型没被告知过这个形状不行。
           */
          "  NEVER write a step that begins 确认/验证/检查/assert/verify/ensure and then describes what the screen shows (\"确认右侧区域显示任务列表\", \"verify the panel shows the list\"). That is a state, not an action: the browser agent can only DO things, so it gives up and the case dies before any oracle runs. A state the case starts from goes in precondition[]; a state the case ends in goes in assertions[]. If you need the product to be in that state, write the ACTION that puts it there (\"点击「已完成」标签\").",
          "  Nor a step that is pure looking (\"查看面板方向按钮区域\", \"observe the Size input area\"). Looking is not an operation the browser can perform; if the case only needs to know what is on screen, that belongs in the oracle and in assertions[], and the case may legitimately have just one step: the navigation.",
          "Name a control the way the page shows it AND where it sits when the label is not unique — \"click Balances in the tab row of the account panel in the lower half of the page\", not \"switch to Balances\". One observation per step; a step that asks for four things at once makes the planner give up.",
          "postSteps put the product back. Any case that changes state — an order placed, a toggle flipped, a mode switched, a tab left somewhere else — MUST say how it undoes that, or its second run faces a different product than its first and nobody sees the difference. A read-only case leaves postSteps empty.",
          "Do not lower a P0 because a fixture is missing; keep the case, mark readiness.execution and say why.",
          ...(next.repair ? ["",
            `REPAIR ROUND ${next.repair.round}. The gate read your previous write for this unit and flagged these cases. Rewrite the WHOLE unit: fix exactly these, leave the rest as they were. Fixing by weakening an assertion is not a fix — when a case cannot be settled by a program, lower its tier and say what is missing in readiness.reason.`,
            ...next.repair.cases.map((c) => `  • ${c.caseId} · ${c.rule} · ${c.message}`)] : []),
        ].join("\n");
}

/** 门禁那几句话，改写成规划器能照着改的一段。 */
function repairBrief(repair: NonNullable<WorkUnit["repair"]>): { round: number; instruction: string; cases: NonNullable<WorkUnit["repair"]>["cases"] } {
  const ids = [...new Set(repair.cases.map((c) => c.caseId))];
  return {
    round: repair.round,
    instruction: `The gate read your previous write and flagged ${ids.length} case(s) in this unit: ${ids.join(", ")}. Rewrite the WHOLE unit, fixing exactly these and leaving the rest as they were. Each line below is one finding: caseId · rule · what is wrong. Do not fix it by weakening the assertion — if a case cannot be settled by a program, lower its tier and say so in readiness.reason instead of deleting the check.`,
    cases: repair.cases,
  };
}

/**
 * 门禁不通过之后，把话按单元分好、把受影响的单元重新打开（F-11）。
 *
 * 只重开**被扣分的用例所在的那些单元**：门禁的扣分口径是「被 warn 点到的用例」，
 * info 级别的发现不重开单元——否则每一批都会因为几条 `oracle-vague` 而全员返工。
 * 返回重开了哪些，调用方决定要不要把这件事写进事件。
 */
export function reopenUnitsFromGate(runId: string, projectId: string, findings: Array<{ caseId?: string; rule: string; severity: string; message: string }>): { reopened: string[]; round: number } {
  if (!unitsEnabled(runId, projectId)) return { reopened: [], round: 0 };
  const units = load(runId, "cases");
  if (!units.length) return { reopened: [], round: 0 };
  const byCase = new Map<string, string>();
  for (const u of units) {
    if (!u.outputRevision) continue;
    const content = runLedger().readRevision(u.outputRevision, projectId).content as { cases?: TextCase[] };
    for (const c of content.cases ?? []) byCase.set(c.id, u.unitId);
  }
  const perUnit = new Map<string, NonNullable<WorkUnit["repair"]>["cases"]>();
  for (const f of findings) {
    if (f.severity !== "warn" || !f.caseId) continue;
    const unitId = byCase.get(f.caseId);
    if (!unitId) continue;
    perUnit.set(unitId, [...(perUnit.get(unitId) ?? []), { caseId: f.caseId, rule: f.rule, severity: f.severity, message: f.message }]);
  }
  const reopened: string[] = [];
  let round = 0;
  for (const [unitId, cases] of perUnit) {
    const unit = units.find((u) => u.unitId === unitId)!;
    if (unit.attempt >= MAX_UNIT_ATTEMPTS) continue;
    unit.repair = { round: (unit.repair?.round ?? 0) + 1, cases };
    round = Math.max(round, unit.repair.round);
    unit.status = "pending";
    unit.reason = `gate: ${cases.slice(0, 3).map((c) => `${c.caseId} ${c.rule}`).join("; ")}`;
    save(unit);
    reopened.push(unitId);
  }
  return { reopened, round };
}
