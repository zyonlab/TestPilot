import { startPreparation, preparationStep, preparationStatus } from './preparation.js';
import { controls, setControls, beginStage, stageEvent } from './workflowControls.js';
import { runRoleSpend } from './roleSpend.js';
import { runReport } from "./runReport.js";
import { executionDetail } from "./executionDetail.js";
import { proposeFromExecution, proposeFromRejections, listRegressionCandidates, decideRegressionCandidate } from "./regressionCandidates.js";
import { revisionLineage, revisionDiff, approvalHistory } from "./artifactViews.js";
import { Router } from "express";
import { LedgerError } from "./runLedger.js";
import { assertProject, authorizeRun, registerHostRun, runLedger } from "./runService.js";
import type { ArtifactRevision } from "@testpilot/harness-core/run-contracts";
import { loadRunInstructions, retrieveRunSpec, writeRunStage, gateRun, finalizeRun, registeredStageProducts } from "./runStages.js";
import { claimUnit, mergeUnits, unitStatus, writeUnit } from "./workUnits.js";
import { reviewRevisions, compiledReadiness, reviseReviewedCase, decideRevisions, generateApprovedCode } from "./approvedRuns.js";
import { reviewerPrincipal } from "./reviewPrincipal.js";
import { flushDecisionDelivery } from "./decisionDelivery.js";
import { startWorkflowExecution, listWorkflowExecutions, cancelWorkflowExecutions } from "./workflowExecution.js";
import { executionBaseline, setExecutionBaseline, compareToBaseline } from "./executionBaseline.js";
import { writeModulePlan, modulePlanState, freezeModulePlan } from "./moduleStage.js";
import { rerunProjectNode, createWebWorkflow, workflowCheckpoint, cancelProjectWorkflow, resumeProjectWorkflow } from "./workflowOps.js";

