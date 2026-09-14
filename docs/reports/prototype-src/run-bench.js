/* Run-scoped workflow review and deterministic, local-only breakpoint simulation. */
function benchRun(){return R.benchRunId?workflowRecords().find(r=>r.id===R.benchRunId):null;}
function benchNodeState(run,id){return run?.nodeStates?.[id]||{status:run?'skipped':'pending',attempted:false};}
function benchStateLabel(status){return ({pending:'未执行',running:'执行中',done:'已完成',paused:'已暂停',failed:'失败',skipped:'不在本次范围'})[status]||'未记录';}
function benchRunLabel(run){return run.kind==='archive'?'归档完成':({ready:'待启动',running:'模拟执行中',paused:'模拟已暂停',failed:'模拟失败',completed:'模拟完成'})[run.status]||'仅模拟范围';}
function canSetBenchBreakpoint(run,id){
  const graph=run?.graph||graphSnapshot(),state=benchNodeState(run,id);
  return graph.nodes.some(n=>n.id===id)&&(!run||run.kind==='simulation'&&run.status!=='completed'&&run.nodes.includes(id))&&!state.attempted&&['pending','paused'].includes(state.status);
}
function toggleBenchBreakpoint(id){
  const run=benchRun();if(R.benchRunId&&!run)return false;
  if(!canSetBenchBreakpoint(run,id)){toast('只能在本次 run 尚未执行的节点设置断点');return false;}
  if(run){const points=new Set(run.breakpoints);points.has(id)?points.delete(id):points.add(id);run.breakpoints=[...points];run.events.push({type:'breakpoint.changed',node:id,enabled:points.has(id),at:new Date().toISOString()});}
  else S.bp.has(id)?S.bp.delete(id):S.bp.add(id);
  render();return true;
}
function selectBenchRun(id){
  if(id&&!workflowRecords().some(r=>r.id===id)){toast('这条运行记录不属于当前项目或已不可用');return;}
  if(id){const selected=workflowRecords().find(r=>r.id===id);R.module=selected.scope?.module||null;R.story=selected.scope?.story||null;R.productNode=selected.scope?.productNode||null;}
  closeSheet(false);R.benchRunId=id||null;R.runId=id||null;R.runTab='nodes';R.caseId=null;S.ctx=null;S.view='ws';R.workView='workflow';render();
}
function prepareBenchRun(){S.bp.clear();R.productNode=null;selectBenchRun(null);}
function initializeBenchAttempt(attempt){
  attempt.status='ready';attempt.breakpoints=[...S.bp].filter(id=>attempt.nodes.includes(id));
  attempt.nodeStates=Object.fromEntries(attempt.graph.nodes.map(n=>[n.id,{status:attempt.nodes.includes(n.id)?'pending':'skipped',attempted:false}]));
  attempt.artifacts=[];attempt.events=[{type:'run.created',at:attempt.createdAt}];attempt.pauseNode=null;attempt.pauseReason=null;
  return attempt;
}
function benchEvent(run,type,node){run.events.push({type,node,at:new Date().toISOString()});}
function simulateNodeArtifact(run,node){
  const contract=KINDS[node.type]?.out||'node.result',id=run.id+'/'+node.id+'/output';
  if(run.artifacts.some(a=>a.id===id))return;
  run.artifacts.push({id,runId:run.id,nodeId:node.id,version:run.graph.version,kind:'simulation',name:(NODE_NAMES[node.type]||node.id)+' · 模拟物料',count:'1 份占位',
    payload:{simulation:true,runId:run.id,nodeId:node.id,workflowVersion:run.graph.version,outputContract:contract,scope:copy(run.scope),params:copy(node.params||{}),note:'仅用于演示产物关联与暂停续跑，未生成真实故事、用例、代码或执行证据。'}});enrichSimulatedArtifact(run,node,run.artifacts.at(-1));
}
function executeBenchRun(id){
  const run=workflowRecords().find(r=>r.id===id);if(!run||run.kind!=='simulation'||!['ready','paused','failed'].includes(run.status))return false;
  const resuming=run.status==='paused'||run.status==='failed',resumeNode=resuming?run.pauseNode:null;
  run.status='running';benchEvent(run,resuming?'run.resumed':'run.started',resumeNode);run.pauseNode=null;run.pauseReason=null;
  for(const id of run.nodes){
    const state=run.nodeStates[id],node=run.graph.nodes.find(n=>n.id===id);if(state.status==='done')continue;
    if(run.breakpoints.includes(id)&&id!==resumeNode&&!state.attempted){state.status='paused';run.status='paused';run.pauseNode=id;run.pauseReason='breakpoint';benchEvent(run,'run.paused.before',id);break;}
    state.status='running';state.attempted=true;state.attempts=(state.attempts||0)+1;delete state.error;benchEvent(run,'node.started',id);
    try{simulateNodeArtifact(run,node);state.status='done';state.completedAt=new Date().toISOString();benchEvent(run,'node.completed',id);}
    catch(error){state.status='failed';state.error=String(error.message||error);run.status='failed';run.pauseNode=id;run.pauseReason='error';benchEvent(run,'node.failed',id);run.events.at(-1).error=state.error;break;}
  }
  if(run.status==='running'){run.status='completed';run.completedAt=new Date().toISOString();benchEvent(run,'run.completed');}
  selectBenchRun(run.id);return true;
}
function openBenchRunPicker(){
  if(S.view!=='ws'||R.workView!=='workflow'){S.view='ws';R.workView='workflow';R.caseId=null;render();}
  sheet('选择运行记录',b=>{
    const search=el('input');search.type='search';search.placeholder='搜索运行 ID、节点或入口';search.setAttribute('aria-label','搜索工作流记录');search.value=R.runQuery;
    const kind=el('select');kind.setAttribute('aria-label','工作流记录来源');[['all','全部记录'],['simulation','本次模拟'],['archive','归档样例']].forEach(([v,l])=>kind.append(new Option(l,v)));kind.value=R.runKind;
    const filters=el('div','record-filters'),list=el('div','record-list');filters.append(search,kind);b.append(filters,list);
    const draw=()=>{list.replaceChildren();const records=workflowRecords().filter(r=>(R.runKind==='all'||r.kind===R.runKind)&&(!R.runQuery||(r.id+' '+r.entry+' '+recordNodes(r).map(n=>n.id).join(' ')).toLowerCase().includes(R.runQuery.toLowerCase())));
      if(!records.length){list.append(empty('尚无匹配的运行记录','可调整筛选，或新建 run。'));return;}
      list.append(table(['运行','版本 / 范围','状态','产物'],records.map(r=>[button(r.id,()=>selectBenchRun(r.id)), 'v'+r.graph.version+' · '+runModeLabel(r.mode),benchRunLabel(r),(r.artifacts||[]).length+' 份'+(r.kind==='simulation'?'模拟物料':'归档物料')])));localizeUI(list);};
    search.oninput=()=>{R.runQuery=search.value;draw();};kind.onchange=()=>{R.runKind=kind.value;draw();};draw();
    b.append(el('p','records-note','选择记录后，工作台展示该 run 的节点与物料。模拟 run 仅保留在当前页面会话。'),button('新建 run',prepareBenchRun,''));
  });
}
function benchRunSelector(){
  const select=el('select','bench-run-selector');select.id='bench-run-selector';select.setAttribute('aria-label','当前运行记录');select.append(new Option(tShell('待启动的新 run'),'new'));
  for(const run of workflowRecords())select.append(new Option(run.id+' · '+tShell(benchRunLabel(run))+' · v'+run.graph.version,run.id));
  if(R.benchRunId&&!benchRun()){const missing=new Option(tShell('运行记录不可用'),'missing');select.append(missing);select.value='missing';}else select.value=R.benchRunId||'new';
  select.onchange=()=>select.value==='new'?prepareBenchRun():selectBenchRun(select.value);return select;
}
function openBenchArtifact(run,artifact){if(run.project!==R.project||!run.artifacts.some(a=>a.id===artifact.id))return;sheet(artifact.name+' · '+run.id,b=>b.append(artifactContent(run,artifact)));}
function openBenchNode(run,id){
  const node=run.graph.nodes.find(n=>n.id===id),state=benchNodeState(run,id);if(!node)return;
  sheet((NODE_NAMES[node.type]||id)+' · '+run.id,b=>{
    b.append(row(pill(benchStateLabel(state.status)),pill('执行版本 v'+run.graph.version)),el('p',null,id+' · '+node.type));
    if(run.kind==='archive'){const stats=run.nodes.find(n=>n.id===id);b.append(el('p','records-note',fmtMs(stats.ms)+' · '+stats.calls+' calls · '+stats.tokens+' tokens'));}
    const bp=button(run.breakpoints.includes(id)?'取消断点':'设置断点',()=>{toggleBenchBreakpoint(id);openBenchNode(run,id);},'');bp.disabled=!canSetBenchBreakpoint(run,id);bp.title=bp.disabled?'已执行的节点不能添加断点':'在该节点开始之前暂停';b.append(bp);
    if(state.status==='paused')b.append(note(run.pauseReason==='breakpoint'?'停在此节点之前，节点尚未执行。继续时从此节点开始。':'此节点执行中断，可继续此 run。'));
    if(state.error)b.append(note(state.error));if(node.context)b.append(disclosure('本次 Role / Skill 与知识',renderContextSummary(node.context)));
    const items=run.artifacts.filter(a=>a.nodeId===id);b.append(detailSection('本次节点物料',items.length?row(...items.map(a=>button(a.name,()=>openBenchArtifact(run,a)))):note(run.kind==='archive'?'此归档未嵌入该节点的物料。':'该节点在此 run 中尚无产物。')));
    b.append(disclosure('冻结参数与运行信息',el('pre',null,JSON.stringify(node,null,2)),note(run.kind==='archive'?'未记录的历史参数保持为空。':'此 run 沿用创建时的定义，后续修改工作副本不会改变它。')));
  });
}
function renderBenchCanvas(){
  const run=benchRun();if(R.benchRunId&&!run)return empty('这条工作流记录不可用','可能不属于当前项目，或模拟会话已经清空。',button('选择运行记录',openBenchRunPicker));
  const graph=run?.graph||graphSnapshot(),nodes=graph.nodes,points=run?.breakpoints||[...S.bp];
  const box=el('div','bench-view'),legend=el('div','bench-legend');
  for(const [status,label] of [['done','已完成'],['paused','暂停 / 失败'],['pending','未执行']]){const item=el('span','bench-legend-item');item.append(el('i',status),el('span',null,label));legend.append(item);}
  legend.append(el('span','bench-identity',run?run.id+' · '+(run.sourceKind?.toUpperCase()||'历史入口未记录')+' · v'+graph.version+' · '+benchRunLabel(run):'新 run · 工作副本 v'+graph.version),el('span','bench-bp-note','断点在节点执行前暂停'));
  box.append(legend);
  const scroller=el('div','canvas-wrap bench-canvas');scroller.id='cv';scroller.append(el('div','grid-bg'));
  const stage=el('div','stage bench-stage');stage.id='stage';const width=Math.max(700,nodes.length*210+32),artifacts=run?.artifacts||[],maxArtifacts=Math.max(1,...nodes.map(n=>artifacts.filter(a=>a.nodeId===n.id).length));stage.style.width=width+'px';stage.style.height=(240+maxArtifacts*104)+'px';
  const positions=Object.fromEntries(nodes.map((n,i)=>[n.id,{x:24+i*210,y:34}]));
  const wires=document.createElementNS('http://www.w3.org/2000/svg','svg');wires.setAttribute('class','wires');wires.setAttribute('width',width);wires.setAttribute('height',240+maxArtifacts*104);wires.setAttribute('aria-hidden','true');
  for(const edge of graph.edges||[]){const a=positions[edge.from],b=positions[edge.to];if(!a||!b)continue;const line=document.createElementNS('http://www.w3.org/2000/svg','path');line.setAttribute('d',`M${a.x+168} ${a.y+35} C${a.x+190} ${a.y+35} ${b.x-22} ${b.y+35} ${b.x} ${b.y+35}`);if(benchNodeState(run,edge.from).status==='done')line.setAttribute('class','hot');wires.append(line);}stage.append(wires);
  nodes.forEach(n=>{
    const state=benchNodeState(run,n.id),pos=positions[n.id],node=el('div','node bench-node '+state.status);node.dataset.node=n.id;node.dataset.state=state.status;node.style.left=pos.x+'px';node.style.top=pos.y+'px';node.tabIndex=0;node.setAttribute('role','button');node.setAttribute('aria-label',(NODE_NAMES[n.type]||n.id)+' · '+n.id);
  const header=el('div','node-h');header.append(el('div','node-t',NODE_NAMES[n.type]||n.id));
    const bp=button('',()=>{},'bp'+(points.includes(n.id)?' on':''));bp.setAttribute('aria-label','断点 '+n.id);bp.setAttribute('aria-pressed',String(points.includes(n.id)));bp.disabled=!canSetBenchBreakpoint(run,n.id);bp.title=bp.disabled?'已执行或不在本次范围，不能添加断点':'在此节点之前暂停';bp.onclick=e=>{e.stopPropagation();toggleBenchBreakpoint(n.id);};header.append(bp);
    node.append(header,el('div','node-y',n.id),el('div','node-m',benchStateLabel(state.status)));
    node.onclick=()=>run?openBenchNode(run,n.id):openNode(n.id);node.onkeydown=e=>{if(e.target===node&&['Enter',' '].includes(e.key)){e.preventDefault();node.click();}};stage.append(node);
    artifacts.filter(a=>a.nodeId===n.id).forEach((a,i)=>{const line=document.createElementNS('http://www.w3.org/2000/svg','path');line.setAttribute('d',`M${pos.x+84} 126 V${190+i*104}`);wires.append(line);const card=button('',()=>openBenchArtifact(run,a),'card bench-artifact');card.dataset.artifact=a.id;card.dataset.run=run.id;card.dataset.node=n.id;card.style.left=pos.x+'px';card.style.top=(190+i*104)+'px';card.append(el('div','card-t',a.name),el('div','card-n',a.count),el('div','card-s',a.kind==='simulation'?'模拟物料 · 点击查看':'归档物料 · 点击查看'));stage.append(card);});
  });
  scroller.append(stage);box.append(scroller);
  const status=el('div','bench-run-status');status.setAttribute('role','status');status.append(el('span',null,run?.kind==='simulation'?'本次模拟：'+nodes.filter(n=>benchNodeState(run,n.id).status==='done').length+'/'+run.nodes.length+' 个节点完成 · '+artifacts.length+' 份模拟物料 · 真实产物 0':run?'归档节点完成不代表所有产品用例通过。':'在未执行节点上设置断点，再开始新 run。'));
  if(run?.pauseNode)status.append(el('strong',null,'暂停节点：'+run.pauseNode));box.append(status);return box;
}
