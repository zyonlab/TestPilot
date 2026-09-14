/* Separate product reports/baselines from Agent evaluation. Prototype state only. */
function foldSurfaceNotes(root){
  for(const n of [...root.querySelectorAll('.note')]){
    if(n.closest('details')||n.querySelector('button,input,select,a')||n.textContent.length<70)continue;
    const details=el('details','inline-help');details.append(el('summary',null,'说明'));n.replaceWith(details);details.append(n);
  }
  return root;
}
function compactSectionPage(title,description,key,sections){
  const page=el('div','page-pad surface-page'),grid=el('div','withnav'),nav=el('nav','subnav');nav.setAttribute('aria-label',title+'子导航');
  const active=sections.find(s=>s.id===S[key])||sections[0];S[key]=active.id;let group;
  for(const sec of sections){if(sec.group&&sec.group!==group){group=sec.group;nav.append(el('div','grp',group));}const b=button(sec.label,()=>{S[key]=sec.id;render();},'');b.setAttribute('aria-current',String(sec.id===active.id));nav.append(b);}
  const body=el('main','surface-content'),head=el('div','surface-heading');head.append(el('h2',null,active.label));
  if(description||active.why)head.append(button('页面说明',()=>sheet(title+' · '+active.label,p=>p.append(el('p',null,active.why||description))),'surface-help'));
  body.append(head,foldSurfaceNotes(active.build()));grid.append(nav,body);page.append(grid);return page;
}
function isBaselineView(value=S.hi){return ['base','base-current','base-history'].includes(value);}
function baselineReviewState(){R.baselineProjects ||= new Map();if(!R.baselineProjects.has(R.project))R.baselineProjects.set(R.project,{visual:null,perf:null,history:[]});return R.baselineProjects.get(R.project);}
function baselineDecision(kind,decision){
  if(R.project!=='selftest'||!['visual','perf'].includes(kind)||!['accepted','kept'].includes(decision))return false;
  const state=baselineReviewState();if(state[kind])return false;
  const record={id:'baseline-review-'+(state.history.length+1),kind,decision,at:new Date().toISOString(),sourceRun:RUNS[0].id,simulation:true};
  state[kind]=record;state.history.push(record);render();toast(decision==='accepted'?'已模拟更新基线':'已模拟保留原基线');return true;
}
function baselineComparison(kind){
  const body=el('div');if(kind==='visual'){
    const shots=el('div','shots');for(const title of ['原基线','本次','差异 8.5%']){const shot=el('div','shot'+(title.includes('差异')?' diff':''));shot.append(el('div','cap',title),el('div','baseline-image-missing','图像未嵌入'));shots.append(shot);}body.append(shots);
  }else body.append(table(['指标','原基线','本次','变化'],Object.keys(PERF.metrics).map(k=>[k.replace('Ms',''),PERF.baseline[k]+' ms',PERF.metrics[k]+' ms',Math.round((PERF.metrics[k]-PERF.baseline[k])/PERF.baseline[k]*100)+'%'])));
  return body;
}
function baselineCard(kind,actions=false){
  const card=el('article','box baseline-card');card.dataset.baseline=kind;card.append(titleRow(kind==='visual'?'视觉基线':'性能基线','Send 0.01 ETH → on-chain tx'),baselineComparison(kind));
  if(actions)card.append(row(button('模拟批准并更新',()=>baselineDecision(kind,'accepted'),'send'),button('保留原基线',()=>baselineDecision(kind,'kept'),'hint')));
  return card;
}
function renderPendingBaselines(){
  const box=el('div'),state=baselineReviewState(),pending=['visual','perf'].filter(k=>!state[k]);box.append(row(pill(pending.length+' 项待审批','judge'),pill('归档样例 · 操作仅本会话')));
  pending.forEach(k=>box.append(baselineCard(k,true)));if(!pending.length)box.append(empty('没有待审批项','可在当前基线和审批记录中查看。'));return box;
}
function renderCurrentBaselines(){
  const box=el('div'),state=baselineReviewState();box.append(table(['基线','当前参照','来源','查看'],['visual','perf'].map(k=>[k==='visual'?'视觉':'性能',state[k]?.decision==='accepted'?'本次模拟接受的版本':'归档原参照',state[k]?.decision==='accepted'?state[k].sourceRun:'版本与时间未记录',button('查看 '+(k==='visual'?'视觉':'性能'),()=>sheet('当前'+(k==='visual'?'视觉基线':'性能基线'),b=>{
    if(k==='visual')b.append(note('归档未嵌入图像。'),pill(state[k]?.decision==='accepted'?'本会话模拟更新':'归档原参照'));
    else b.append(table(['指标','当前基线'],Object.entries(state[k]?.decision==='accepted'?PERF.metrics:PERF.baseline).map(([name,value])=>[name.replace('Ms',''),value+' ms'])));
  }))])));return box;
}
function renderBaselineHistory(){
  const box=el('div'),records=baselineReviewState().history;
  if(!records.length)return empty('没有本会话审批记录','历史审批记录未嵌入。');
  box.append(table(['时间','基线','决定','来源运行'],records.map(r=>[new Date(r.at).toLocaleTimeString(),r.kind==='visual'?'视觉':'性能',r.decision==='accepted'?'模拟更新':'保留原基线',r.sourceRun])));return box;
}
function renderReportSurface(){
  if(['workflow','workflow-detail'].includes(S.hi))return renderWorkflowRecords();
  if(isBaselineView())return compactSectionPage('基线','查看差异、确认视觉与性能参照；审批不改变测试执行结果。','hi',[
    {id:'base',label:'待审批',build:renderPendingBaselines},{id:'base-current',label:'当前基线',build:renderCurrentBaselines},{id:'base-history',label:'审批记录',build:renderBaselineHistory},
  ]);
  return compactSectionPage('运行报告','查看被测产品的执行结果、套件批次与趋势。','hi',[
    {id:'runs',label:'执行记录',build:()=>{const b=sectRuns();b.prepend(row(pill('归档样例'),pill(RUNS.length+' 次执行')));return b;}},
    {id:'batch',label:'套件批次',build:sectBatch},{id:'trend',label:'趋势',build:sectTrend},
  ]);
}
function renderStoryMaterials(){
  const b=el('div','story-materials'),model=projectProductModel(),toolbar=el('div','material-actions'),run=workflowRecords().find(r=>r.id===(R.benchRunId||R.runId));
  toolbar.append(pill(model.stories.length+' 个故事'),pill(productWorkspace().merged?'融合文档 v'+model.revision:'规格重建参考'),button('查看产品文档',()=>openProductBundle(model,{reference:!productWorkspace().merged})),button('融合审阅',openProductMerge),button('选择运行记录',openBenchRunPicker));b.append(toolbar);
  if(run)b.append(disclosure('运行物料 · '+run.id,renderRunMaterials()));
  b.append(table(['模块','故事','用例'],model.stories.map(story=>[moduleFor(story.id)?.name||story.primaryModuleId,button(story.id+' '+story.title,()=>navigateStory(story.id)),storyCases(story.id).length])));return b;
}
const EVALUATION_SUMMARIES = [
  {id:'N-16',capability:'领域规则',change:'领域参考：关闭 → 开启',metric:'数量探针通过',baseline:'3 / 3',candidate:'3 / 3',sample:'每臂 3 次',status:'未显示提升',source:'../v3/evidence/n-16/README.md',detail:'健康实现误报为 0；小样本没有显示领域参考提升。不能把多个 case probe 命中计为多个独立缺陷。'},
  {id:'N-22',capability:'运行记忆',change:'记忆：关闭 → 开启',metric:'计划有效',baseline:'2 / 3',candidate:'3 / 3',sample:'每臂 3 次',status:'分类问题未解决',source:'../v3/evidence/n-22/README.md',detail:'有效计划的 selector 可用；缺证分类两臂均错误。这是离线 DOM selector 检查，不是 Midscene 视觉效果验证。'},
  {id:'N-21',capability:'受控进化',change:'基准策略 → 候选策略',metric:'计划有效',baseline:'0 / 3',candidate:'0 / 3',sample:'每臂 3 次',status:'候选被拒绝',source:'../v3/evidence/n-21/README.md',detail:'六个计划全部无效，不能把 0 对 0 解释为等效。旧评分分类已审计，原始记录保留；未产生真实人工晋升。'},
];
function openEvaluationGuide(){
  sheet('评测与自进化',b=>{
    b.append(flow([['1 · Gold 基准',()=>{R.evalView='gold';goTo('ev');}],['2 · PenguinHarness 实验',openPenguinHandoff],['3 · 记分板',()=>{R.evalView='current';goTo('ev');}]]));
    b.append(table(['位置','用途','用户操作'],[
      ['Gold','确定“什么算正确、应该覆盖什么”','人工标注 → 复核 → 分开发 / 留出 → 冻结版本'],
      ['PenguinHarness','改进 Agent 的候选策略','查看差异 → 对照运行 → 留出与宿主回归 → 人工晋升 / 回滚'],
      ['记分板','查看评测结果与版本依据','选能力 → 看可比版本 → 追踪失败和成本 → 打开实验'],
      ['产品基线','被测产品的视觉 / 性能参照','审阅截图与性能变化，确认是否更新'],
    ]),el('p','records-note','冻结的 Gold 用于评测；领域知识用于帮助生成，二者分别管理。优化器不能读取留出答案或自行修改评分标准。'));
    b.append(link('详细使用与接手说明','../v3/17-报告基线与评测职责.md'));
  });
}
function openPenguinHandoff(){
  sheet('PenguinHarness · 自进化实验',b=>{
    b.append(row(pill('配套评估界面'),pill('原型未连接服务')),
      table(['管理内容','当前实现'],[
        ['候选与对照','由 TestPilot Evaluation 扩展组织实验，外部工具评分'],
        ['当前可改策略','memory：scoped / off；通用 Skill 自动改写尚未接入'],
        ['发布','留出验证、跨宿主回归和人工审核后晋升；支持回滚'],
        ['TestPilot 回读','记分板读取证据摘要；新 run 冻结激活策略版本'],
      ]),row(link('扩展接入指南','../../extensions/penguin-evaluation/README.md'),button('查看评测流程',openEvaluationGuide)),
      disclosure('接入配置',el('p',null,'正式 UI 使用服务返回的 TP_PENGUIN_EVALUATION_URL；默认配套端口 7365。此扩展不是 Penguin 原生自动接受优化器。'),el('p',null,'原型不启动服务、不提交实验；完整流程在真实扩展中执行。')));
  });
}
function openEvaluationRecord(record){
  sheet(record.id+' · '+record.capability,b=>b.append(row(pill('归档实验摘要'),pill(record.status)),table(['配置','指标','结果'],[['基准',record.metric,record.baseline],['候选',record.metric,record.candidate]]),el('p',null,record.detail),table(['评测绑定','状态'],[['模型 / Gold / 输入指纹','完整绑定未嵌入；以原始证据为准'],['跨实验比较','指标与任务不同，不合并排名']]),link('查看原始证据',record.source)));
}
function renderScoreboardSurface(){
  const page=el('div','page-pad evaluation-page'),head=el('div','surface-heading');head.append(el('h2',null,'记分板'),row(button('如何使用',openEvaluationGuide),button('PenguinHarness',openPenguinHandoff,'')));page.append(head);
  const filters=el('div','evaluation-toolbar'),cap=el('select');cap.setAttribute('aria-label','评测能力');cap.append(new Option('全部能力','all'));[...new Set(EVALUATION_SUMMARIES.map(r=>r.capability))].forEach(c=>cap.append(new Option(c,c)));cap.value=R.scoreCapability||'all';filters.append(cap,pill('归档摘要 · 未连接服务'),pill('未证明质量提升','judge'));page.append(filters);
  const results=el('div','evaluation-results');const draw=()=>{results.replaceChildren();const rows=EVALUATION_SUMMARIES.filter(r=>cap.value==='all'||r.capability===cap.value);results.append(table(['实验','配置变化','指标','基准','候选','样本','结论'],rows.map(r=>[button(r.id+' · '+r.capability,()=>openEvaluationRecord(r)),r.change,r.metric,r.baseline,r.candidate,r.sample,r.status])));};cap.onchange=()=>{R.scoreCapability=cap.value;draw();localizeUI(results);};draw();page.append(results);
  const comparison=button('正式版本比较',()=>{},'');comparison.disabled=true;comparison.title='归档摘要没有完整模型、Gold 与输入绑定，不能进行正式版本比较';page.append(row(comparison,el('span','records-note','正式比较需完整评测绑定')));
  page.append(disclosure('研究与历史材料',row(button('研究方案',()=>sheet('研究方案',b=>b.append(renderResearchDetail()))),button('查看原有评测样例',()=>{R.evalView='historical';render();})),link('论文设计与任务','testpilot-ui-research-review-2026-09-09.html#research')));return page;
}
function renderGoldSurface(){
  const page=el('div','page-pad evaluation-page'),head=el('div','surface-heading');head.append(el('h2',null,'Gold 基准'),button('如何使用',openEvaluationGuide));page.append(head);
  const all=[...GOLD.hits.map(id=>({id,title:'归档未嵌入条目正文',matched:true,held:GOLD.held.hits.includes(id)})),...GOLD.misses.map(m=>({id:m.id,title:m.t,matched:false,held:!!m.held}))].sort((a,b)=>a.id.localeCompare(b.id));
  const toolbar=el('div','evaluation-toolbar');toolbar.append(pill('selftest · 归档只读'),pill('冻结指纹未嵌入'),pill(all.length+' 条 · '+all.filter(x=>x.held).length+' 条留出'));page.append(toolbar);
  const filters=el('div','evaluation-toolbar'),search=el('input'),split=el('select');search.type='search';search.placeholder='搜索条目';search.setAttribute('aria-label','搜索 Gold 条目');split.setAttribute('aria-label','Gold 数据划分');[['all','全部条目'],['development','开发条目'],['heldout','留出条目']].forEach(([v,l])=>split.append(new Option(l,v)));filters.append(search,split);page.append(filters);
  const content=el('div');const draw=()=>{const items=all.filter(r=>(!search.value||(r.id+' '+r.title).toLowerCase().includes(search.value.toLowerCase()))&&(split.value==='all'||(split.value==='heldout')===r.held));content.replaceChildren(table(['条目','内容','划分','历史匹配'],items.map(r=>[r.id,r.title,r.held?'留出':'开发',r.matched?'已匹配':'未匹配'])));};search.oninput=()=>{draw();localizeUI(content);};split.onchange=()=>{draw();localizeUI(content);};draw();page.append(content);
  page.append(disclosure('版本与维护',el('p',null,'正式 Gold：上传 / 编写 → 人工逐条复核 → 冻结。冻结后修改需要新谱系，不能覆盖原评分依据。'),el('p',null,'此处为归档查看，不写研究标签。正式 Gold 页面已有维护与冻结能力，需人工审核身份。'),link('Gold 使用说明','../v3/17-报告基线与评测职责.md')));return page;
}
function renderEvaluationSurface(){
  if(R.project!=='selftest')return empty('当前项目未嵌入评测数据','配置评测能力后查看 Gold 与记分板。');
  if(R.evalView==='gold')return renderGoldSurface();
  if(R.evalView==='historical')return renderResearchDetail();
  return renderScoreboardSurface();
}