export function runRouter() {
  const router = Router({ mergeParams: true });
  const wrap = (fn: (req: any, res: any) => unknown) => async (req: any, res: any) => {
    try { assertProject(req.params.projectId); await fn(req, res); }
    catch (error) {
      /**
       * **守卫拒绝时要说出理由。**
       *
       * 2026-09-16 实测：一条用例的收尾步骤是「点删除并确认」，环境没勾「允许不可逆」，
       * 执行被守卫挡下——而这里把它压成了 `run_request_invalid`，界面上只有这一个词。
       * 人看不出是哪一步、为什么、该去勾哪个开关。守卫的 `why` 本来就是写给人看的。
       */
      const code = (error as { code?: string }).code;
      if (typeof code === "string" && code.startsWith("GUARD_")) return res.status(403).json({ code, message: (error as Error).message });
      const e = error instanceof LedgerError ? error : new LedgerError(400, "run_request_invalid"); res.status(e.status).json({ code: e.code });
    }
  };
  router.get("/", wrap((req, res) => res.json({ runs: runLedger().listRuns(req.params.projectId) })));
  router.post("/", wrap(async (req, res) => res.status(202).json(await createWebWorkflow(req.params.projectId, req.body))));
  router.post("/register", wrap((req, res) => res.status(201).json(registerHostRun(req.params.projectId, req.body))));
  router.get("/artifacts", wrap((req, res) => res.json({ revisions: runLedger().listRevisions(req.params.projectId) })));
  router.get("/:runId", wrap((req, res) => res.json(runLedger().getRun(req.params.runId, req.params.projectId))));
  router.get('/:runId/controls',wrap((req,res)=>res.json(controls(req.params.runId,req.params.projectId))));
  router.post('/:runId/controls',wrap((req,res)=>{reviewerPrincipal(req);res.json(setControls(req.params.runId,req.params.projectId,req.body));}));
  router.post('/:runId/begin-stage',wrap((req,res)=>{authorizeRun(req.params.runId,req.headers.authorization?.replace(/^Bearer /,''));res.json(beginStage(req.params.runId,req.params.projectId,req.body));}));
  router.get("/:runId/spend", wrap((req, res) => res.json(runRoleSpend(req.params.runId, req.params.projectId))));
  // 归因报表：四节点成绩单 + 成本 + 单元 + 门禁 + 执行，按固定规则归到六层（runReport.ts）。
  router.get("/:runId/report", wrap((req, res) => res.json(runReport(req.params.runId, req.params.projectId))));
  router.get('/:runId/progress', wrap((req, res) => {
    const ledger = runLedger(), run = ledger.getRun(req.params.runId, req.params.projectId);
    const node = req.query.node;
    if (typeof node !== 'string' || !['source','modules','instructions','stories','cases','gate','finalize','g2','execution','review'].includes(node)) throw new LedgerError(400, 'invalid_node');
    const progress = node === 'stories' || node === 'cases' ? unitStatus(req.params.runId, req.params.projectId, node) : node === 'g2' ? preparationStatus(req.params.runId, req.params.projectId) : null;
    const events = ledger.db.prepare('SELECT json FROM workflow_events WHERE runId=? AND node=? ORDER BY rowid DESC LIMIT 100').all(req.params.runId,node) as {json:string}[];
    res.json({status:run.status, node:run.nodes.find(n=>n.node===node), progress,
      events:[...events.map(e=>JSON.parse(e.json)), ...run.revisions.filter(r=>r.name.startsWith(`units/${node}/`)).map(r=>({id:r.id,at:r.createdAt,phase:'done',artifactName:r.name}))].sort((a,b)=>a.at.localeCompare(b.at)).slice(-100), error:run.detail.error});
  }));
  router.get("/:runId/checkpoint", wrap((req, res) => res.json(workflowCheckpoint(req.params.runId, req.params.projectId))));
  router.post("/:runId/cancel", wrap(async (req, res) => { reviewerPrincipal(req); res.json(await cancelProjectWorkflow(req.params.runId, req.params.projectId)); }));
  router.post("/:runId/rerun", wrap(async (req,res) => { reviewerPrincipal(req); res.status(202).json(await rerunProjectNode(req.params.runId,req.params.projectId,req.body)); }));
  router.post("/:runId/resume", wrap(async (req, res) => { reviewerPrincipal(req); res.json(await resumeProjectWorkflow(req.params.runId, req.params.projectId, req.body?.mode === 'next-node')); }));
  router.get("/:runId/review", wrap((req, res) => res.json({ cases: reviewRevisions(req.params.runId, req.params.projectId), compiled: compiledReadiness(req.params.runId,req.params.projectId) })));
  router.post('/:runId/preparation/start', wrap(async (req,res)=>{reviewerPrincipal(req);res.status(202).json(await startPreparation(req.params.runId,req.params.projectId,req.body));}));
  router.post('/:runId/preparation/step', wrap(async (req,res)=>{authorizeRun(req.params.runId,req.headers.authorization?.replace(/^Bearer /,''));res.json(await preparationStep(req.params.runId,req.params.projectId,req.body));}));
  router.get("/:runId/executions", wrap((req, res) => res.json({ executions: listWorkflowExecutions(req.params.runId, req.params.projectId) })));
  // 执行基线与对比：判决集的基线，不是逐步截图——被测对象是实时行情页，截图基线在它上面每次都红。
  router.get("/:runId/executions/baseline", wrap((req, res) => res.json({ baseline: executionBaseline(req.params.runId, req.params.projectId) ?? null })));
  router.post("/:runId/executions/baseline", wrap((req, res) => res.json(setExecutionBaseline(req.params.runId, req.params.projectId, req.body, reviewerPrincipal(req).id))));
  // 一次执行的明细：每条用例的过程、判据、截图，连同视觉基线、性能基线与 Midscene 报告（executionDetail.ts）。
  router.get("/:runId/executions/detail/:executionId", wrap((req, res) => res.json(executionDetail(req.params.runId, req.params.projectId, req.params.executionId))));
  router.get("/:runId/executions/compare", wrap((req, res) => res.json(compareToBaseline(req.params.runId, req.params.projectId, { executionId: req.query.executionId }))));
  router.post("/:runId/review", wrap(async (req, res) => {
    const results = decideRevisions(req.params.runId, req.params.projectId, req.body, reviewerPrincipal(req));
    const cases=reviewRevisions(req.params.runId,req.params.projectId);
    stageEvent(req.params.runId,req.params.projectId,'review',cases.length&&cases.every(c=>c.approval)?'done':'waiting_review');
    // 驳回且写了理由：留一条反例候选给生成器回归（regressionCandidates.ts）。
    const regression = proposeFromRejections(req.params.runId, req.params.projectId, results as Array<Record<string, unknown>>, typeof req.body?.note === "string" ? req.body.note : undefined);
    res.json({ results, delivery: await flushDecisionDelivery(), regressionCandidates: regression.created.map((c) => c.id) });
  }));
  // 回归候选：执行判定失败 / 驳回的用例 → 候选 → 人批准 → 项目回归集。
  router.get("/:runId/regression-candidates", wrap((req, res) => res.json({ candidates: listRegressionCandidates(req.params.projectId, { runId: req.params.runId, status: typeof req.query.status === "string" ? req.query.status : undefined }) })));
  router.post("/:runId/regression-candidates", wrap((req, res) => res.json(proposeFromExecution(req.params.runId, req.params.projectId, req.body))));
  router.post("/:runId/regression-candidates/:candidateId", wrap((req, res) => res.json(decideRegressionCandidate(req.params.projectId, req.params.candidateId, req.body, reviewerPrincipal(req)))));
  router.patch("/:runId/review", wrap((req, res) => res.json(reviseReviewedCase(req.params.runId, req.params.projectId, req.body, reviewerPrincipal(req)))));
  const stageActions: Record<string, (runId: string, projectId: string, body: any) => unknown> = {
    instructions: loadRunInstructions, retrieve: retrieveRunSpec,
    // 模块树：模型提议 → 服务端机检；冻结那一步在下面单独一条路由，因为它必须是人。
    modules: (id, project, body) => writeModulePlan(id, project, body?.content ?? body),
    "modules/state": (id, project) => modulePlanState(id, project),
    stories: (id, project, body) => writeRunStage(id, project, "stories", body.content),
    cases: (id, project, body) => writeRunStage(id, project, "cases", body.content),
    gate: gateRun, finalize: finalizeRun,
    g2: generateApprovedCode,
    execute: startWorkflowExecution,
    decisions: (id, project) => { const decisions = reviewRevisions(id, project).flatMap(c => c.approval ? [{ ...c.approval, decidedByKind: "human", by: c.approval.principal.id }] : []); return { decisions, count: decisions.length }; },
    status: (id, project) => { runLedger().requireRun(id, project); const state = registeredStageProducts(id); return { registered: state.protected, finalized: state.protected && state.finalized }; },
    // 单元循环（docs/v3/history/22）：拆分由服务端做，规划器一次只领一个单元。
    "units/claim": (id, project, body) => claimUnit(id, project, body, "planner"),
    "units/write": (id, project, body) => writeUnit(id, project, body),
    "units/status": (id, project, body) => unitStatus(id, project, body?.node),
    // 全部单元写完之后的合并可以单独重试：整份校验（出处、故事冻结）会在这里失败，
    // 而那时最后一个单元已经写完，没有重试入口就只能重写一个单元来触发合并。
    "units/merge": (id, project, body) => mergeUnits(id, project, (body?.node ?? "cases") as "stories" | "cases"),
  };
  for (const [action, handler] of Object.entries(stageActions)) router.post(`/:runId/stages/${action}`, wrap(async (req, res) => {
    if (["g2", "execute"].includes(action) && !req.headers.authorization) reviewerPrincipal(req);
    else authorizeRun(req.params.runId, req.headers.authorization?.replace(/^Bearer /, ""));
    if(['g2','execute'].includes(action)) {
      const start=beginStage(req.params.runId,req.params.projectId,{node:action==='execute'?'execution':'g2'});
      if(['paused','cancelled','failed'].includes(start.status))return res.json(start);
    }
    let result;
    try { result=await handler(req.params.runId, req.params.projectId, req.body); }
    catch(error) {
      if(action==='g2')stageEvent(req.params.runId,req.params.projectId,'g2','blocked',error instanceof LedgerError?error.code.slice(0,1900):'preparation_failed');
      throw error;
    }
    if(action==='g2'){const r=result as {status:string;revision:{id:string}};stageEvent(req.params.runId,req.params.projectId,'g2',r.status==='ready_to_execute'?'done':'blocked',undefined,r.revision.id);}
    res.json(result);
  }));
  router.post("/:runId/events", wrap((req, res) => {
    authorizeRun(req.params.runId, req.headers.authorization?.replace(/^Bearer /, ""));
    if (req.body.runId !== req.params.runId) throw new LedgerError(409, "event_run_conflict");
    if (!String(req.body.node).startsWith("host:")) throw new LedgerError(403, "server_stage_event_reserved");
    res.json(runLedger().appendEvent(req.body, req.params.projectId));
  }));
  // Imported output is untrusted content. Only the stage service may validate/finalize it.
  router.post("/:runId/artifacts", wrap((req, res) => {
    authorizeRun(req.params.runId, req.headers.authorization?.replace(/^Bearer /, ""));
    const { name, kind, content, mediaType, sourceRefs, parentRevision } = req.body;
    if (!["material", "spec", "stories", "cases", "code", "report"].includes(kind)) throw new LedgerError(403, "reserved_artifact_kind");
    /**
     * **产物名字也是保留的，不只是 kind。**
     *
     * 单元循环把「整份写入」挡在了 stage 路由上（workUnits.assertWholeWriteAllowed），
     * 但这条通用导入路由只查 kind，不查 name。2026-09-11 第二轮实测：门禁把一条臂的
     * `validated/cases` 判为不通过之后，规划器用这条路由把同名产物从 53 条用例覆盖成了
     * 1 条探针用例——绕过了合并校验、绕过了故事冻结，而且覆盖的是**门禁刚刚判过的那一份**。
     *
     * `validated/` 与 `units/` 两个前缀只能由服务端的 stage 服务写。规划器要留探针，
     * 换个名字就行。
     */
    if (typeof name === "string" && /^(validated|units|regression-candidate|preparation|g2)\//.test(name)) throw new LedgerError(403, "reserved_artifact_name");
    res.json(runLedger().putRevision({ projectId: req.params.projectId, runId: req.params.runId, name,
      kind: kind as ArtifactRevision["kind"], content, mediaType, sourceRefs, parentRevision }, { kind: "agent", id: "host-import" }));
  }));
  // 冻结模块树：和 gold 一样，这一笔必须由人落。带 run 令牌调会被 reviewerPrincipal 拒。
  router.post("/:runId/modules/freeze", wrap((req, res) => res.json(freezeModulePlan(req.params.runId, req.params.projectId, reviewerPrincipal(req), typeof req.body?.note === "string" ? req.body.note : undefined))));
  router.get("/:runId/review-history", wrap((req, res) => res.json({ events: approvalHistory(req.params.runId, req.params.projectId) })));
  for (const action of ["lineage", "diff", "export"]) router.get(`/:runId/artifacts/:revisionId/${action}`, wrap((req, res) => {
    const revision = runLedger().revision(req.params.revisionId, req.params.projectId);
    if (revision.runId !== req.params.runId) throw new LedgerError(409, "revision_run_conflict");
    if (action === "diff") return res.json(revisionDiff(req.params.projectId, revision.id, typeof req.query.previous === "string" ? req.query.previous : undefined));
    const lineage = revisionLineage(req.params.projectId, revision.id);
    if (action === "export") {
      const run = runLedger().getRun(req.params.runId, req.params.projectId);
      res.attachment(`${revision.kind}-v${revision.revision}.json`);
      return res.json({ ...lineage, runId: run.id, binding: run.binding, approvals: approvalHistory(run.id, req.params.projectId) });
    }
    res.json(lineage);
  }));
  router.get("/:runId/artifacts/:revisionId", wrap((req, res) => {
    const result = runLedger().readRevision(req.params.revisionId, req.params.projectId);
    if (result.revision.runId !== req.params.runId) throw new LedgerError(409, "revision_run_conflict");
    res.json(result);
  }));
  return router;
}
