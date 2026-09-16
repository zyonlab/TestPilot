import { randomUUID } from 'node:crypto';
import {materialSections, frozenModules } from './moduleStage.js';
import {caseStructureContract} from './workUnits.js';
import { z } from 'zod';
import { runLedger } from './runService.js';
import { LedgerError } from './runLedger.js';
import type { RunEvent } from '@testpilot/harness-core/run-contracts';
// modules 排在 stories 之前：planUnits 按根模块子树切单元，没有树就切不出单元。
const nodes=['source','modules','instructions','stories','cases','gate','finalize','g2','execution'] as const;
function table(){const l=runLedger();l.db.exec('CREATE TABLE IF NOT EXISTS workflow_controls (runId TEXT PRIMARY KEY, json TEXT NOT NULL)');return l;}
export function controls(runId:string,projectId:string):{breakpoints:string[];pausedAt?:string}{const l=table();l.requireRun(runId,projectId);const row=l.db.prepare('SELECT json FROM workflow_controls WHERE runId=?').get(runId) as {json:string}|undefined;return row?JSON.parse(row.json):{breakpoints:[]};}
function save(runId:string,value:ReturnType<typeof controls>){table().db.prepare('INSERT INTO workflow_controls VALUES (?,?) ON CONFLICT(runId) DO UPDATE SET json=excluded.json').run(runId,JSON.stringify(value));}
export function setControls(runId:string,projectId:string,raw:unknown){const input=z.object({breakpoints:z.array(z.enum(nodes)).max(nodes.length)}).parse(raw);return table().db.transaction(()=>{const old=controls(runId,projectId),states=table().nodeStates(runId);for(const n of input.breakpoints){if(!old.breakpoints.includes(n)&&states.some(s=>s.node===n))throw new LedgerError(409,'breakpoint_requires_untouched_node');}const next={...old,breakpoints:[...new Set(input.breakpoints)]};save(runId,next);return next;})();}
/**
 * 故事节点的契约。
 *
 * 每一条都来自 2026-09-12 的两臂实测（docs/v3/24 §10.4）：左边是机器臂交出来的，
 * 右边是参照臂（人写的那一份）同一份材料上的数——差在哪，这里就写什么。
 *
 *   叶子扇出 0.63 vs 2.0（27 个叶子 27 个空着）· 带出处的验收 0 vs 68/68
 *   冲突类待确认 0 vs 6 · 清单式验收 65% vs 13%
 *
 * 写法上只给**要什么**，不给**不许什么**：同一个模型已经两次证明，禁令它照做、意图它绕开
 * （「别把层级写进名字」→ 它不做层级；「别用 file.md#N」→ 它用 file.md）。
 */
