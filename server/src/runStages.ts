import { storyPlanningIssues } from '@testpilot/harness-testing/casegen';
import { executionBlockers } from "@testpilot/harness-testing/casegen";
import { boundRulePack } from "./rulePacks.js";
import { boundDomainReference } from "./domainReferences.js";
import { requireStageStarted } from './workflowControls.js';
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJSON, type ArtifactRevision } from "@testpilot/harness-core/run-contracts";
import { ARTIFACT_WRITING_GUIDELINES, validateStories, validateCases, runGate, type CaseBundle, type StoryBundle } from "@testpilot/harness-testing/casegen";
import { auditedRetrieve, boundRetrievalIndex, historicalRetrievalIds } from "./retrievalAudit.js";
import { runLedger, skillBinding } from "./runService.js";
import { contentHash, LedgerError } from "./runLedger.js";
import { getProject } from './db.js';
import { selectRunMemory } from './runMemory.js';
import { assertWholeWriteAllowed, reopenUnitsFromGate } from './workUnits.js';
import { frozenModules } from './moduleStage.js';
import { checkModulePlan } from "@testpilot/harness-testing/domain";
import { acceptanceIndex, checkStories } from "./acceptanceIndex.js";

/**
 * v2（2026-09-15）：分数从「没被点名的用例占比」变成它 × 「有人真做了的动作型准则占比」。
 * 算法变了而阈值没变，所以版本号必须跳——v1 的 0.8 和 v2 的 0.8 不是同一把尺子量出来的。
 * 已收尾的运行不受影响（finalizeRun 不重判）；门禁过了但还没收尾的，收尾时会要求重跑门禁。
 */
