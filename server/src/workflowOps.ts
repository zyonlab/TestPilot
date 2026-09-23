import { cancelPreparation } from './preparation.js';
import { cancelSourceSession } from "./sourceSessions.js";
import { getProject, resolveEnvironment } from "./db.js";
import { bindDomainReference } from "./domainReferences.js";
import { captureHostWebModels, captureWebModels } from './modelSnapshots.js';
import { observeProduct } from './procs.js';
import { partialObservationPath } from "@testpilot/harness-testing/exec";
import { ARTIFACT_DIR } from "./db.js";
import { controls, beginStage, stageEvent, resumeControls, setControls } from './workflowControls.js';
import { cancelRun as cancelCodex } from "./codex.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./procs.js";
import { bindRulePack, currentRulePack } from "./rulePacks.js";
import { canonicalJSON } from "@testpilot/harness-core/run-contracts";
import { contentHash, LedgerError } from "./runLedger.js";
import { materializeInputs, registerWebRun, runLedger } from "./runService.js";
import { dataPath } from "./datadir.js";
import { startRun as startWebRun, cancelRun } from "./penguinRun.js";
import { defaultRuntimeName, plannerRuntimeAvailable, type RuntimeName } from "./runtimes.js";
import { cancelNativeRun } from "./runtime/native-penguin.js";
import { cancelRun as cancelClaude } from "./claudecode.js";
import { cancelWorkflowExecutions } from "./workflowExecution.js";
import { loadRunInstructions, registeredStageProducts } from "./runStages.js";
import { StoryBundleSchema } from "@testpilot/harness-testing/casegen";
import { buildProductModel, charterFromRulePack, describeProductModel, validateRulePack, ContextManifestSchema, ExplorationReportSchema, ProductModelSchema, type ContextManifest, type ExplorationCharter, type ProductRulePack } from "@testpilot/harness-testing/domain";