const STORY_CONTRACT=[
  'Return modules alongside stories: stable id/name, optional parentId and kind=module|submodule|function.',
  'When a module tree is frozen for this run, return THAT tree unchanged — the stories node may not replace it. When this response carries moduleIds, that array IS the set of allowed values: the moduleIds of every story must be a subset of it, copied verbatim, and the modules you return must be exactly those ids. Material citations (file.md#N) belong in the story source or in the acceptance text.',
  'Every story has moduleIds referencing these modules; cross-module stories have multiple moduleIds and one stable story id.',
  'FILL EVERY LEAF: write at least two stories for each leaf module (a leaf is a module no other module has as parent). The server reports every leaf without a story back to you; a leaf you cannot fill means the tree is finer than the product, and that is worth saying out loud rather than leaving the leaf empty.',
  'CITE PER CRITERION: each acceptance criterion states precondition, trigger and business result, and ends with the material section it follows from, written inline as (依据 <file>.md#N). A criterion whose source cannot be named is a guess.',
  'JUDGE, DO NOT INVENTORY: an acceptance criterion says what must be TRUE about the product, not what the screen lists. If a criterion only asserts that a field is displayed, say instead what would be wrong if that field were absent, stale, or contradicted another field on the same screen.',
  'TWO KINDS OF UNKNOWN, LABELLED DIFFERENTLY: 【待确认：界面观察不到】 is a coverage gap — the domain knowledge raises a question this observation cannot answer. 【待确认：与领域知识冲突】 is a product defect lead — two materials, or a material and the screen, say different things; name both sections. Volatile readings (live counters, prices, countdowns, running totals, and whatever the rule pack lists under volatileReadings) may only be asserted as existing or as a relation between two readings.',
  'ONE CRITERION PER INDEPENDENTLY CHECKABLE RESULT — the count comes from the story, not from a quota. A set of stories whose acceptance counts are all identical was filled to a number rather than derived; some stories carry one criterion and some carry five.',
  'A CONTRADICTION MUST SURVIVE RE-READING BOTH SECTIONS: before labelling one, quote what each section actually says. If the observation does contain what you were about to call missing, it is not a contradiction — drop it. A wrong contradiction costs more than a missing one, because someone will go check it.',
  'SWEEP THE DOMAIN MATERIAL BEFORE YOU FINISH: walk the domain document section by section and ask of each one — does the observed UI contradict it, or leave a question it raises unanswerable? Each contradiction becomes a 【待确认：与领域知识冲突】 criterion naming both sections. Reporting zero contradictions across an entire domain document claims the product is perfectly consistent with it; claim that only if you actually walked every section.',
  /**
   * 角色和优先级此前根本不在契约里，于是：26 条故事的 role 全是同一个词（模型现编的），
   * 优先级字段压根不存在。两样都不该靠模型发挥——包里已经把角色和主链写成事实了。
   */
  'CLAIM A DECLARED ROLE: when the unit materials carry roles, every story names one of THEM verbatim (id or name) and its benefit is that role\'s goal in this context. Two roles reading the same screen do not want the same thing; a batch where every story carries the same role has not asked who is looking.',
  'PRIORITY IS READ OFF THE LIFECYCLE, NOT OFF IMPORTANCE: when the unit materials carry lifecycle stages, every story sets priority and, if it sits on the main chain, lifecycleId naming that stage. P0 = the chain breaks without it (the user cannot finish one full pass of the product). P1 = the chain still runs but the result can be wrong or unrecoverable. P2 = everything else. A rule with riskFloor P0 forces P0 regardless. Every stage needs at least one P0 story; a stage with none is reported back to you.',
  'Ground hierarchy in observed materials; do not invent unobserved functionality. For Explore set derivedFrom=exploration.',
].join(' ');
/**
 * **模块这一步此前什么契约都没发。**
 *
 * 2026-09-16 实测（Hyperliquid，Claude Code 规划）：48 轮里有 43 次 Bash、25 次 Read，
 * 其中 15 次在读这个仓库的服务端源码——`moduleStage.ts`、`modulePlan.ts`、`workflowControls.ts`——
 * 为的是搞清「模块树要交什么字段」和「机检会用什么规则拒我」。一跑 $6.39，而同一天
 * 没有模块节点的 Vikunja 那跑是 $3.14。**它不是在乱翻，是在补一份没人给它的契约。**
 *
 * `stories` 与 `cases` 早就有 `structureContract`，`modules` 偏偏没有；`begin_stage` 只给它
 * `sections`。所以这里补三样，都按本仓库反复验证过的那条规矩——**是事实就当数据交出去，
 * 别写在散文里让它猜**（冻结的树、可引段号已经这么做了）。
 */
