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
    stable: "你是一名资深测试分析师。你要做的是**判断**，不是编造事实：只能引用给你的编号。",
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