export async function createWebWorkflow(projectId: string, raw: unknown, prepared?: {runId:string;node:string}) {
  const material = z.object({name:z.string().min(1).max(160),text:z.string().min(1).refine(text=>Buffer.byteLength(text,'utf8')<=2_000_000,'material_too_large')});
  const input = z.object({idempotencyKey:z.string().min(1).max(160),sourceKind:z.enum(['spec','explore']).default('spec'),outputLanguage:z.enum(['zh','en','ja']).default('zh'),maxScreens:z.number().int().min(0).max(50).default(getProject(projectId)?.explorationMaxScreens ?? 8),explorationScope:z.enum(["current-url","rules"]).default(getProject(projectId)?.explorationScope ?? "rules"),sourceUrl:z.string().url().optional(),exploreActions:z.enum(['observe','interact']).default('observe'),exploreWallet:z.boolean().optional(),materials:z.array(material).max(20).default([]),knowledge:z.array(material.extend({roles:z.array(z.enum(['source','stories','cases','gate'])).default(['stories','cases'])})).max(20).default([]),rulePacks:z.array(z.unknown()).max(5).default([]),workUnits:z.boolean().default(false),importProductModel:z.unknown().optional(),importStories:z.unknown().optional(),limit:z.number().int().min(1).max(50).default(12),envRef:z.string().optional(),planner:z.enum(['claude-code','codex','penguin']).optional()}).parse(raw);
  /**
   * 禁止名单上的地址什么都不跑（`config.guard.denyHosts`，运营方配置）。环境与运行参数都放不开它。
   * 探索不带钱包、不点会改状态的东西也不行：观察本身会带着登录态与会话去访问那个地址。
   */
  if(input.sourceKind==='explore'){const target=(()=>{try{return new URL(input.sourceUrl!).hostname;}catch{return '';}})();if(config.guard.denyHosts.includes(target))throw new LedgerError(403,`explore_host_denied:${target}`);}
  if(input.maxScreens===0)input.explorationScope="current-url";
  // 探索要不要带钱包：运行没说，就按这个项目环境的画像（人勾选的 injectWallet）。
  if(input.exploreWallet===undefined)input.exploreWallet=!!resolveEnvironment(projectId,input.envRef)?.injectWallet;
  if(new Set(input.materials.map(m=>basename(m.name).toLowerCase())).size!==input.materials.length)throw new LedgerError(400,'duplicate_material_name');
  if([...input.materials,...input.knowledge].reduce((sum,m)=>sum+Buffer.byteLength(m.text,'utf8'),0)>40_000_000)throw new LedgerError(400,'total_materials_too_large');
  if(input.materials.some(m=>!(/\.(md|txt)$/i.test(m.name))||m.text.includes('\u0000')))throw new LedgerError(400,'text_material_required');
  if (input.sourceKind==='spec'&&!input.materials.length) throw new LedgerError(400,'spec_materials_required');
  if (input.sourceKind==='explore'&&(!input.sourceUrl||!/^https?:/.test(input.sourceUrl))) throw new LedgerError(400,'explore_url_required');
  // 规则包在创建时就校验：悬空引用、无来源的要求、无依据的 P0 在这里被拒，不是等到模型用了才发现。
  /**
   * 没显式给规则包时，用**项目当前那一份**。
   *
   * 以前不给就是没有：同一个项目连着跑两次，一次贴了包一次忘了，产出的东西完全不是
   * 一回事，而界面上看不出差别。规则包属于项目，运行只是引用它。
   */
  if(!prepared&&!input.rulePacks.length){const current=currentRulePack(projectId);if(current)input.rulePacks=[current];}
  const packs=input.rulePacks.map(raw=>{const v=validateRulePack(raw);if(!v.ok)throw new LedgerError(400,`invalid_rule_pack:${v.errors.slice(0,3).map(e=>`${e.code}@${e.jsonPointer}`).join(';')}`);return v;});
  if(new Set(packs.map(p=>p.pack.id)).size!==packs.length)throw new LedgerError(400,'duplicate_rule_pack_id');
  /**
   * 冻结的上游产品模型可以直接导入。
   *
   * 两条规划臂要比的是**规划**，不是探索——所以它们必须吃同一份证据。导入的模型仍然要过
   * schema，并且要和本次绑定的规则包哈希一致：拿另一个规则包下算出来的模型配这份规则包，
   * 单元范围就会对不上，而那种错在下游表现为「引用了不存在的功能」，很难追。
   */
  const imported=input.importProductModel!==undefined?ProductModelSchema.parse(input.importProductModel):undefined;
  if(imported&&!packs.some(p=>p.hash===imported.rulePack.hash))throw new LedgerError(400,'imported_product_model_rule_pack_mismatch');
  if(input.workUnits&&!imported&&input.sourceKind!=='explore')throw new LedgerError(400,'work_units_require_product_model');
  /**
   * 冻结的上游**故事**也可以导入——这是单节点对照跑的前提。
   *
   * 要比两条臂在 cases 这一个节点上的产出，它们必须领到**同一批用例单元**；而单元是按
   * `validated/stories` 里的故事一条一条拆的。不导入故事，两条臂各自先写一遍故事，
   * 单元名、范围、数量全不一样，后面比的就不是同一件事了。
   *
   * 仍然过同一个故事校验器；只在开了 workUnits 的 run 上允许，别的 run 用不到它。
   */
  const importedStories=input.importStories!==undefined?StoryBundleSchema.parse(input.importStories):undefined;
  if(importedStories&&!input.workUnits)throw new LedgerError(400,'imported_stories_require_work_units');
  const ledger = runLedger(); ledger.db.exec("CREATE TABLE IF NOT EXISTS workflow_start_requests (projectId TEXT NOT NULL, idempotencyKey TEXT NOT NULL, hash TEXT NOT NULL, runId TEXT NOT NULL, PRIMARY KEY(projectId,idempotencyKey))");
  const hash = contentHash(canonicalJSON(input));
  const prior = ledger.db.prepare("SELECT hash,runId FROM workflow_start_requests WHERE projectId=? AND idempotencyKey=?").get(projectId, input.idempotencyKey) as { hash: string; runId: string } | undefined;
  if (prior) { if (prior.hash !== hash) throw new LedgerError(409, "workflow_start_conflict"); return { wfRunId: prior.runId, created: false }; }
  /**
   * 规划由谁跑，在创建这一刻定下并记进运行：续跑必须用同一个运行时，否则模型绑定对不上。
   * 起不来的（本机没有 `claude`、没装 Penguin）当场拒掉，而不是探索跑完几分钟之后才失败。
   */
  const plannerRuntime=input.planner??defaultRuntimeName();
  if(plannerRuntime!=='claude-code'&&plannerRuntime!=='codex'&&plannerRuntime!=='penguin')throw new LedgerError(400,`web_planner_runtime_unsupported:${plannerRuntime}`);
  if(!plannerRuntimeAvailable(plannerRuntime))throw new LedgerError(400,`planner_runtime_unavailable:${plannerRuntime}`);
  const runId = prepared?.runId ?? `run-${randomUUID()}`;
  const models=plannerRuntime==='penguin'?captureWebModels(runId,projectId,'penguin','skill'):captureHostWebModels(runId,projectId,plannerRuntime);
  ledger.db.prepare("INSERT INTO workflow_start_requests VALUES (?,?,?,?)").run(projectId, input.idempotencyKey, hash, runId);
  const directory = dataPath(`uploads/${runId}`); mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [i, material] of input.materials.entries()) writeFileSync(join(directory, `${i}-${basename(material.name).replace(/[^\p{L}\p{N}_. -]/gu, "_").slice(0, 100)}.md`), material.text, { mode: 0o600 });
  /**
   * 这两个开关必须进 `parameters`，不能只活在这次调用的闭包里：
   * 运行被中断之后从检查点接着跑（第 168 行那条路）读的就是 `registered.input.parameters`，
   * 漏了它们，重跑出来的就是另一种探索——而没有人会知道这一次和上一次的差别在哪。
   * 它们同时也是这次运行**被授权做过什么**的凭证：谁允许探索去点会改状态的东西，记在这里。
   */
  const params={sourceKind:input.sourceKind,sourceUrl:input.sourceUrl,limit:input.limit,outputLanguage:input.outputLanguage,maxScreens:input.maxScreens,explorationScope:input.explorationScope,envRef:input.envRef,stageControlVersion:1,exploreActions:input.exploreActions,exploreWallet:input.exploreWallet,plannerRuntime,launchedBy:'web',...(input.workUnits?{workUnits:1}:{})};
  registerWebRun(runId,projectId,models.binding,params);
  for(const knowledge of input.knowledge) ledger.putRevision({projectId,runId,name:`knowledge/${knowledge.name}`,kind:'report',content:{...knowledge,trust:'user-provided',executable:false}}, {kind:'system',id:'web'});
  // 规则包是结构化知识：source 节点用它建 charter，故事/用例/门禁也能引用规则 ID。
  if(!prepared)for(const {pack,hash} of packs) bindRulePack(runId,projectId,pack,hash,{kind:'system',id:'web'});
  // 领域参考：项目当前那一版冻结绑定进这次运行；没有就没有（domainReferences.ts）。
  if(!prepared)bindDomainReference(runId,projectId);
  if(imported)ledger.putRevision({projectId,runId,name:'product/model-candidate',kind:'report',content:imported},{kind:'system',id:'web'});
  if(importedStories)ledger.putRevision({projectId,runId,name:'validated/stories',kind:'stories',content:importedStories},{kind:'system',id:'stage-validator'});
  // Acknowledge creation immediately; the source node owns exploration and its failures.
  if (!prepared) void launchSource(runId,projectId,directory,params,input.envRef).catch(()=>{});
  return {wfRunId:runId,created:true};
}
/**
 * source 节点的知识绑定：读这次 run 里 roles 含 `source` 的规则包，建 charter 和 ContextManifest。
 *
 * 没有规则包不是错——那是「通用探索」，manifest 里明写；有规则包却解析不了才是错。
 * 一个 run 目前只绑一个规则包给 source（多包融合在 P-26）。
 */