const policy = Object.freeze({ version: "design-gate-v2", minGateScore: 0.6, minNegativeRatio: 0.3 });
type Stage = "instructions" | "stories" | "cases" | "gate" | "finalize";
const principal = { kind: "system" as const, id: "stage-validator" };
function store() {
  const ledger = runLedger();
  ledger.db.exec(`
    CREATE TABLE IF NOT EXISTS run_stage_receipts (
      runId TEXT NOT NULL REFERENCES wf_run_registrations(runId), stage TEXT NOT NULL,
      revisionId TEXT NOT NULL REFERENCES artifact_revisions(id), json TEXT NOT NULL,
      PRIMARY KEY(runId,stage));
    CREATE TABLE IF NOT EXISTS run_retrievals (
      id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES wf_run_registrations(runId), json TEXT NOT NULL);
  `);
  return ledger;
}
function receipt(runId: string, stage: Stage): { revisionId: string; [key: string]: any } | undefined {
  const row = store().db.prepare("SELECT json FROM run_stage_receipts WHERE runId=? AND stage=?").get(runId, stage) as { json: string } | undefined;
  return row ? JSON.parse(row.json) : undefined;
}
function current(runId: string, projectId: string, stage: Stage) {
  const r = receipt(runId, stage);
  if (!r) throw new LedgerError(409, `${stage}_required`);
  const value = store().readRevision(r.revisionId, projectId);
  if (value.revision.runId !== runId) throw new LedgerError(409, "stage_revision_conflict");
  return { ...value, receipt: r };
}
function save(runId: string, projectId: string, stage: Stage, content: unknown, sourceRefs: string[], facts: Record<string, unknown> = {}) {
  const ledger = store();
  const previous = receipt(runId, stage);
  const kind: ArtifactRevision["kind"] = stage === "instructions" || stage === "finalize" ? "report" : stage;
  const revision = ledger.putRevision({ runId, projectId, name: `validated/${stage}`, kind, content, sourceRefs,
    parentRevision: previous?.revisionId }, principal);
  const value = { revisionId: revision.id, ...facts };
  ledger.db.prepare(`INSERT INTO run_stage_receipts VALUES (?,?,?,?) ON CONFLICT(runId,stage)
    DO UPDATE SET revisionId=excluded.revisionId,json=excluded.json`).run(runId, stage, revision.id, canonicalJSON(value));
  if (previous?.revisionId !== revision.id) {
    const sequence = (ledger.db.prepare("SELECT COALESCE(MAX(sequence),-1)+1 AS n FROM workflow_events WHERE runId=? AND node=? AND attempt=0").get(runId, stage) as { n: number }).n;
    ledger.appendEvent({ id: `stage-${randomUUID()}`, runId, node: stage, attempt: 0, sequence, at: new Date().toISOString(),
      phase: facts.passed === false ? "blocked" : stage === "finalize" ? "waiting_review" : "done", revisionId: revision.id }, projectId);
  }
  return { ...value, revision };
}
function ready(runId: string, projectId: string) {
  const run = store().requireRun(runId, projectId);
  if (!run.binding.materialsHash || !run.binding.inputHash) throw new LedgerError(409, "inputs_not_sealed");
  // Read the bound blobs, never a mutable materials directory or its index.
  for (const id of run.binding.materialRevisions) store().readRevision(id, projectId);
  return run;
}
function editable(runId: string, projectId: string) {
  ready(runId, projectId); current(runId, projectId, "instructions");
  if (["cancelled", "interrupted", "failed"].includes(String(store().outputs.getRun(runId)?.status))) throw new LedgerError(409, "run_requires_explicit_resume");
  if (receipt(runId, "finalize")) throw new LedgerError(409, "run_finalized_create_revision_run");
}
function basis(runId: string) {
  const rows = store().db.prepare("SELECT json FROM run_retrievals WHERE runId=?").all(runId) as Array<{ json: string }>;
  return { retrieved: historicalRetrievalIds(store(),runId), retrieveCalls: rows.length, indexed: null };
}
function verifyCases(runId: string, projectId: string, content: unknown) {
  const stories = current(runId, projectId, "stories");
  const verdict = validateCases(content, basis(runId));
  if (!verdict.ok) return verdict;
  const bundle = verdict.data;
  if (canonicalJSON(bundle.stories) !== canonicalJSON((stories.content as StoryBundle).stories))
    throw new LedgerError(409, "cases_stories_revision_mismatch");
  const ids = new Set(bundle.stories.map(s => s.id));
  if (!bundle.cases.length || new Set(bundle.cases.map(c => c.id)).size !== bundle.cases.length || bundle.cases.some(c => !ids.has(c.storyId)))
    throw new LedgerError(400, "invalid_case_identity_or_traceability");
  /**
   * **整份写入这条路也要关同一道门。**
   *
   * 单元循环那边已经拒收改写过的 `acRefs`（见 `workUnits.ts` 的 `acceptance_ref_unknown`）。
   * 只关一边的话，换条路写进来的用例照样可以自己编一条验收准则——2026-09-13 实测 85 条里
   * 21 条就是这么来的。旧写法（逐字的 Given/When/Then 原文）仍然认，认不出来的才算改写。
   */
  const entries = acceptanceIndex(bundle.stories, boundRulePack(runId, projectId)?.actionVocabulary);
  const known = new Set(entries.map(e => e.id));
  const norm = (x: string) => x.replace(/[\s“”"'（）()、,，。.]/g, "");
  const bad = bundle.cases.flatMap((c, i) => (c.acRefs ?? []).map((r, j) => ({ c, i, j, r }))
    .filter(({ c, r }) => !known.has(r) && !entries.some(e => e.storyId === c.storyId && norm(e.text) === norm(r))));
  if (bad.length)
    return { ok: false as const, gate: "acceptance-refs",
      errors: bad.slice(0, 20).map(({ c, i, j, r }) => ({ code: "acceptance_ref_unknown", jsonPointer: `/cases/${i}/acRefs/${j}`,
        message: `${c.id}: 「${r.slice(0, 40)}」不是 ${c.storyId} 的验收准则。只能填编号：${entries.filter(e => e.storyId === c.storyId).map(e => e.id).join(", ") || "（这条故事没有验收准则）"}` })) };
  return verdict;
}

/** Serving these bytes proves delivery to the host context, not attention or obedience. */
/**
 * 整跑级材料：领域参考、行业词表、易变读数、角色、规则包摘要。
 * 它们不随单元变化，所以不该出现在每个 `claim_unit` 的返回里（见下面的注释）。
 */
export function runScopeMaterials(runId: string, projectId: string) {
  const pack = boundRulePack(runId, projectId);
  // 用本文件的 store()：workUnits 已经反向 import 了 runStages，引它的 latestByName 会成环。
  const l = store();
  const modelRev = l.listRevisions(projectId, runId).filter((r) => r.name === "product/model-candidate").sort((x, y) => x.revision - y.revision).at(-1);
  const model = modelRev ? (l.readRevision(modelRev.id, projectId).content as { roles?: unknown[] }) : undefined;
  return {
    knowledgeRefs: [
      l.listRevisions(projectId,runId).filter(r=>r.name==='knowledge/domain-reference').at(-1)?.id,
      pack ? l.listRevisions(projectId,runId).filter(r=>r.name==='knowledge/rulepack/'+pack.id).at(-1)?.id : undefined,
    ].filter((id):id is string=>!!id),
    domainReference: boundDomainReference(runId, projectId),
    actionVocabulary: pack?.actionVocabulary ?? [],
    volatileReadings: pack?.volatileReadings ?? [],
    roles: model?.roles ?? [],
    ...(pack ? { rulePack: { id: pack.id, version: pack.version } } : {}),
  };
}

export function loadRunInstructions(runId: string, projectId: string) {
  return store().db.transaction(() => {
    requireStageStarted(runId,projectId,"instructions");
    const run = ready(runId, projectId);
    const old = receipt(runId, "instructions");
    if (old) return { ...(current(runId, projectId, "instructions").content as object), revisionId: old.revisionId };
    const assets = skillBinding();
    if (assets.loadedDigest !== run.binding.assetDigest) throw new LedgerError(409, "installed_skills_changed_register_new_run");
    const selected = assets.files.filter(f => /^skills\/(testpilot-run-c|testpilot-stories|testpilot-design)\//.test(f.path));
    const files = selected.map(f => ({ ...f, text: readFileSync(resolve(import.meta.dirname, "../../plugins/testpilot", f.path), "utf8") }));
    if (files.some(f => contentHash(f.text) !== f.hash)) throw new LedgerError(409, "skill_changed_during_load");
    const loadedDigest = contentHash(canonicalJSON(files.map(({ path, hash }) => ({ path, hash }))));
    const memory = selectRunMemory(store(), runId, projectId, getProject(projectId)?.targetUrl ?? 'http://localhost',
      process.env.TP_MEMORY_ENABLED !== '0' && run.input.parameters?.memoryEnabled !== false && run.binding.contextPolicy?.memory !== 'off');
    /**
      * **整跑不变的材料只发一次。**
      *
      * 2026-09-16 实测（Hyperliquid，40 个工作单元）：`claim_unit` 每次回 2.6 万字符，
      * 其中 `domainReference` 40 次一模一样（16.8 万字符）、`roles` / `rulePack` / 词表
      * 各只有一种取值——整跑级的事实被逐单元重发了 39 遍。而这些字符每一轮都算进
      * `cache_read`：那一跑 7,780 万 token 的缓存读、$36，output 只有 3,200 token。
      * 真正贵的不是「写用例」，是「把用过的东西一遍遍重读」。
      *
      * 它们挂在这里：这个工具幂等（第二次调用返回同一份回执），天然只发一次。
      */
    const content = { files, loadedDigest, memory, writingGuidelines: ARTIFACT_WRITING_GUIDELINES, runScope: runScopeMaterials(runId, projectId), skillVersion: run.binding.skillVersion, policy, evidence: "server-delivered" };
    const r = save(runId, projectId, "instructions", content, memory.entries.map(e => e.sourceRevision));
    store().db.prepare("UPDATE wf_run_registrations SET bindingJson=? WHERE runId=?").run(canonicalJSON({ ...run.binding, loadedDigest, memoryDigest: memory.digest }), runId);
    return { ...content, revisionId: r.revisionId };
  })();
}
/**
 * `retrieve_spec` 会把材料切成多少块——**检索块的编号空间**。
 *
 * 块 id 写作 `materials/<name>#N`，和材料分节 id 的写法一模一样却是另一套编号
 * （这份材料：分节 24，检索块 50）。核对判据出处时两边都要认，见
 * workUnits.ts 的 `acceptance_cites_missing_section`。
 */
export function retrievalChunkCount(runId: string, projectId: string): number {
  try {
    return boundRetrievalIndex(store(),runId,projectId).index.chunks.length;
  } catch { return 0; }
}

export function retrieveRunSpec(runId: string, projectId: string, raw: unknown) {
  ready(runId, projectId); current(runId, projectId, "instructions");
  return auditedRetrieve(store(),runId,projectId,raw);
}
export function writeRunStage(runId: string, projectId: string, stage: "stories" | "cases", content: unknown, opts: { viaUnits?: boolean } = {}) {
  return store().db.transaction(() => {
    requireStageStarted(runId,projectId,stage);
    editable(runId, projectId);
    // 单元循环的 run 只能由 mergeUnits 整份写入；规划器直接写整份会被拒（见 workUnits.assertWholeWriteAllowed）。
    if (!opts.viaUnits) assertWholeWriteAllowed(runId, projectId, stage);
    if (!basis(runId).retrieveCalls) throw new LedgerError(409, "retrieve_spec_required");
    let modulePlan: ReturnType<typeof checkModulePlan> = [];
    let acceptance: ReturnType<typeof checkStories> = [];
    const verdict = stage === "stories" ? validateStories(content) : verifyCases(runId, projectId, content);
    if (!verdict.ok) return { status: "blocked", ...verdict };
    if (stage === "stories") {
      const bundle=verdict.data as StoryBundle;
      const stories = bundle.stories;
      const planningIssues=storyPlanningIssues(stories);
      if(planningIssues.length)return {status:"blocked",gate:"planning-contract",errors:planningIssues};
      const modules=new Map(bundle.modules.map(m=>[m.id,m]));
      if(modules.size!==bundle.modules.length)throw new LedgerError(400,'duplicate_module_id');
      for(const module of bundle.modules){const seen=new Set([module.id]);let parent=module.parentId;while(parent){if(seen.has(parent))throw new LedgerError(400,'product_module_cycle');seen.add(parent);const ancestor=modules.get(parent);if(!ancestor)throw new LedgerError(400,'product_module_parent_missing');parent=ancestor.parentId;}}
      for(const story of stories)if(story.moduleIds?.some(id=>!modules.has(id)))throw new LedgerError(400,'story_module_missing');

      if (!stories.length || new Set(stories.map(s => s.id)).size !== stories.length) throw new LedgerError(400, "invalid_story_identity");
      /**
       * **冻结过的模块树也要管住整份写入的这条路。**
       *
       * 单元循环那条路上，树决定单元怎么切，所以它天然管得住（`workUnits.productModel`）。
       * 整份写入这条路上原来它一点作用都没有：`modules` 节点冻结了一棵树，规划器写故事时
       * 完全可以在 bundle 里自带另一棵，上面那几条检查只查 bundle 自洽，不查它和冻结的那棵
       * 是不是同一棵。那样的话「人冻结了模块树」这件事在这条路上等于没发生过。
       *
       * 挂到树里没有的模块＝错，整份拒收；叶子没故事、扇出太低＝记 `report/module-fanout`
       * 不拦——和合并那一侧同一个口径（docs/v3/history/24 §8.1）。
       */
      const frozen = frozenModules(runId, projectId);
      if (frozen?.length) {
        const findings = checkModulePlan({ modules: frozen, stories: stories.map(st => ({ id: st.id, moduleIds: st.moduleIds })) });
        const unknown = findings.filter(f => f.code === "story_module_unknown");
        if (unknown.length)
          return { status: "blocked", gate: "module-plan",
            errors: unknown.map(f => ({ code: f.code, jsonPointer: `/stories/${f.storyId}`, message: f.message })) };
        /**
         * 叶子没故事、扇出太低：不拦，但**要回给规划器**。
         *
         * 2026-09-12 实测机器臂 27 个叶子 27 个空着，而这些结论当时只落成一份
         * `report/module-fanout` 修订——没有任何人和任何模型会去读它。一条检查如果只写进
         * 账本、不回到写它的那一方手里，它就只是在记录失败，不在减少失败。
         */
        const shape = findings.filter(f => f.code === "leaf_fanout_too_low" || f.code === "leaf_without_story");
        modulePlan = shape;
        if (shape.length) {
          const prior = store().listRevisions(projectId, runId).filter(r => r.name === "report/module-fanout").sort((a, b) => a.revision - b.revision).at(-1);
          store().putRevision({ runId, projectId, name: "report/module-fanout", kind: "report",
            content: { stories: stories.length, findings: shape }, parentRevision: prior?.id ?? null }, principal);
        }
      }
      /**
       * 验收准则编号 + 「这条要不要用户动手」，随故事一起落盘。
       *
       * 下游的 `acRefs` 只能填这里的编号（见 `acceptanceIndex.ts` 的注释：2026-09-13 实测
       * 85 条 acRefs 里 21 条是模型自己改写的，16 条连 When 都改了）。索引落成一条修订，
       * 用例节点的契约从它取数，谁认领了哪条也就查得出来。
       *
       * 「一条动作型准则都没有」的故事记一条 finding 回给规划器——不拦，
       * 和叶子扇出同一个口径：只写进账本、不回到写它的那一方手里的检查，
       * 只是在记录失败，不在减少失败。
       */
      /**
       * `subsumes` 的三条约束：引的故事要存在、不能覆盖自己、被覆盖的不能再覆盖别人。
       *
       * 第三条是为了让「哪条故事该出用例单元」保持可读——允许链式覆盖的话，
       * 那个问题就变成一张要算传递闭包的图，而人在界面上看不懂它。
       */
      const byId = new Map(stories.map((st) => [st.id, st]));
      const covers = new Set(stories.flatMap((st) => st.subsumes ?? []));
      for (const st of stories) for (const id of st.subsumes ?? []) {
        if (id === st.id) throw new LedgerError(400, `story_subsumes_itself:${st.id}`);
        if (!byId.has(id)) throw new LedgerError(400, `story_subsumes_unknown:${st.id}->${id}`);
        if ((byId.get(id)!.subsumes ?? []).length) throw new LedgerError(400, `story_subsume_chain:${st.id}->${id}`);
        if (covers.has(st.id)) throw new LedgerError(400, `story_subsume_chain:${st.id}`);
      }
      acceptance = checkStories(stories, boundRulePack(runId, projectId)?.actionVocabulary);
      const priorIndex = store().listRevisions(projectId, runId).filter(r => r.name === "report/acceptance-index").sort((a, b) => a.revision - b.revision).at(-1);
      store().putRevision({ runId, projectId, name: "report/acceptance-index", kind: "report",
        content: { entries: acceptanceIndex(stories, boundRulePack(runId, projectId)?.actionVocabulary), findings: acceptance }, parentRevision: priorIndex?.id ?? null }, principal);

      const prior = receipt(runId, "stories");
      if (receipt(runId, "cases") && prior && canonicalJSON(current(runId, projectId, "stories").content) !== canonicalJSON(verdict.data))
        throw new LedgerError(409, "stories_frozen_after_case_design");
    }
    const refs = stage === "stories" ? [...ready(runId, projectId).binding.materialRevisions, ...store().listRevisions(projectId,runId).filter(r=>r.name==="validated/modules").slice(-1).map(r=>r.id)] : [current(runId, projectId, "stories").revision.id];
    return { status: "validated", ...verdict.output, ...save(runId, projectId, stage, verdict.data, refs),
      ...(modulePlan.length ? { modulePlan } : {}), ...(acceptance.length ? { acceptance } : {}) };
  })();
}
export function gateRun(runId: string, projectId: string) {
  requireStageStarted(runId,projectId,"gate");
  return store().db.transaction(() => {
    editable(runId, projectId);
    const cases = current(runId, projectId, "cases");
    const verdict = verifyCases(runId, projectId, cases.content);
    if (!verdict.ok) return { status: "blocked", ...verdict };
    const pinnedPolicy = (current(runId, projectId, "instructions").content as { policy: typeof policy }).policy;
    // 账本路径：故事已编号、acRefs 是契约的一部分，所以准则覆盖进分数（见 GateOptions.acceptanceInScore）。
    // 这个产品特有的动作词与易变读数名，来自这次运行绑定的规则包；没有就只用通用规则。
    const pack = boundRulePack(runId, projectId);
    const report = runGate(verdict.data, { minNegativeRatio: pinnedPolicy.minNegativeRatio, acceptanceInScore: true, actionVocabulary: pack?.actionVocabulary, volatileReadings: pack?.volatileReadings });
    const passed = report.score >= pinnedPolicy.minGateScore;
    const executionReadiness = verdict.data.cases.map(c=>({caseId:c.id,blockers:executionBlockers(c)}));
    const executionAdmission = {ready:executionReadiness.filter(c=>!c.blockers.length).length,total:executionReadiness.length,cases:executionReadiness};
    /**
     * 不通过时，把门禁的话按单元送回规划器（docs/v3/history/23 F-11）。
     *
     * 门禁一直什么都说了——被扣分的用例 id、每条 finding 的规则与原因——只是没人把它们
     * 送回领单元的那一步。两次实测里 Penguin 都是在这里就地停住：它知道自己被拦了，
     * 不知道该改哪几条。重开只针对**被 warn 点到的用例所在的单元**，info 不重开。
     */
    const repair = passed ? { reopened: [], round: 0 } : reopenUnitsFromGate(runId, projectId, report.findings);
    return { status: passed ? "passed" : "blocked", report, executionAdmission, ...(repair.reopened.length ? { repair } : {}),
      ...save(runId, projectId, "gate", { report, passed, executionAdmission, policy: pinnedPolicy }, [cases.revision.id], { passed, casesRevision: cases.revision.id }) };
  })();
}
export function finalizeRun(runId: string, projectId: string) {
  if(!receipt(runId,"finalize"))requireStageStarted(runId,projectId,"finalize");
  return store().db.transaction(() => {
    const run = ready(runId, projectId);
    if (!receipt(runId, "finalize") && ["cancelled", "interrupted", "failed"].includes(String(store().outputs.getRun(runId)?.status))) throw new LedgerError(409, "run_requires_explicit_resume");
    const instructions = current(runId, projectId, "instructions");
    const stories = current(runId, projectId, "stories"), cases = current(runId, projectId, "cases"), gate = current(runId, projectId, "gate");
    const verdict = verifyCases(runId, projectId, cases.content);
    if (!verdict.ok) throw new LedgerError(409, "cases_validation_failed");
    if (gate.receipt.casesRevision !== cases.revision.id) throw new LedgerError(409, "gate_stale_rerun_required");
    const { policy: pinnedPolicy, report, passed } = gate.content as { policy: typeof policy; report: ReturnType<typeof runGate>; passed: boolean };
    /**
     * **已经收尾的 run 不再拿今天的规则重判。**
     *
     * `reviewRevisions` 每次读都会调这里。原来的顺序是先用当前门禁重算一遍、要求和钉住的
     * 报告逐字节相同，再看有没有收尾回执——于是**任何一次门禁规则改动，都会让此前所有
     * 已冻结的 run 再也打不开复核面**，报 `gate_not_passed`。2026-09-11 第二轮就撞上了：
     * 修完三条门禁缺陷之后，前一天刚收尾的 run 读不出来了。
     *
     * 已收尾的判决是一件历史事实。用新规则重新打分是 `scripts/replay.mjs` 的事，
     * 那是显式动作；读一条冻结的 run 不该顺带把它重判一遍。
     *
     * 防篡改没有放松：上面两条仍在——用例要过校验（内容被改会失败），门禁回执要指向
     * 当前这版用例（收尾后换过用例会失败）。放弃的只有「今天的规则跑出来字节相同」。
     */
    const previous = receipt(runId, "finalize");
    if (previous) return { ...(current(runId, projectId, "finalize").content as object), revisionId: previous.revisionId };
    const pack = boundRulePack(runId, projectId);
    const fresh = runGate(verdict.data, { minNegativeRatio: pinnedPolicy.minNegativeRatio, acceptanceInScore: true, actionVocabulary: pack?.actionVocabulary, volatileReadings: pack?.volatileReadings });
    if (!passed || fresh.score < pinnedPolicy.minGateScore || canonicalJSON(fresh) !== canonicalJSON(report)) throw new LedgerError(409, "gate_not_passed");
    const summary = { runId, projectId, status: "waiting_review", stories: verdict.data.stories.length, cases: verdict.data.cases.length,
      gateScore: report.score, binding: run.binding, storiesRevision: stories.revision.id, casesRevision: cases.revision.id, gateRevision: gate.revision.id,
      plannerExecution: run.binding.models.entry === "host" ? "host" : "managed", stageServiceModelCalls: 0,
      hostUsage: { calls: null, tokens: null, usd: null, evidence: "unavailable" }, finalizedAt: new Date().toISOString() };
    const result = save(runId, projectId, "finalize", summary, [instructions.revision.id, stories.revision.id, cases.revision.id, gate.revision.id]);
    // Compatibility projection is committed with the authoritative receipt. Review reads this same bundle.
    const bundle = { ...(cases.content as CaseBundle), gate: report };
    store().db.prepare(`INSERT INTO wf_node_outputs VALUES (?,?,?,?) ON CONFLICT(wfRunId,nodeId)
      DO UPDATE SET json=excluded.json,updatedAt=excluded.updatedAt`).run(runId, "gate", canonicalJSON(bundle), summary.finalizedAt);
    store().db.prepare("UPDATE wf_runs SET status='waiting_review',finishedAt=? WHERE id=?").run(summary.finalizedAt, runId);
    return { ...summary, revisionId: result.revisionId };
  })();
}
/** Runtime completion is accepted from verified server receipts, never file presence. */
export function registeredStageProducts(runId: string) {
  const run = runLedger().registration(runId);
  if (!run || run.binding.models.mode !== "skill") return { protected: false as const };
  if (!receipt(runId, "finalize")) return { protected: true as const, finalized: false as const };
  finalizeRun(runId, run.projectId); // Revalidate immutable inputs and all stage receipts at every read.
  const cases = current(runId, run.projectId, "cases").content as CaseBundle;
  const gate = current(runId, run.projectId, "gate").content as { report: ReturnType<typeof runGate> };
  return { protected: true as const, finalized: true as const,
    products: { bundle: { ...cases, gate: gate.report }, dir: "server:immutable-revisions" } };
}
