import { nativeHostChat } from "./plannerHost.js";
import { runLedger } from "./runService.js";
import { projectPlannerModel } from "./modelProfiles.js";
export async function askExplorationPlanner(input:unknown) {
  const req = (input ?? {}) as { prompt?: string; imageDataUrl?: string; schema?: unknown; maxTokens?: number; projectId?: string; runId?: string };
  if(req.runId && !req.projectId)throw new Error('explore_planner_project_required');
  const run = req.runId && req.projectId ? runLedger().requireRun(req.runId, req.projectId) : undefined;
  const runtime = run?.input.parameters?.plannerRuntime;
  const knowledge = run && req.projectId ? runLedger().listRevisions(req.projectId, req.runId!).filter(r=>r.name.startsWith('knowledge/')).map(r=>({revision:r.id,content:runLedger().readRevision(r.id,req.projectId!).content})) : [];
  const request = {
    stable: "你是一名资深测试分析师。你要做的是**判断**，不是编造事实：只能引用给你的编号。结合领域业务转换的前置条件、动作和结果判断可交互组件可能承担的功能。区分当前空状态与其他状态下的能力；未成交资源不等于已建立资源。优先检查相关弹窗、下拉和标签页；缺少状态时说明准备条件，不能宣称功能不存在。业务状态转换是规划上下文，不是页面事实或执行授权，不得为补齐覆盖自动实施有副作用的操作。",
    variable: `领域资料（业务假设不是页面事实）：${JSON.stringify(knowledge)}\n\n${String(req.prompt ?? "")}`,
    ...(req.imageDataUrl ? { images: [req.imageDataUrl] } : {}),
    ...(req.schema ? { schema: req.schema as Record<string, unknown> } : {}),
    maxTokens: req.maxTokens ?? 2400,
    label: "explore.scenario",
  };
  if (run && runtime !== 'codex' && runtime !== 'claude-code') throw new Error('explore_native_planner_unsupported');
  const record = (content:Record<string,unknown>) => {
    if(!run || !req.projectId)return;
    const ledger=runLedger();
    const prior=ledger.listRevisions(req.projectId,req.runId!).filter(r=>r.name==='exploration/planner-call').sort((a,b)=>b.revision-a.revision)[0];
    ledger.putRevision({runId:req.runId!,projectId:req.projectId,name:'exploration/planner-call',kind:'report',parentRevision:prior?.id,
      content:{runtime,knowledgeRefs:knowledge.map(k=>k.revision),...content},sourceRefs:knowledge.map(k=>k.revision)}, {kind:'system',id:'explorer-planner'});
  };
  record({status:'running',startedAt:new Date().toISOString()});
  try {
    const r = run ? await nativeHostChat(runtime as 'codex'|'claude-code',request,{timeoutMs:300000}) : await projectPlannerModel(req.projectId, "explore.scenario").chat(request);
    record({status:'done',response:r.text,tokens:r.tokens,ms:r.ms});
    return r.text;
  } catch(error) {
    record({status:'failed',error:error instanceof Error?error.message:'planner_failed'});
    throw error;
  }
}