export function sourceKnowledge(runId:string,projectId:string,entryUrl:string,maxScreens:number,environmentRef?:string,allowStateChange=false):{charter?:ExplorationCharter;pack?:ProductRulePack;packRevision?:string;manifest:ContextManifest}{
  const ledger=runLedger();
  const packs=ledger.listRevisions(projectId,runId).filter(r=>r.name.startsWith('knowledge/rulepack/')).map(r=>({revision:r.id,content:ledger.readRevision(r.id,projectId).content as {roles?:string[];rulePack?:unknown;rulePackHash?:string}})).filter(k=>k.content.roles?.includes('source'));
  const generic=ledger.listRevisions(projectId,runId).filter(r=>r.name.startsWith('knowledge/')&&!r.name.startsWith('knowledge/rulepack/')).map(r=>({revision:r.id,content:ledger.readRevision(r.id,projectId).content as {roles?:string[];name?:string}})).filter(k=>k.content.roles?.includes('source'));
  const first=packs[0];
  let charter:ExplorationCharter|undefined,pack:ProductRulePack|undefined,hash='';
  if(first){const v=validateRulePack(first.content.rulePack);if(!v.ok)throw new LedgerError(409,'bound_rule_pack_invalid');pack=v.pack;hash=v.hash;if(first.content.rulePackHash!==hash)throw new LedgerError(409,'bound_rule_pack_hash_mismatch');charter=charterFromRulePack(pack,hash,{entryUrl,maxScreens,environmentRef,allowStateChange});}
  const manifest=ContextManifestSchema.parse({schemaVersion:'context-manifest.v2',manifestId:`ctx-${runId}-source-0`,projectId,runId,node:'source',attempt:0,role:{id:'explorer-planner',version:'1'},skills:[],
    knowledge:[...(first&&pack?[{packId:pack.id,revision:first.revision,hash,ruleIds:pack.rules.map(r=>r.id),purpose:'exploration charter'}]:[]),...generic.map(g=>({packId:g.content.name??g.revision,revision:g.revision,hash:contentHash(canonicalJSON(g.content)),ruleIds:[],purpose:'free-text knowledge (not machine-checked)'}))],
    inputs:[{pointer:'/entryUrl',digest:contentHash(entryUrl)}],toolGrants:['browser.observe','browser.activate-ui'],budget:{maxScreens},
    truncation:{omittedOptionalRefs:packs.slice(1).map(p=>p.revision),missingRequiredRefs:[]},isolationEvidence:'service-scoped'});
  return {charter,pack,packRevision:first?.revision,manifest};
}
/**
 * 捡起探索器落下的半成品（`exec/interactive.ts` 的 `snapshotPartial`）。
 *
 * 路径按约定拼：观察的 execId 是 `observe-<projectId>`（见 index.ts 的 setAgentObserver），
 * 一个项目同时只探索一份，所以这个名字够用。读不到、读坏了都当作没有——
 * 捡不回来是可以接受的，捡回来一份半个 JSON 不行。
 */