const MODULE_CONTRACT=[
  'Return {modules:[...], outOfScope:[...]}. Each module: id (stable, dot-free unless you also set parentId), name, parentId (null for a root), purpose (one sentence: what a user does here), evidence (section ids), featureIds (the features this module covers).',
  'THE TREE MUST BE AT LEAST TWO LEVELS: 3–7 roots, and every root has children. A flat list of modules is rejected as `module_tree_is_a_list` — the tree exists to be COARSER than the stories; if it is 1:1 with them it provides no structure.',
  'HIERARCHY LIVES IN parentId, NOT IN THE NAME: an id like `market.book` with no parentId is rejected as `module_fake_hierarchy`. If the id carries a dot prefix, parentId must be exactly that prefix.',
  'EVIDENCE IS COPIED, NOT WRITTEN: every evidence entry must be one of the ids in the `sections` array of this response, verbatim. Anything else is rejected as `module_evidence_unknown`. A module with no evidence cannot say which material it was read from.',
  'EVERY FEATURE MUST BE CLAIMED BY A LEAF: this response carries `features` — the product model this run already has. Put each feature id into the featureIds of the leaf that covers it. Features nobody claims never reach any downstream unit: their domain rules silently stop flowing, and the stories still look written. Dropping all of them is an error, not a warning.',
  'EVERY SECTION NEEDS A HOME: each id in `sections` is either cited by some module or declared in outOfScope with a reason. Unclaimed sections are reported back as `material_section_unclaimed`.',
  'OUT OF SCOPE MEANS THE SECTION DOES NOT DESCRIBE THIS PRODUCT\'S BEHAVIOUR (a definition, a rule about how to write tests, the exploration\'s own receipt). It does NOT mean "I could not see it on screen" — that is a coverage gap and belongs in a story\'s 【待确认】, not here.',
  'The `checks` array in this response is the full list of rules the server will judge your proposal by, with severity. Read it before you write: an error rejects the whole proposal, and the response names which rule and which module.',
].join(' ');
/**
 * 机检规则当数据交出去：模型不必去读 `modulePlan.ts` 才知道会被怎么拒。
 * 和 `checkModulePlan` / `droppedFeatures` 里的码一一对应——改那边记得改这里。
 */