export function readPartialObservation(projectId:string):{notes:string;url:string;screens:number;graph:unknown;stoppedBecause:unknown}|undefined{
  try{
    // 落点由探索器那一侧的函数算，两处共用——见 `partialObservationPath` 的注释。
    const path=partialObservationPath(ARTIFACT_DIR,`observe-${projectId}`);
    const raw=JSON.parse(readFileSync(path,'utf8')) as {notes?:string;url?:string;screens?:number;graph?:unknown};
    if(!raw?.notes?.trim())return undefined;
    // 半成品里没有状态图（`graph` 要循环跑完才建得出来）。给 undefined 而不是编一个空图：
    // 下游读到「没有图」是真的没有，读到一个空图会以为这个产品只有一屏。
    return {notes:raw.notes,url:raw.url??'',screens:raw.screens??0,graph:undefined,
      stoppedBecause:`探索中途失败，这份材料只到第 ${raw.screens ?? 0} 屏`};
  }catch{return undefined;}
}

async function launchSource(runId:string,projectId:string,directory:string,params:{sourceKind:string;sourceUrl?:string;limit:number;stageControlVersion:number;outputLanguage?:string;maxScreens?:number;explorationScope?:"current-url"|"rules";envRef?:string;exploreActions?:string;exploreWallet?:boolean},envRef?:string){
  const ledger=runLedger();
  const putSourceRevision: typeof ledger.putRevision = (input, actor) => {
    const previous = ledger.listRevisions(projectId, runId).filter(r => r.name === input.name && r.kind === input.kind).sort((a,b) => b.revision - a.revision)[0];
    return ledger.putRevision({ ...input, parentRevision: previous?.id ?? null }, actor);
  };
  try {
    if(beginStage(runId,projectId,{node:'source'}).status==='paused')return;
    if(params.sourceKind==='explore'){
      const interact=params.exploreActions==='interact';
      const bound=sourceKnowledge(runId,projectId,params.sourceUrl!,params.maxScreens??8,envRef??params.envRef,interact);
      const manifestRevision=putSourceRevision({runId,projectId,name:'context/source',kind:'report',content:bound.manifest,sourceRefs:bound.manifest.knowledge.map(k=>k.revision)},{kind:'system',id:'stage-validator'});
      /**
       * **探索崩了，也要把已经采到的屏捡回来。**
       *
       * 2026-09-14 调研（docs/v3 的三项顾虑）：九个节点里只有探索是「中途挂 = 全丢」。
       * 它同时是最长的一个——这次的材料是 187,669 字，跑满 20 屏要几十分钟加一次钱包会话。
       * 探索器现在每采到一屏就落一次半成品（`exec/interactive.ts` 的 `snapshotPartial`），
       * 这里在失败路径上把它捡起来：有材料就带着已采到的屏继续走，没有才如实抛。
       *
       * 这**不是**断点续跑：不会从第 18 屏接着探。它保证的是已经花掉的钱不白白作废，
       * 而且这件事要在材料里写明白——下游读到的是一份 18 屏的材料，不是 20 屏的。
       */
      let result:{notes:string;url:string;screens:unknown;stoppedBecause:unknown;graph:unknown;report?:unknown;partial?:boolean};
      let partialReason:string|undefined;
      try {
        result=await observeProduct({workflowRunId:runId,url:params.sourceUrl,projectId,envRef:envRef??params.envRef,deep:true,maxScreens:params.maxScreens??8,explorationScope:params.maxScreens===0?"current-url":params.explorationScope,settleMs:interact?3000:1800,scenarioFirst:true,inPageFirst:'on',groupCap:6,...(params.exploreWallet?{wallet:true}:{}),...(bound.charter?{charter:bound.charter}:{})}) as typeof result;
      } catch(error) {
        const salvaged=readPartialObservation(projectId);
        if(!salvaged?.notes?.trim())throw error;
        partialReason=String((error as Error).message??error).slice(0,300);
        result={...salvaged,partial:true};
        putSourceRevision({runId,projectId,name:'report/exploration-partial',kind:'report',
          content:{screens:salvaged.screens,reason:partialReason,at:new Date().toISOString()},sourceRefs:[manifestRevision.id]},{kind:'system',id:'explorer'});
      }
      if(ledger.getRun(runId,projectId).status==='cancelled')return;
      if(!result.notes?.trim())throw new Error('exploration_returned_no_observations');
      const observation=putSourceRevision({runId,projectId,name:'exploration/observations',kind:'report',content:result,sourceRefs:[manifestRevision.id]},{kind:'system',id:'explorer'});
      let productText='';
      if(bound.charter){
        // charter 给了，回执就必须回来；回不来是探索器的错，不能静默降级成旧材料。
        const report=ExplorationReportSchema.parse(result.report);
        if(report.rulePack.hash!==bound.charter.rulePack.hash)throw new Error('exploration_report_rule_pack_mismatch');
        const reportRevision=putSourceRevision({runId,projectId,name:'exploration/report',kind:'report',content:report,sourceRefs:[observation.id,manifestRevision.id]},{kind:'system',id:'explorer'});
        const model=buildProductModel({pack:bound.pack!,report});
        putSourceRevision({runId,projectId,name:'product/model-candidate',kind:'report',content:model,sourceRefs:[reportRevision.id,bound.packRevision!]},{kind:'system',id:'stage-validator'});
        productText=`\n\n${describeProductModel(model)}\n`;
      }
      writeFileSync(join(directory,'exploration.md'),`# Observed product
Source: ${result.url}
Captured: ${new Date().toISOString()}
Context manifest: ${bound.manifest.manifestId}${bound.charter?` · rule pack ${bound.charter.rulePack.id}@${bound.charter.rulePack.version}`:' · generic exploration (no rule pack bound)'}

${result.notes}${productText}

Only observed behavior is evidence. Unobserved, authenticated, or transaction behavior must be explicitly marked as unknown.`,{mode:0o600});
      stageEvent(runId,projectId,'source','done',undefined,observation.id);
    } else stageEvent(runId,projectId,'source','done');
    await startWebRun({wfRunId:runId,target:{projectId,envRef:envRef??params.envRef},materialsDir:directory,limit:params.limit,params:params as never,generationMode:'skill',runtime:plannerOf(runId,projectId)});
  }catch(error){if(ledger.getRun(runId,projectId).status==='cancelled')return;stageEvent(runId,projectId,'source','failed',String(error instanceof Error?error.message:error).slice(0,1000));ledger.db.prepare("UPDATE wf_runs SET status='failed' WHERE id=?").run(runId);}
}

export function workflowCheckpoint(runId: string, projectId: string) {
  const ledger = runLedger(), run = ledger.requireRun(runId, projectId);
  if (!run.binding.inputHash) throw new LedgerError(409, "checkpoint_inputs_missing");
  for (const revision of ledger.listRevisions(projectId, runId)) ledger.readRevision(revision.id, projectId);
  const verified = registeredStageProducts(runId);
  const finalized = verified.protected && verified.finalized;
  const states = ledger.nodeStates(runId);
  /**
   * **`source` 与 `modules` 也要在这张清单里。**
   *
   * 2026-09-14 调研发现它们不在：一次在 `modules` 上失败的运行，`next` 会指向
   * `stories`——resume 于是把模块节点整个跳过去，而下游所有单元都按模块树切。
   * 清单要和 `workflowControls` 的 `nodes` 对齐（少了 g2/execution：那两个不由
   * resume 驱动，各自有自己的入口和幂等键）。
   *
   * 但这两个是**有条件的**：宿主注册的运行（`registerHostRun`）材料在注册时就交了，
   * 根本没有 `source` 节点，也不走模块规划。所以判据不能是「没 done 就回到它」——
   * 那会让每一个宿主运行 resume 到一个它从来没有过的节点上（测试当场红了，对的）。
   * 规则是：**走过、而且没走完**，才回到它；从没走过就不属于这条路径。
   * `instructions` 往后是必经的，仍然按「没 done 就回到它」。
   */
  const conditional = new Set(["source", "modules"]);
  const stages = ["source", "modules", "instructions", "stories", "cases", "gate", "finalize"];
  const done = (stage: string) => states.some(s => s.node === stage && s.phase === "done");
  const touched = (stage: string) => states.some(s => s.node === stage);
  const next = finalized ? "review"
    : stages.find(stage => (conditional.has(stage) ? touched(stage) && !done(stage) : !done(stage))) ?? "finalize";
  return { runId, inputHash: run.binding.inputHash, next, finalized, stages: states, materialRevisions: run.binding.materialRevisions,
    source: run.binding.models.entry, runtime: run.binding.models.runtime };
}
/** 这次运行登记时定下的规划运行时——续跑和首跑必须是同一个。 */
function plannerOf(runId: string, projectId: string): RuntimeName | undefined {
  const runtime = runLedger().requireRun(runId, projectId).binding.models.runtime;
  return runtime === "pipeline" ? undefined : runtime;
}
export async function cancelProjectWorkflow(runId: string, projectId: string) {
  runLedger().requireRun(runId, projectId);
  const status = runLedger().getRun(runId, projectId).status;
  if (["completed", "cancelled"].includes(status)) return { status, changed: false };
  runLedger().db.prepare("UPDATE wf_runs SET status='cancelled' WHERE id=?").run(runId);
  await cancelPreparation(runId,projectId);
  await cancelSourceSession(runId);
  cancelRun(runId); cancelNativeRun(runId); cancelClaude(runId); cancelCodex(runId);
  await cancelWorkflowExecutions(runId, projectId);
  runLedger().db.prepare("UPDATE wf_runs SET status='cancelled' WHERE id=?").run(runId);
  return { status: "cancelled", changed: true };
}
export function configureNextNode(runId:string,projectId:string,next:string) {
  const order = ['source','modules','stories','cases','gate','finalize','g2','execution'];
  const target = next === 'instructions' ? 'stories' : next;
  const index = order.indexOf(target);
  if (index < 0) throw new LedgerError(409,'workflow_no_next_node');
  const current = controls(runId,projectId), states = runLedger().nodeStates(runId);
  const boundaries = order.slice(index+1).filter(n=>!states.some(s=>s.node===n));
  setControls(runId,projectId,{breakpoints:[...new Set([...current.breakpoints.filter(n=>n!==target&&n!=='instructions'),...boundaries])]});
}
export async function resumeProjectWorkflow(runId: string, projectId: string, nextNodeOnly = false) {
  const ledger=runLedger();
  const registered=ledger.requireRun(runId,projectId);
  if(!registered.binding.inputHash){
    const row=ledger.getRun(runId,projectId);
    if(!['failed','cancelled','paused','interrupted'].includes(row.status))throw new LedgerError(409,'workflow_not_resumable');
    const params=registered.input.parameters;
    if(nextNodeOnly)configureNextNode(runId,projectId,'source');
    resumeControls(runId,projectId);
    stageEvent(runId,projectId,'source','queued','Continuation requested; waiting for executor');
    ledger.db.prepare("UPDATE wf_runs SET status='registered' WHERE id=?").run(runId);
    void launchSource(runId,projectId,dataPath(`uploads/${runId}`),params).catch(()=>{});
    return {status:'running'};
  }
  const checkpoint = workflowCheckpoint(runId, projectId);
  const row = ledger.getRun(runId, projectId);
  /**
   * `waiting_review` 有两种，能不能续跑正相反：
   *   - **走完了 finalize、等人复核**：不该续，它已经做完了；
   *   - **停在某个节点等人拍板**（眼下只有模块树冻结）：等的就是这一下。
   *
   * 2026-09-12：把「没跑完 = failed」改成说真话之后，停在等人冻结的运行变成 `waiting_review`，
   * 于是恢复被这道守卫按 `workflow_not_resumable` 挡住——人冻结完模块树，运行就再也走不下去了。
   * 状态说真话之后，守卫也得跟着认这句真话。
   */
  const awaitingHuman = row.status === "waiting_review" && !checkpoint.finalized;
  if (!awaitingHuman && !["paused", "cancelled", "interrupted", "failed", "infra_error", "budget_exhausted"].includes(row.status)) throw new LedgerError(409, "workflow_not_resumable");
  if (checkpoint.finalized) { ledger.db.prepare("UPDATE wf_runs SET status='waiting_review' WHERE id=?").run(runId); return { checkpoint, status: "waiting_review" }; }
  // 宿主自己登记的运行只能回宿主接着做；Web 发起、由宿主运行时规划的，Web 能再把它拉起来。
  if (checkpoint.source === "host" && registered.input.parameters?.launchedBy !== "web") { ledger.db.prepare("UPDATE wf_runs SET status='registered' WHERE id=?").run(runId); return { checkpoint, status: "registered", continuation: "continue_in_original_host" }; }
  if (nextNodeOnly) configureNextNode(runId, projectId, checkpoint.next);
  const pausedAt=controls(runId,projectId).pausedAt;
  resumeControls(runId,projectId);
  stageEvent(runId,projectId,pausedAt ?? checkpoint.next,'queued','Continuation requested; waiting for planner');
  const detail = row.detail as { penguin?: { workspace?: string }; target?: { envRef?: string }; parameters?: { limit?: number } };
  ledger.db.prepare("UPDATE wf_runs SET status='registered' WHERE id=?").run(runId);
  try {
    await startWebRun({ wfRunId: runId, target: { projectId, envRef: detail.target?.envRef }, workspace: detail.penguin?.workspace,
      materialsDir: dataPath(`inputs/${runId}`), limit: detail.parameters?.limit, params: registered.input.parameters, generationMode: "skill", runtime: plannerOf(runId, projectId), resumeStage: pausedAt ?? checkpoint.next });
    return { checkpoint, status: "running" };
  } catch (error) { ledger.db.prepare("UPDATE wf_runs SET status='failed' WHERE id=?").run(runId); throw error; }
}