const MODULE_CHECKS=[
  {code:'module_parent_unknown',severity:'error',means:'parentId 指向一个不存在的模块'},
  {code:'module_parent_self',severity:'error',means:'模块的 parentId 指向自己'},
  {code:'module_cycle',severity:'error',means:'顺着 parentId 往上走会走回自己'},
  {code:'module_fake_hierarchy',severity:'error',means:'id 带点号却没有 parentId：层级写在了名字里而不是 parentId 里'},
  {code:'module_claims_unknown_feature',severity:'error',means:'认领了产品模型里没有的功能 id'},
  {code:'module_tree_drops_all_features',severity:'error',means:'一个功能都没被认领：这不是重新切树，是断了线'},
  {code:'module_tree_drops_features',severity:'warn',means:'部分功能没有任何模块认领，它们不会进入任何下游单元'},
  {code:'module_id_parent_mismatch',severity:'warn',means:'id 的点号前缀与 parentId 说的不是同一个父模块'},
  {code:'module_without_evidence',severity:'warn',means:'模块没引用任何材料段：说不出它是从哪一段看出来的'},
  {code:'module_evidence_unknown',severity:'warn',means:'引用了 sections 里不存在的段'},
  {code:'module_tree_is_a_list',severity:'warn',means:'没有任何父子关系：这是一张清单，不是一棵树'},
  {code:'material_section_unclaimed',severity:'warn',means:'材料的某一段既没被引用也没声明不在范围内'},
  {code:'out_of_scope_without_reason',severity:'warn',means:'声明不在范围内却没说为什么：那和漏掉一样'},
  {code:'out_of_scope_unknown_section',severity:'warn',means:'声明不在范围内的段在材料里不存在'},
  {code:'module_tree_too_narrow',severity:'info',means:'一层模块太少，下游按根模块拆单元时会失衡'},
  {code:'out_of_scope_is_actually_a_gap',severity:'info',means:'理由的形状像「我没看到」，那是覆盖缺口，不是范围外'},
] as const;
/** 这次运行已有的产品模型功能。模块要给每个功能找归属，那份清单是账本上的事实，不该让它自己从材料里拼。 */
function modelFeatures(runId:string,projectId:string):Array<{id:string;name?:string;moduleId?:string}>{
  const l=table();
  const found=l.listRevisions(projectId,runId).filter(r=>r.name==='product/model-candidate').sort((a,b)=>a.revision-b.revision).at(-1);
  if(!found)return [];
  const model=l.readRevision(found.id,projectId).content as {features?:Array<{id:string;name?:string;moduleId?:string}>};
  return (model.features??[]).map(f=>({id:f.id,...(f.name?{name:f.name}:{}),...(f.moduleId?{moduleId:f.moduleId}:{})}));
}
export function stageEvent(runId:string,projectId:string,node:string,phase:RunEvent['phase'],message?:string,revisionId?:string){const l=table();const last=l.nodeStates(runId).find(n=>n.node===node);const attempt=last?.attempt??0;const sequence=(l.db.prepare('SELECT COALESCE(MAX(sequence),-1)+1 AS n FROM workflow_events WHERE runId=? AND node=? AND attempt=?').get(runId,node,attempt) as {n:number}).n;l.appendEvent({id:`stage-${randomUUID()}`,runId,node,attempt,sequence,phase,at:new Date().toISOString(),...(message?{message}:{}),...(revisionId?{revisionId}:{})},projectId);}
export function beginStage(runId:string,projectId:string,raw:unknown){const {node}=z.object({node:z.enum(nodes)}).parse(raw);return table().db.transaction(()=>{const run=table().getRun(runId,projectId);if(['paused','cancelled','failed','interrupted'].includes(run.status))return {status:run.status,instruction:'Stop this turn. The user must explicitly resume this run.'};const control=controls(runId,projectId);const prior=table().nodeStates(runId).find(s=>s.node===node);if(prior?.phase==='done')return {status:'done',node};if(control.breakpoints.includes(node)&&!prior){save(runId,{...control,pausedAt:node});stageEvent(runId,projectId,node,'blocked','Breakpoint: paused before execution');table().db.prepare("UPDATE wf_runs SET status='paused' WHERE id=?").run(runId);return {status:'paused',node,instruction:'Stop this turn without planning or writing this stage. The user will resume this same run.'};}stageEvent(runId,projectId,node,'running');
if(['source','instructions','stories','cases','gate','finalize'].includes(node))table().db.prepare("UPDATE wf_runs SET status='running' WHERE id=?").run(runId);
const knowledge=table().listRevisions(projectId,runId).filter(r=>r.name.startsWith('knowledge/')).map(r=>({revision:r.id,...table().readRevision(r.id,projectId).content as {roles?:string[]}})).filter(k=>k.roles?.includes(node));
/**
 * 故事节点开工时，**把冻结的模块树当数据交出去**，不是只在话术里说。
 *
 * 2026-09-12 实测：话术里逐行列出那棵树、写明「只能取下面这些 id」，模型还是拿材料段 id
 * 当 moduleIds；把「不许出现 file.md#N」写进契约之后，它把 `#N` 去掉、改用 `file.md` ——
 * **禁令它照做，意图它绕开**。两次都是同一个形状。所以这里不再加禁令：允许的取值就是这一串，
 * 服务端直接给，规划器照抄即可；写别的会被 stories 节点整份拒收。
 */
const allowedModuleIds=node==='stories'?(frozenModules(runId,projectId)??[]).map(m=>m.id):[];
/**
 * 模块节点开工时**把可引用的段号当数据交出去**——和上面那棵冻结的树同一个道理。
 *
 * 2026-09-12 实测：契约要求每个模块引用材料的段（`file.md#N`），而探索材料一个
 * `##` 都没有，段号集合是空的；模型只能编，编出来的 80 条引用 80 条机检不通过。
 * 「自己去数材料里有哪些段」不是模型该做的事，那是账本上的事实。
 */
const citableSections=node==='modules'?materialSections(runId,projectId):[];
return {status:'running',node,knowledge,outputLanguage:table().requireRun(runId,projectId).input.parameters.outputLanguage??'source',...(allowedModuleIds.length?{moduleIds:allowedModuleIds}:{}),...(citableSections.length?{sections:citableSections}:{}),...(node==='stories'?{structureContract:STORY_CONTRACT}:{}),...(node==='cases'?{structureContract:caseStructureContract()}:{}),...(node==='modules'?{structureContract:MODULE_CONTRACT,checks:MODULE_CHECKS,features:modelFeatures(runId,projectId)}:{})};})();}
export function resumeControls(runId:string,projectId:string){const c=controls(runId,projectId);save(runId,{breakpoints:c.breakpoints.filter(n=>n!==c.pausedAt)});return c.pausedAt;}
export function requireStageStarted(runId:string,projectId:string,node:string){const l=table(),run=l.requireRun(runId,projectId);if(['paused','cancelled','interrupted'].includes(l.getRun(runId,projectId).status))throw new LedgerError(409,'run_requires_explicit_resume');if(run.input.parameters?.stageControlVersion===1&&!l.nodeStates(runId).some(n=>n.node===node&&['running','done','waiting_review'].includes(n.phase)))throw new LedgerError(409,'begin_stage_required');}