/** Fork generation work without rewriting history or transferring execution approval. */
export async function rerunProjectNode(runId:string,projectId:string,raw:unknown) {
  const input=z.object({node:z.enum(['source','modules','stories','cases','gate']),idempotencyKey:z.string().min(1).max(160)}).parse(raw);
  const l=runLedger(), old=l.requireRun(runId,projectId), row=l.getRun(runId,projectId);
  if(['running','queued','pending'].includes(row.status))throw new LedgerError(409,'请先停止当前运行，再从节点重跑');
  if(old.input.parameters.launchedBy!=='web')throw new LedgerError(409,'该运行需在原宿主重跑');
  const order=['source','modules','instructions','stories','cases','gate'];
  const before=order.slice(0,order.indexOf(input.node));
  if(before.some(n=>!row.nodes.some(s=>s.node===n&&s.phase==='done')))throw new LedgerError(409,'上游节点尚未完成，请从更早的节点重跑');
  const all=l.listRevisions(projectId,runId);
  const latest=[...new Map(all.map(r=>[r.name,r])).values()];
  const knowledge=latest.filter(r=>r.name.startsWith('knowledge/'));
  const materials=old.binding.materialRevisions.map(id=>l.readRevision(id,projectId)).map(r=>({name:r.revision.name,text:typeof r.content==='string'?r.content:canonicalJSON(r.content)}));
  const params=old.input.parameters;
  const nextId='run-'+randomUUID();
  const created=await createWebWorkflow(projectId,{...params,idempotencyKey:'rerun:'+contentHash(runId+':'+input.node+':'+input.idempotencyKey),
    planner:params.plannerRuntime,workUnits:!!params.workUnits,
    materials:input.node==='source'&&params.sourceKind==='explore'?[]:materials,
    rulePacks:knowledge.filter(r=>r.name.startsWith('knowledge/rulepack/')).map(r=>(l.readRevision(r.id,projectId).content as any).rulePack),
  },{runId:nextId,node:input.node});
  if(!created.created)return created;
  try {
    const revisions=new Map<string,string>();
    const copy=(r:typeof latest[number])=>{
      const prior=l.listRevisions(projectId,nextId).filter(v=>v.name===r.name).at(-1);
      const copied=l.putRevision({projectId,runId:nextId,name:r.name,kind:r.kind,mediaType:r.mediaType,
        content:l.readRevision(r.id,projectId).content,sourceRefs:[r.id],parentRevision:prior?.id??null},{kind:'system',id:'rerun'});
      revisions.set(r.id,copied.id);return copied;
    };
    for(const r of knowledge)copy(r);
    l.putRevision({projectId,runId:nextId,name:'report/rerun-origin',kind:'report',content:{parentRunId:runId,fromNode:input.node,mode:'next-node'}},{kind:'system',id:'rerun'});
    if(input.node!=='source'){
      const inherited=latest.filter(r=>r.name.startsWith('exploration/')||r.name==='product/model-candidate'||r.name==='context/source'||before.filter(n=>n!=='instructions').some(n=>r.name==='validated/'+n));
      for(const id of old.binding.materialRevisions)copy(l.readRevision(id,projectId).revision);
      for(const r of inherited)copy(r);
      l.sealInputs(nextId,projectId,old.binding.materialRevisions.map(id=>revisions.get(id)!));
      for(const node of before){
        if(node==='instructions'){beginStage(nextId,projectId,{node});loadRunInstructions(nextId,projectId);continue;}
        const r=node==='source'?undefined:l.db.prepare('SELECT json FROM run_stage_receipts WHERE runId=? AND stage=?').get(runId,node) as {json:string}|undefined;
        if(node!=='source'&&!r)throw new LedgerError(409,'upstream_receipt_missing:'+node);
        if(r){
          const value=JSON.parse(r.json);const revisionId=revisions.get(value.revisionId);
          if(!revisionId)throw new LedgerError(409,'upstream_receipt_missing:'+node);
          l.db.prepare('INSERT INTO run_stage_receipts VALUES (?,?,?,?)').run(nextId,node,revisionId,canonicalJSON({...value,revisionId,inheritedFromRun:runId}));
        }
        stageEvent(nextId,projectId,node,'done','沿用上游产物，来源 '+runId);
      }
    }
    configureNextNode(nextId,projectId,input.node);
    const nextParams=l.requireRun(nextId,projectId).input.parameters;
    stageEvent(nextId,projectId,input.node,'queued','正在启动：等待执行器会话就绪');
    if(input.node==='source')void launchSource(nextId,projectId,dataPath('uploads/'+nextId),nextParams).catch(()=>{});
    else {
      const directory=materializeInputs(nextId,projectId);
      void startWebRun({wfRunId:nextId,target:{projectId,envRef:params.envRef},materialsDir:directory,
        limit:params.limit,params:nextParams,generationMode:'skill',runtime:plannerOf(nextId,projectId),resumeStage:input.node})
        .catch(error=>{stageEvent(nextId,projectId,input.node,'failed',String(error));l.db.prepare("UPDATE wf_runs SET status='failed' WHERE id=?").run(nextId);});
    }
    return created;
  }catch(error){l.db.prepare("UPDATE wf_runs SET status='failed' WHERE id=?").run(nextId);throw error;}
}
