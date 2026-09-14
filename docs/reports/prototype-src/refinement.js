/* The full 09-prototype-workspace.html remains the base. These additions share its
   navigation, chat, canvas, drawers, code views and historical evidence views. */
const BASE_UI = {
  workspace: renderWorkspace, render, history: renderHistory, evals: renderEvals,
  sheet, dropNode, saveTopology, settings: renderSettings, target: sectTarget,
  env: sectEnv, prompt: sectPrompt, pref: sectPref, canvas: renderCanvas, diffVersions, artifactCards,
};
const MODULES = [
  { id:'project', name:'项目与环境', desc:'目标端、环境、登录与权限', stories:['US-01','US-02','US-22'] },
  { id:'requirements', name:'需求与测试设计', desc:'规格输入、界面探索、用例设计与门禁', stories:['US-03','US-04','US-05','US-06'] },
  { id:'execution', name:'代码生成与执行', desc:'生成代码、有界修复、单条与成套运行', stories:['US-07','US-08','US-09'] },
  { id:'special', name:'专项与质量趋势', desc:'视觉、性能、Web3 与回归趋势', stories:['US-10','US-11','US-12','US-13'] },
  { id:'workflow', name:'Workflow 与节点调试', desc:'工作流编排、版本、断点和局部运行', stories:['US-14','US-15','US-16'] },
  { id:'harness', name:'Harness 与自进化', desc:'外部能力、进程管理、评测与配对消融', stories:['US-17','US-18','US-19','US-20','US-21'] },
];
const STORY_NAMES = ['项目与目标端','环境与登录','规格导入','界面探索','测试设计方法','文本用例门禁','生成 Midscene 代码','有界修复','执行与归因','视觉基线','性能基线','Web3 断言','趋势与批次','工作流画布','工作流编排','节点调试','能力扩展','进程管理','质量评测','配对比较','组件消融','语言与模板'];
const ROLE_BINDINGS = {
  'source.spec': ['材料解析器','内置文档解析','提取文档内容、保留出处；不承担产品探索'],
  'source.explore': ['产品探索员','testpilot-explore','探索页面、记录观察'],
  'plan.stories': ['产品分析员','testpilot-stories','产出产品结构（主模块 / 子模块 / 功能）与跨模块用户故事'],
  'design.cases': ['测试设计师','testpilot-design','方法展开、领域约束、oracle'],
  'gate.textcase': ['质量审阅员','textcase-gate','检查规则、隔离不确定断言'],
  'codegen.case': ['测试开发','testpilot-generate','生成可执行 Midscene 测试'],
  'gate.code': ['质量审阅员','code-gate','静态校验与执行准入'],
  'repair.loop': ['修复工程师','testpilot-generate','限轮修复与失败归因'],
};
const R = {
  workView:'workflow', productNode:null, module:null, story:null, caseId:null, caseTab:'detail',
  project:'selftest', projects:initialProjects(), sidebarCollapsed:SHELL_PREFS.collapsed===true, language:['zh','en','ja'].includes(SHELL_PREFS.language)?SHELL_PREFS.language:'zh', filter:'all', query:'', cases:new Map(), selected:new Set(), picked:new Set(), caseFilters:{tier:'',method:''},
  graphVersion:3, graphCustomized:false, attempts:[], frozen:new Map(), graphSnapshots:new Map(),
  domains:[
    {id:'testing', name:'测试设计基础', version:1, state:'已绑定 · 样例', source:'测试设计方法与原型用例', content:'等价类、边界值、状态迁移、判定表、异常路径。每条预期须说明可观察量、数据来源与失败条件。', scope:'全部设计节点'},
    {id:'perp', name:'永续合约领域', version:1, state:'候选 · 待评估', source:'docs/v3/12 · N-16 / N-22', content:'数量精度、最小名义价值、保证金、只减仓、仓位方向。规则须保留交易所版本、来源和边界，禁止用模型常识替代产品规格。', scope:'尚未绑定'},
  ], domainDrafts:new Map(), roleVersions:new Map(), roleDrafts:new Map(), roleBoundInstructions:new Map(),
  mode:'web', plannerOverride:false, configRevision:1,
  models:{executorName:'',executorUrl:'',plannerName:'',plannerUrl:''},
  localConfig:{}, outputLanguage:'zh', evalView:'current', theme:SHELL_PREFS.theme==='dark'?'dark':'light', lastFocus:null,
  assistantOpen:false, batchMode:false, materialsNav:false,
  runId:null, benchRunId:null, runTab:'nodes', runQuery:'', runKind:'all',
  reviewInline:false, reviewScope:{module:null,story:null}, reviewQuery:'', reviewFilter:'all', reviewQueue:[],
};
const copy = value => JSON.parse(JSON.stringify(value));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button = (text, action, cls='text-button') => { const b=el('button',cls,text); b.type='button'; b.onclick=action; return b; };
const pill = (text, cls='') => el('span','chip '+cls,text);
const row = (...children) => { const n=el('div','row'); n.append(...children); return n; };
const note = text => el('div','note',text);
const titleRow = (title, sub, action) => { const n=el('div','section-title'); const t=el('div');t.append(el('h3',null,title));if(sub)t.append(el('p',null,sub));n.append(t);if(action)n.append(action);return n; };
function toast(message) { document.querySelector('.toast')?.remove();const n=el('div','toast',message);n.setAttribute('role','status');document.body.append(n);setTimeout(()=>n.remove(),4200); }
function field(label, value, onChange, options={}) {
  const wrap=el('div','field'), id='field-'+(++field.serial), lab=el('label',null,label);
  lab.htmlFor=id;const input=el(options.multiline?'textarea':'input');input.id=id;input.value=value ?? '';
  if(options.placeholder)input.placeholder=options.placeholder;
  if(options.disabled)input.disabled=true;
  input.addEventListener('input',()=>onChange?.(input.value));wrap.append(lab,input);return wrap;
}
field.serial=0;
function detailSection(title, content) { const b=el('section','detail-section');b.append(el('h3',null,title), typeof content==='string'?el('p',null,content):content);return b; }
function disclosure(title, ...children) { const d=el('details','disclosure');d.append(el('summary',null,title),...children);return d; }
function openAssistant(){R.assistantOpen=true;S.view='ws';closeSheet(false);render();$('#ta')?.focus();}
function table(headers, rows) {
  const wrap=el('div','review-table-wrap'), t=el('table','review-table'), h=el('thead'), hr=el('tr');
  headers.forEach(x=>hr.append(el('th',null,x)));h.append(hr);t.append(h);const b=el('tbody');
  rows.forEach(cells=>{const tr=el('tr');cells.forEach(x=>{const td=el('td');td.append(x instanceof Node?x:document.createTextNode(String(x)));tr.append(td);});b.append(tr);});t.append(b);wrap.append(t);return wrap;
}
function empty(title, text, action) { const n=el('div','empty-state');n.append(el('h3',null,title),el('p',null,text));if(action)n.append(action);return n; }
function link(label, href) { const a=el('a','text-button',label);a.href=href;return a; }
const storyId = c => c.id.match(/^US-\d+/)?.[0];
const cases = () => R.project==='selftest'?CASES:[];
const moduleFor = sid => MODULES.find(m=>m.stories.includes(sid));
const storyCases = sid => cases().filter(c=>storyId(c)===sid);
const moduleCases = id => {const ids=new Set(productNodeStoryIds(projectProductModel(),id));return cases().filter(c=>ids.has(storyId(c)));};
const caseKey = id => R.project+':'+id;
const caseReview = id => R.cases.get(caseKey(id));
const currentCase = id => { const c=cases().find(x=>x.id===id);return c?{...c,...caseReview(id)?.approved}:null; };
function route() {
  const q=new URLSearchParams({view:S.view,project:R.project});
  if(S.view==='ws'){q.set('work',R.workView);if(R.workView==='workflow'&&R.benchRunId)q.set('run',R.benchRunId);}
  if(['as','st','hi'].includes(S.view))q.set('section',S[S.view]);
  if(S.view==='ev')q.set('section',R.evalView);
  if(S.view==='hi'&&['workflow','workflow-detail'].includes(S.hi)&&R.runId){q.set('run',R.runId);q.set('runTab',R.runTab);}
  if(S.view==='as'&&S.as==='cases')q.set('scope',R.reviewScope.story||R.reviewScope.module||'all');
  if(R.productNode)q.set('productNode',R.productNode);if(R.reviewScope.productNode)q.set('reviewNode',R.reviewScope.productNode);if(R.module)q.set('module',R.module);if(R.story)q.set('story',R.story);if(R.caseId){q.set('case',R.caseId);q.set('tab',R.caseTab);}
  return '#'+q.toString();
}
function syncRoute() { const target=route();if(location.hash!==target){try{history.pushState(null,'',target);}catch{location.hash=target;}} }
function readRoute() {
  const q=new URLSearchParams(location.hash.slice(1));S.view=['ws','as','ev','hi','st'].includes(q.get('view'))?q.get('view'):'ws';
  R.project=q.get('project')||'selftest';R.workView=q.get('work')==='workflow'?'workflow':q.get('work')==='structure'||q.has('module')||q.has('story')||q.has('case')?'structure':'workflow';
  if(['as','st','hi'].includes(S.view)&&q.get('section'))S[S.view]=q.get('section');
  R.module=MODULES.some(m=>m.id===q.get('module'))?q.get('module'):null;
  R.story=REFINEMENT_DATA.stories[q.get('story')]?q.get('story'):null;R.productNode=projectProductModel().nodes.some(n=>n.id===q.get('productNode'))?q.get('productNode'):null;
  if(R.story)R.module=moduleFor(R.story)?.id??R.module;
  R.caseId=q.get('case');R.caseTab=['detail','edit','evidence'].includes(q.get('tab'))?q.get('tab'):'detail';
  if(S.view==='ev')R.evalView=['gold','historical'].includes(q.get('section'))?q.get('section'):'current';
  R.runId=q.get('run');R.runTab=['nodes','materials','snapshot','trace'].includes(q.get('runTab'))?q.get('runTab'):'nodes';
  R.benchRunId=S.view==='ws'&&R.workView==='workflow'?q.get('run'):null;
  if(S.view==='hi'&&S.hi==='workflow'){S.view='ws';R.workView='workflow';R.benchRunId=q.get('run');}
  if(S.view==='hi'&&S.hi==='workflow-detail')R.benchRunId=q.get('run');
  if(R.benchRunId){const selected=workflowRecords().find(r=>r.id===R.benchRunId);if(selected){R.module=selected.scope?.module||null;R.story=selected.scope?.story||null;}}
  const scope=q.get('scope');R.reviewScope={module:MODULES.some(m=>m.id===scope)?scope:moduleFor(scope)?.id||null,story:REFINEMENT_DATA.stories[scope]?scope:null,productNode:projectProductModel().nodes.some(n=>n.id===q.get('reviewNode'))?q.get('reviewNode'):null};
}
function navigateModule(id) { S.view='ws';R.workView='structure';R.productNode=null;R.module=id;R.story=null;R.caseId=null;R.query='';R.filter='all';R.caseFilters={tier:'',method:''};closeSheet(false);render(); }
function navigateStory(id) { S.view='ws';R.workView='structure';R.productNode='feature/'+id;R.module=moduleFor(id)?.id??null;R.story=id;R.caseId=null;R.query='';R.filter='all';R.caseFilters={tier:'',method:''};closeSheet(false);render(); }
function crumbs(withCase=false) {
  const n=el('div','crumbs');
  const add=(name,fn)=>{if(n.childNodes.length)n.append(el('span','sep','/'));n.append(fn?button(name,fn):el('span',null,name));};
  add(projectName(),()=>navigateModule(null));
  if(R.module)add(MODULES.find(m=>m.id===R.module)?.name,()=>navigateModule(R.module));
  if(R.story)add(R.story+' '+STORY_NAMES[Number(R.story.slice(3))-1],()=>navigateStory(R.story));
  if(withCase)add('用例详情');return n;
}
function flow(items) { const n=el('div','mini-flow');items.forEach(([name,fn],i)=>{if(i)n.append(el('span','flow-arrow','→'));n.append(button(name,fn,''));});return n; }
function scopedCases() { return R.story?storyCases(R.story):R.module?moduleCases(R.module):cases(); }
function chooseMapModule(id){
  const offset=document.querySelector('.module-map-scroll')?.scrollLeft||0;
  navigateModule(id);
  const map=document.querySelector('.product-module-map');if(!map)return;
  map.querySelector('.module-map-scroll').scrollLeft=offset;
  (id?map.querySelector('[data-module="'+id+'"]'):map.querySelector('.module-map-root'))?.focus({preventScroll:true});
}
function renderModuleMap(interactive=true){
  const wrapper=el(interactive?'section':'nav','product-module-map');wrapper.setAttribute('aria-label','产品模块关系图');
  const heading=el('div','module-map-heading');heading.append(el('strong',null,'产品模块图'),el('span',null,interactive?'点击模块，下方查看用户故事与用例。':'点击模块，跳转到对应的用户故事与用例。'));wrapper.append(heading);
  const scroll=el('div','module-map-scroll'),map=el('div','module-map-canvas');scroll.append(map);wrapper.append(scroll);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 1000 246');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('class','module-map-lines');svg.setAttribute('aria-hidden','true');
  MODULES.forEach((m,i)=>{const right=i>=3,y=38+(i%3)*84,path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',right?`M600 122 C650 122 650 ${y} 720 ${y}`:`M400 122 C350 122 350 ${y} 280 ${y}`);path.dataset.connection=m.id;if(interactive&&R.module===m.id)path.setAttribute('class','selected');svg.append(path);});map.append(svg);
  const root=interactive?button('',()=>chooseMapModule(null),'module-map-root'):el('div','module-map-root');root.append(el('strong',null,projectName()),el('small',null,MODULES.length+' 个模块 · '+Object.keys(REFINEMENT_DATA.stories).length+' 个故事'));root.querySelector('strong').dataset.material='';
  if(interactive){root.setAttribute('aria-label',projectName()+' · 全部模块');root.setAttribute('aria-pressed',String(!R.module));root.setAttribute('aria-controls','module-content');}map.append(root);
  MODULES.forEach((m,i)=>{
    const node=interactive?button('',()=>chooseMapModule(m.id),'module-map-node module-tile'):link('', '#'+m.id);node.className='module-map-node module-tile';node.dataset.module=m.id;node.dataset.side=i<3?'left':'right';node.style.top=(6+(i%3)*84)+'px';node.title=m.name+' · '+m.desc;
    node.append(el('strong',null,m.name),el('small',null,productNodeStoryIds(projectProductModel(),m.id).length+' 个关联故事 · '+moduleCases(m.id).length+' 条样例用例'));
    if(interactive){node.setAttribute('aria-pressed',String(R.module===m.id));node.setAttribute('aria-controls','module-content');node.setAttribute('aria-label',m.name);}map.append(node);
  });
  if(interactive)map.onkeydown=e=>{
    const node=e.target.closest('button');if(!node)return;const id=node.dataset.module,index=MODULES.findIndex(m=>m.id===id);let target;
    if(e.key==='Home')target=root;
    else if(node===root&&e.key==='ArrowLeft')target=map.querySelector('button[data-module="'+MODULES[0].id+'"]');
    else if(node===root&&e.key==='ArrowRight')target=map.querySelector('button[data-module="'+MODULES[3].id+'"]');
    else if(index>=0&&((index<3&&e.key==='ArrowRight')||(index>=3&&e.key==='ArrowLeft')))target=root;
    else if(index>=0&&['ArrowUp','ArrowDown'].includes(e.key)){const next=(index<3?0:3)+(index%3+(e.key==='ArrowDown'?1:2))%3;target=map.querySelector('button[data-module="'+MODULES[next].id+'"]');}
    if(target){e.preventDefault();target.focus();}
  };
  return wrapper;
}
function storyModuleList(ids,withModule=false){
  const headers=withModule?['模块','用户故事','样例用例','材料状态']:['用户故事','样例用例','材料状态'];
  return table(headers,ids.map(id=>{const content=[button(id+' · '+STORY_NAMES[Number(id.slice(3))-1],()=>navigateStory(id)),storyCases(id).length,storyCases(id).length?'可下钻':'原型未嵌入用例'];const related=projectProductModel().stories.find(s=>s.id===id)?.relatedModuleIds||[];if(related.length)content[0]=row(content[0],pill('跨模块'));if(withModule)content.unshift([moduleFor(id)?.name,...related.map(id=>MODULES.find(m=>m.id===id)?.name)].filter(Boolean).join(' / ')||'未归类');return content;}));
}
function renderProductReview(embedded=false) {
  const shell=el('div','review-shell');
  if(R.project!=='selftest'){shell.append(renderProjectEmpty());return shell;}
  const h=el('header','review-header');h.append(crumbs());
  const title=R.story?STORY_NAMES[Number(R.story.slice(3))-1]:R.module?MODULES.find(m=>m.id===R.module).name:'产品结构';
  h.append(el('h1',null,title),el('p',null,R.story?'查看该故事的用例；也可从模块图切换其他范围。':R.module?'已选中模块；下方列出该模块的用户故事。':'从模块图选择范围，再下钻故事、用例与证据。'));
  shell.append(h);
  const body=el('div','review-body');
  body.append(row(el('span','records-note','整理故事节点产出 · '+(productWorkspace().merged?'项目融合文档 v'+productWorkspace().revision:'规格重建参考 · 非历史 run 原产物')),button('查看产品文档',()=>openProductBundle(projectProductModel(),{reference:!productWorkspace().merged}))),renderModuleMap());
  const main=el('main','structure-content');main.id='module-content';main.setAttribute('aria-label','模块下的用户故事与用例');if(R.module)main.append(renderProductDrilldown());
  if(!R.module) {
    main.append(titleRow('全部用户故事',MODULES.length+' 个模块 · '+Object.keys(REFINEMENT_DATA.stories).length+' 个故事 · '+cases().length+' 条样例用例',button('审阅全部用例',()=>enterReview())));
    main.append(storyModuleList(MODULES.flatMap(m=>m.stories),true));
    const missing=Object.keys(REFINEMENT_DATA.stories).filter(id=>!storyCases(id).length);
    const findings=cases().filter(c=>c.f.length);
    main.append(disclosure('查看待关注项',table(['对象','审阅入口','范围'],[
      [button('门禁有意见的用例',()=>{R.filter='findings';openCasesTable();}),`${findings.length} 条待核对`,'断言、设计方法与降级原因'],
      [button('未嵌入用例的故事',()=>openStories()),`${missing.length} 个故事`,'原型材料缺口，不等于真实覆盖缺口'],
      [button('领域知识',()=>{S.view='as';S.as='domain';render();}),'测试设计 / 永续合约','来源、适用范围、版本与评估'],
    ])));
  } else if(!R.story) {
    const m=MODULES.find(x=>x.id===R.module);main.append(titleRow(m.name+' · 用户故事',productNodeStoryIds(projectProductModel(),m.id).length+' 个关联故事 · '+moduleCases(m.id).length+' 条样例用例',button('复核模块用例',()=>enterReview({module:m.id,story:null,productNode:R.productNode}))));
    const ids=productNodeStoryIds(projectProductModel(),R.productNode||m.id);main.append(storyModuleList(ids));
  } else {
    main.append(disclosure('需求原文',el('pre','source-excerpt',REFINEMENT_DATA.stories[R.story].excerpt),button('查看来源',()=>openSource(R.story))));
    main.append(detailSection('测试用例 · '+storyCases(R.story).length+' 条',renderCaseList(storyCases(R.story))));
  }
  body.append(main);shell.append(body);if(embedded)shell.style.minHeight='640px';return shell;
}
function renderCaseList(list) {
  const box=el('div'), filter=el('div','review-filter');
  const search=el('input');search.type='search';search.placeholder='搜索用例名称、ID 或断言';search.setAttribute('aria-label','搜索用例');search.value=R.query;
  const select=el('select');select.setAttribute('aria-label','审阅状态');[['all','全部状态'],['pending','待审阅'],['findings','门禁有意见'],['draft','有修订草稿'],['approved','已模拟确认'],['rejected','已模拟拒绝']].forEach(([v,t])=>select.append(new Option(t,v)));select.value=R.filter;
  const tier=el('select');tier.setAttribute('aria-label','判定硬度');[['','全部硬度'],['1','tier 1'],['2','tier 2'],['3','tier 3']].forEach(([v,t])=>tier.append(new Option(t,v)));tier.value=R.caseFilters.tier;
  const method=el('select');method.setAttribute('aria-label','设计方法');method.append(new Option('全部方法',''));[...new Set(list.map(c=>c.m))].forEach(v=>method.append(new Option(v,v)));method.value=R.caseFilters.method;
  const results=el('div'),bulk=el('div','review-bulk');let visible=[];const draw=()=>{
    results.replaceChildren();visible=list.filter(c=>(!R.query||[c.id,c.t,currentCase(c.id)?.exp].join(' ').toLowerCase().includes(R.query.toLowerCase()))&&(!R.caseFilters.tier||String(c.tier)===R.caseFilters.tier)&&(!R.caseFilters.method||c.m===R.caseFilters.method)&&(R.filter==='all'||R.filter==='pending'&&needsReview(c)||R.filter==='findings'&&c.f.length||R.filter==='draft'&&caseReview(c.id)?.draft||R.filter==='approved'&&(caseReview(c.id)?.approved||caseReview(c.id)?.reviewStatus==='approved')||R.filter==='rejected'&&caseReview(c.id)?.reviewStatus==='rejected'));
    drawBulk();
    if(!visible.length){results.append(empty('当前范围没有匹配用例','清除筛选，或返回模块查看其他故事。'));return;}
    const all=el('input');all.type='checkbox';all.setAttribute('aria-label','选择当前筛选结果');all.checked=visible.length>0&&visible.every(c=>R.picked.has(c.id));all.onchange=()=>{visible.forEach(c=>all.checked?R.picked.add(c.id):R.picked.delete(c.id));draw();};
    const resultTable=table(['选择','测试用例','审阅状态'],visible.map(c=>{
      const name=el('div');name.append(button(c.t,()=>selectCase(c.id)),el('small','case-excerpt',currentCase(c.id).exp));
      const r=caseReview(c.id);const review=el('div');review.append(pill(r?.draft?'有草稿':r?.reviewStatus==='rejected'?'已模拟拒绝':r?.approved||r?.reviewStatus==='approved'?'已模拟确认':'待核对',r?.draft?'judge':''));if(r?.priority)review.append(el('small',null,r.priority));
      const cb=el('input');cb.type='checkbox';cb.checked=R.picked.has(c.id);cb.setAttribute('aria-label','选择 '+c.id);cb.onchange=()=>{cb.checked?R.picked.add(c.id):R.picked.delete(c.id);drawBulk();};
      if(c.f.length)review.append(el('small',null,c.f.length+' 条检查意见'));
      return [cb,name,review];
    }));resultTable.querySelector('th').replaceChildren(all);resultTable.querySelectorAll('tr > :first-child').forEach(cell=>cell.hidden=!R.batchMode);results.append(resultTable);
  };
  const drawBulk=()=>{
    bulk.replaceChildren();bulk.hidden=!R.batchMode;const selected=visible.filter(c=>R.picked.has(c.id)), actions=el('div','toolbar-actions');actions.append(el('span','card-s',`已选 ${selected.length} 条（当前筛选范围）`));
    const find=el('input'), replacement=el('input');find.placeholder='查找断言文字';find.setAttribute('aria-label','批量查找');replacement.placeholder='替换为';replacement.setAttribute('aria-label','批量替换为');
    const replace=button('预览替换',()=>{if(!find.value){toast('请填写需要查找的文字');return;}let count=0;for(const c of selected){const value=currentCase(c.id).exp;if(!value.includes(find.value))continue;const state=caseReview(c.id)||{version:1};R.cases.set(caseKey(c.id),{...state,draft:{exp:value.split(find.value).join(replacement.value),reason:'批量字面替换：'+find.value+' → '+replacement.value}});count++;}toast(count+' 条生成修订草稿；进入用例查看前后差异');draw();},'');replace.disabled=!selected.length;
    const priority=el('select');priority.setAttribute('aria-label','批量优先级');priority.append(new Option('设置优先级',''));['P0','P1','P2'].forEach(p=>priority.append(new Option(p,p)));priority.disabled=!selected.length;priority.onchange=()=>{if(!priority.value)return;for(const c of selected)R.cases.set(caseKey(c.id),{version:1,...caseReview(c.id),priority:priority.value});draw();};
    actions.append(find,replacement,replace,priority);
    for(const [label,status] of [['模拟确认选中','approved'],['模拟拒绝选中','rejected']]){const b=button(label,()=>{for(const c of selected){R.cases.set(caseKey(c.id),{version:1,...caseReview(c.id),reviewStatus:status});R.picked.delete(c.id);}toast('已记录 '+selected.length+' 条模拟审阅决定；修订草稿仍需逐条确认');draw();},'');b.disabled=!selected.length;actions.append(b);}
    const regen=button('起草重生成请求',()=>{S.ctx={kind:'card',id:'selected-cases',label:selected.length+' 条选中用例'};openAssistant();say('you','请按门禁意见起草这 '+selected.length+' 条用例的修订：'+selected.map(c=>esc(c.id)).join('、'));say('bot','已带入选中对象。此原型没有调用模型；真实重生成应进入设计节点并形成逐条可审阅的新版本。');},'');regen.disabled=!selected.length;actions.append(regen);bulk.append(actions);
  };
  const extra=disclosure('更多筛选',row(tier,method));extra.classList.add('filter-disclosure');extra.open=!!(R.caseFilters.tier||R.caseFilters.method);
  const batch=button(R.batchMode?'退出批量':'批量处理',()=>{R.batchMode=!R.batchMode;batch.textContent=R.batchMode?'退出批量':'批量处理';batch.setAttribute('aria-pressed',String(R.batchMode));draw();});batch.setAttribute('aria-pressed',String(R.batchMode));
  search.oninput=()=>{R.query=search.value;draw();};select.onchange=()=>{R.filter=select.value;draw();};tier.onchange=()=>{R.caseFilters.tier=tier.value;draw();};method.onchange=()=>{R.caseFilters.method=method.value;draw();};filter.append(search,select,extra,batch);box.append(filter,bulk,results);draw();return box;
}
function openSource(id) {
  const source=REFINEMENT_DATA.stories[id];if(!source)return;
  sheet(id+' · 需求来源',b=>{b.append(crumbs(),detailSection('02-业务规格与用户故事.md · 第 '+source.line+' 行',el('pre',null,source.excerpt)),note('这里展示归档规格原文。用例里的隐含预期仍需产品确认；故事归属不等于每一条断言都已有验收依据。'),button('返回故事',()=>navigateStory(id)));});
}
openStories=function(){sheet('用户故事 · 全部 22 个',b=>{b.append(table(['模块','用户故事','嵌入用例'],Object.keys(REFINEMENT_DATA.stories).map(id=>[moduleFor(id)?.name??'未分组',button(id+' '+STORY_NAMES[Number(id.slice(3))-1],()=>navigateStory(id)),storyCases(id).length])));});};
openCasesTable=function(){sheet('用例审阅 · '+(R.story||MODULES.find(m=>m.id===R.module)?.name||'全部'),b=>{b.append(crumbs(),renderCaseList(scopedCases()));});};
selectCase=function(id){
  R.reviewScroll=$('#case-queue')?.scrollTop||0;
  if(S.view==='ws'&&R.workView==='structure'){R.reviewScope={module:R.module,story:R.story};S.view='as';S.as='cases';R.materialsNav=false;}
  $('#sheet').hidden=true;
  const c=currentCase(id);R.caseId=id;R.caseTab='detail';if(c){R.story=storyId(c);R.module=moduleFor(R.story)?.id;S.ctx={kind:'case',id,label:c.id+' · '+c.t};}render();openCase(id);
};
openCase=function(id,tab=R.caseTab){
  const c=currentCase(id);R.caseId=id;R.caseTab=tab;syncRoute();
  if(!c){sheet('用例不可用',b=>b.append(empty('找不到这条用例','该 ID 不在当前项目的原型材料中。',button('返回项目',()=>navigateModule(null)))));return;}
  R.story=storyId(c);R.module=moduleFor(R.story)?.id;syncRoute();
  (R.reviewInline && $('#case-detail') ? inlineCase : sheet)(c.t,b=>{
    b.append(crumbs(true));
    const tabs=el('div','detail-tabs');tabs.setAttribute('role','tablist');
    [['detail','详情与来源'],['edit','修订与对比'],['evidence','代码与证据']].forEach(([key,t])=>{const bt=button(t,()=>openCase(id,key),'');bt.setAttribute('role','tab');bt.setAttribute('aria-selected',String(tab===key));tabs.append(bt);});b.append(tabs);
    if(tab==='detail'){
      b.append(detailSection('预期结果 / 断言',c.exp));const ol=el('ol','steps');c.steps.forEach(s=>ol.append(el('li',null,s)));b.append(detailSection('执行步骤',ol));
      if(c.f.length){const f=el('div');c.f.forEach(x=>f.append(el('div','finding',x.r+' · '+x.m)));b.append(detailSection('门禁意见 · 历史记录',f));}
      b.append(disclosure('来源与技术信息',row(pill(c.id),pill(c.m),pill('tier '+c.tier)),button('规格原文',()=>openSource(R.story)),note('修改预期结果后，需要重新验证关联代码和执行结果。')));
      const footer=el('div','detail-footer'),review=caseReview(id);
      const confirm=button(review?.draft?'查看修订草稿':!needsReview(c)&&review?.reviewStatus!=='rejected'?'已模拟确认':'模拟确认此用例',()=>{if(caseReview(id)?.draft){openCase(id,'edit');return;}R.cases.set(caseKey(id),{version:1,...caseReview(id),reviewStatus:'approved'});render();openCase(id,'detail');toast('已记录本地审阅决定，未触发执行');},'primary');confirm.disabled=!review?.draft&&!needsReview(c)&&review?.reviewStatus!=='rejected';
      footer.append(confirm,button('修订这条用例',()=>openCase(id,'edit'),''),button('询问助手',()=>{S.ctx={kind:'case',id,label:c.t};openAssistant();},''));b.append(footer);
    } else if(tab==='edit') {
      const existing=caseReview(id)||{version:1};let expected=existing.draft?.exp??c.exp, reason=existing.draft?.reason??'';
      b.append(row(pill('当前 v'+existing.version),pill(existing.draft?'修订草稿':'尚未修订','judge')));
      const compare=el('div','compare-grid'), before=el('div','before'), after=el('div','after');before.append(el('h4',null,'当前版本'),el('p',null,c.exp));after.append(el('h4',null,'拟变更内容'));const afterText=el('p',null,expected);after.append(afterText);compare.append(before,after);b.append(detailSection('断言对比',compare));
      b.append(field('修订后的预期结果',expected,v=>{expected=v;afterText.textContent=v;},{multiline:true}),field('修订依据 / 原因',reason,v=>{reason=v;},{multiline:true,placeholder:'引用规格、领域规则或产品确认；说明可观察量。'}));
      b.append(note('影响范围：仅此用例；关联代码与运行证据标为待重验。原始材料和其他用例保持可追溯。'));
      const footer=el('div','detail-footer'), status=el('div','status');status.setAttribute('role','status');
      footer.append(button('保存草稿',()=>{if(!expected.trim()||!reason.trim()){status.textContent='请填写预期结果与修订依据。';return;}if(expected.trim()===c.exp.trim()){status.textContent='预期结果尚未改变。';return;}R.cases.set(caseKey(id),{...existing,draft:{exp:expected.trim(),reason:reason.trim()},version:existing.version});openCase(id,'edit');toast('已保存此用例草稿');},'primary'));
      if(existing.draft)footer.append(button('模拟确认修订',()=>{R.cases.set(caseKey(id),{...existing,approved:{exp:existing.draft.exp},history:[...(existing.history||[]),{before:c.exp,after:existing.draft.exp,reason:existing.draft.reason}],version:existing.version+1,draft:null,stale:true});openCase(id,'detail');toast('已生成本地 v'+(existing.version+1)+'；代码与证据待重验');},''),button('撤销草稿',()=>{R.cases.set(caseKey(id),{...existing,draft:null});openCase(id,'edit');},''));
      footer.append(status);b.append(footer);
      if(existing.history?.length)b.append(detailSection('修订记录',table(['版本','依据','前 → 后'],existing.history.map((h,i)=>['v'+(i+2),h.reason,h.before+' → '+h.after]))));
    } else {
      const code=CODE.code[id], review=caseReview(id);
      if(review?.stale)b.append(el('div','warnline','此用例已修订。下方历史代码与结果已过期，须重新生成并执行。'));
      if(code){b.append(detailSection('已嵌入的历史执行记录',note('来自原型原有运行样例，不能用于证明当前产品通过。')),button('打开代码 / diff / 执行详情',()=>openCaseCode(id)));}
      else b.append(empty('本条执行证据尚未嵌入','保留证据缺口；不会用其他用例的截图或运行结果代替。',button('查看工作流',()=>{closeSheet(false);S.view='ws';R.workView='workflow';render();})));
      b.append(disclosure('证据字段说明',table(['对象','关联要求'],[['生成代码','caseId + caseVersion + workflowVersion'],['执行尝试','attemptId、环境快照、模型配置版本'],['判定','机器判据 / 模型判定、观察值、失败归因'],['附件','日志、截图、追踪与内容指纹']])));
    }
  });
};

const NODE_NAMES={'source.spec':'读取材料','source.explore':'探索界面','plan.stories':'整理故事','design.cases':'设计用例','gate.textcase':'检查用例','codegen.case':'生成代码','gate.code':'检查代码','repair.loop':'修复与验证'};
function needsReview(c){const r=caseReview(c.id);return !!r?.draft||!(r?.approved||['approved','rejected'].includes(r?.reviewStatus));}
function flowSummary(){
  const list=scopedCases(),ids=new Set(list.map(c=>c.id));
  const results=CODE.outcomes.filter(r=>ids.has(r.id));
  const stale=results.filter(r=>caseReview(r.id)?.stale);
  return {list,results,stale,codes:list.filter(c=>CODE.code[c.id]),pending:list.filter(needsReview),
    rejected:list.filter(c=>caseReview(c.id)?.reviewStatus==='rejected'),
    stories:R.story?1:R.module?MODULES.find(m=>m.id===R.module).stories.length:22,
    modules:R.module?1:MODULES.length};
}
function flowScopeLabel(){return R.story?R.story+' · '+STORY_NAMES[Number(R.story.slice(3))-1]:R.module?MODULES.find(m=>m.id===R.module).name:'整个项目';}
function switchWorkView(view){closeSheet(false);S.view='ws';R.workView=view;render();}
function openFlowCases(filter='all'){R.filter=filter;R.query='';R.caseFilters={tier:'',method:''};R.batchMode=false;openCasesTable();}
function openFlowCode(){const summary=flowSummary();sheet('测试代码 · '+flowScopeLabel(),b=>{
  if(!summary.codes.length){b.append(empty('当前范围尚未嵌入测试代码','从用例详情核对预期，再通过生成节点调试。',button('查看生成节点',()=>openNode('codegen'))));return;}
  b.append(note('归档代码样例；修订后的用例需要重新生成与验证。'),table(['用例','版本状态','操作'],summary.codes.map(c=>[c.t,caseReview(c.id)?.stale?'修订后待重验':'历史样例',button('查看代码与差异',()=>openCaseCode(c.id))])));
});}
function openFlowResults(){const summary=flowSummary();sheet('执行证据 · '+flowScopeLabel(),b=>{
  if(!summary.results.length){b.append(empty('当前范围没有执行证据','这里保留证据缺口，不使用其他故事的结果。',button('查看对应用例',()=>openFlowCases())));return;}
  b.append(note('以下为原型嵌入的历史运行，不代表本次修订已经通过。'),table(['用例','历史结果','证据状态','操作'],summary.results.map(result=>{
    const c=currentCase(result.id);return [c.t,result.status==='passed'?'通过':result.kind==='infra'?'环境失败':'断言失败',caseReview(c.id)?.stale?'已过期 · 待重验':'归档样例',button('查看结果',()=>{selectCase(c.id);openCase(c.id,'evidence');})];
  })),el('p','sub',`${summary.list.length-summary.results.length} 条用例尚未嵌入执行证据。`));
});}
function workflowRecords(){return [...R.attempts.filter(a=>a.project===R.project).slice().reverse(),...(R.project==='selftest'?[ARCHIVED_WORKFLOW]:[])];}
const runModeLabel=mode=>({full:'全流程',single:'单节点',selected:'多节点',from:'从节点续跑'})[mode]||'未记录';
const runStatusLabel=r=>benchRunLabel(r);
const recordNodes=r=>r.kind==='archive'?r.nodes:r.nodes.map(id=>r.graph.nodes.find(n=>n.id===id)).filter(Boolean);
function openWorkflowRuns(){openBenchRunPicker();}
function openWorkflowRun(id){R.runId=id;R.benchRunId=id;R.runTab='nodes';goTo('hi','workflow-detail');}
function openRecordedNode(r,n){sheet(n.id+' · '+r.id,b=>{
  b.append(row(pill('执行版本 v'+r.graph.version),pill(runStatusLabel(r))),detailSection('节点',`${NODE_NAMES[n.type]||n.id} · ${n.type}`));
  if(r.kind==='archive')b.append(detailSection('归档节点统计',`${fmtMs(n.ms)} · ${n.calls} calls · ${n.tokens} tokens`),note('该归档未保存节点参数和模型端点，不能由当前设置补齐。'));
  else b.append(detailSection('本次冻结参数',el('pre',null,JSON.stringify(n.params,null,2))),detailSection('Role / Skill',`${n.role||'未绑定'} / ${n.skill||'未绑定'} · v${n.skillVersion||1}`),note('模拟记录状态和占位物料，没有调用模型或生成真实测试产物。'));
  const back=button('返回运行详情',()=>closeSheet(),''),edit=button('在工作副本中调试',()=>{prepareBenchRun();openNode(n.id);},'');edit.disabled=!RUN.nodes.some(x=>x.id===n.id&&x.type===n.type);b.append(row(back,edit));
});}
function renderWorkflowRecords(){
  const page=el('div','workflow-records'),records=workflowRecords(),r=records.find(a=>a.id===R.runId);
  const header=el('header','records-heading'),title=el('div');
  title.append(el('h1',null,R.runId?'工作流运行详情':'工作流执行记录'),el('p',null,R.runId?R.runId:'查看每次编排与节点调试的范围、版本和产出。'));
  const actions=el('div','toolbar-actions');if(R.runId)actions.append(button('返回记录列表',openWorkflowRuns,''));
  actions.append(button('返回 Flow 工作台',()=>goTo('ws'),''));if(R.project==='selftest')actions.append(button('新建模拟运行',()=>openRunScope('full'),'primary'));header.append(title,actions);page.append(header);
  if(R.runId&&!r){page.append(empty('这条工作流记录不可用','模拟记录只保存在当前页面会话中；刷新后可能已清空，也可能属于其他项目。',button('查看本项目记录',openWorkflowRuns)));return page;}
  if(!R.runId){
    const filters=el('div','record-filters'),query=el('input'),kind=el('select');query.type='search';query.placeholder='搜索运行 ID、节点或入口';query.setAttribute('aria-label','搜索工作流记录');query.value=R.runQuery;
    kind.setAttribute('aria-label','工作流记录来源');[['all','全部记录'],['simulation','本次模拟'],['archive','归档样例']].forEach(([v,l])=>kind.append(new Option(l,v)));kind.value=R.runKind;
    const list=el('div','record-list'),draw=()=>{
      list.replaceChildren();const matches=records.filter(a=>(R.runKind==='all'||a.kind===R.runKind)&&(!R.runQuery||(a.id+' '+a.entry+' '+recordNodes(a).map(n=>n.id).join(' ')).toLowerCase().includes(R.runQuery.toLowerCase())));
      if(!matches.length){list.append(empty(records.length?'没有匹配的工作流记录':'尚无工作流执行记录',records.length?'调整搜索或来源筛选。':'在 Flow 中配置工作流并运行后，记录会出现在这里。',button(records.length?'清除筛选':'返回工作台',()=>{if(records.length){R.runQuery='';R.runKind='all';render();}else goTo('ws');})));return;}
      list.append(table(['运行 / 时间','执行范围','工作流版本','入口','状态','节点累计耗时'],matches.map(a=>{
        const name=el('div');name.append(button(a.id,()=>openWorkflowRun(a.id)),el('small',null,a.createdAt?new Date(a.createdAt).toLocaleString('zh-CN',{hour12:false}):'原归档未记录开始时间'));
        return [name,runModeLabel(a.mode)+' · '+recordNodes(a).length+' 个节点',a.workflow+' · v'+a.graph.version,a.entry,runStatusLabel(a),a.kind==='archive'?fmtMs(a.nodes.reduce((sum,n)=>sum+n.ms,0)):'模拟未计时'];
      })));
    };
    query.oninput=()=>{R.runQuery=query.value;draw();};kind.onchange=()=>{R.runKind=kind.value;draw();};filters.append(query,kind,el('span',null,records.length+' 条 · 当前项目'));page.append(filters,list,el('p','records-note','原型模拟记录保存在当前会话，刷新后清空。测试用例的通过与失败见「运行报告」。'));draw();return page;
  }
  const meta=el('div','run-meta');meta.append(pill(runStatusLabel(r)),pill(r.workflow+' · v'+r.graph.version),pill(runModeLabel(r.mode)+' · '+recordNodes(r).length+' 节点'),pill(r.entry),pill(r.calls+' calls'));page.append(meta);
  if(r.kind==='simulation')page.append(el('p','records-note','本次节点状态与物料均为交互模拟，真实产物为 0；不引用其他运行的产物。'));
  else page.append(el('p','records-note','原型归档记录。节点统计不代表所有测试通过；未采集的时间、模型和参数保留为空。'));
  page.append(el('p','records-note','关联产品范围：'+(r.kind==='archive'?'归档未记录':r.scope?.story||MODULES.find(m=>m.id===r.scope?.module)?.name||'整个项目')));
  const tabs=el('div','detail-tabs');tabs.setAttribute('role','tablist');[['nodes','节点记录'],['materials','产出物料'],['snapshot','冻结配置'],['trace','日志与事件']].forEach(([id,label])=>{const b=button(label,()=>{R.runTab=id;render();},'');b.setAttribute('role','tab');b.setAttribute('aria-selected',String(R.runTab===id));tabs.append(b);});page.append(tabs);
  const body=el('div','run-detail-content');
  if(R.runTab==='nodes'){
    body.append(table(['节点','状态','耗时 / 调用','详情'],recordNodes(r).map(n=>[NODE_NAMES[n.type]||n.id,benchStateLabel(benchNodeState(r,n.id).status),r.kind==='archive'?fmtMs(n.ms)+' / '+n.calls+' calls':'模拟 · 0 calls',button(n.id,()=>openRecordedNode(r,n))])));
    body.append(detailSection('复用输入',r.reused.length?r.reused.join('；'):'无记录'),button('返回 Flow 工作副本',()=>goTo('ws')));
  }
  if(R.runTab==='materials'){
    if(r.kind==='simulation'){body.append(note('模拟物料仅是节点输出的占位记录，没有生成真实用例或执行证据。'));if(r.artifacts.length)body.append(table(['节点','模拟物料','查看'],r.artifacts.map(a=>[a.nodeId,a.name,button('查看内容',()=>openBenchArtifact(r,a))])));else body.append(empty('此 run 尚无物料','尚未完成任何节点。'));}
    else{body.append(table(['归档物料','嵌入数量','查看'],[
      ['文本用例子集',r.cases.length,button('查看归档用例',()=>sheet(r.id+' · 归档用例子集',b=>b.append(note('只读归档内容；当前工作副本的修订不回写这里。'),table(['用例','原始预期'],r.cases.map(c=>[c.t,c.exp])))))],
      ['代码与执行结果',r.outcomes.length,button('查看归档执行结果',()=>sheet(r.id+' · 归档执行结果',b=>b.append(table(['用例 ID','结果','归因','耗时'],r.outcomes.map(o=>[o.id,o.status,o.kind||'无',fmtMs(o.ms)])),note('原归档包含 4 条执行记录，其中 2 条 ID 能与当前嵌入用例匹配。'))))],
    ]),note('这里只展示该归档已嵌入的材料，不把完整规格中的 22 个故事当作此运行生成的故事。'));}
  }
  if(R.runTab==='snapshot')body.append(detailSection('运行冻结的定义',el('pre',null,JSON.stringify(r.graph,null,2))),detailSection('入口与模型',r.kind==='archive'?'原归档仅保留提示词指纹，模型端点和环境版本未记录。':r.entry+' · 模型配置修订 '+r.graph.modelConfigRevision+' · 本次没有模型调用'),note('修改工作副本、领域或技能后，已保存的运行快照仍保持原值。'));
  if(R.runTab==='trace'){
    if(r.kind==='archive')body.append(empty('原始事件日志未嵌入','可以查看归档节点统计；不能据此还原未保存的原始日志或启动时间。'));
    else body.append(table(['时间','事件','节点'],r.events.map(e=>[new Date(e.at).toLocaleString('zh-CN',{hour12:false}),e.type,e.node||'—'])));
  }
  page.append(body);return page;
}
function nodeDestinations(n){
  const box=el('section','node-destinations');box.append(el('h4',null,'相关产物与操作'));const actions=el('div','toolbar-actions');
  const review=()=>enterReview({module:R.module,story:R.story});
  const entries={
    'source.spec':[['查看规格',openSpec],['项目与环境',()=>goTo('st','target')]],
    'source.explore':[['探索材料',openSpec],['目标与登录',()=>goTo('st','env')]],
    'plan.stories':[],
    'design.cases':[['复核用例',review],['领域知识',()=>goTo('as','domain')]],
    'gate.textcase':[['查看检查意见',()=>openFlowCases('findings')],['复核用例',review]],
    'codegen.case':[['测试代码',openFlowCode],['执行模型',()=>goTo('st','model')]],
    'gate.code':[['测试代码',openFlowCode],['执行证据',openFlowResults]],
    'repair.loop':[['运行报告',()=>goTo('hi','runs')],['基线与回归',()=>goTo('hi','base')]],
  };
  if(n.type==='plan.stories')box.append(note('运行完成后，点击节点下方的“产品结构 + 用户故事”物料查看。'));
  for(const [label,fn] of entries[n.type]||[])actions.append(button(label,fn,''));actions.append(button('Role / Skill',()=>openRole(n.type),''));box.append(actions);return box;
}
function renderFlowActivity(){
  const records=workflowRecords(),latest=records[0],bar=el('div','flow-activity');
  if(latest){bar.append(el('span','activity-label','最近一次'),button(latest.id,()=>selectBenchRun(latest.id)),el('span',null,runStatusLabel(latest)+' · v'+latest.graph.version+' · '+runModeLabel(latest.mode)),button('全部执行记录',openWorkflowRuns,''));}
  else bar.append(el('span',null,'尚无执行记录'));
  return bar;
}

function openScopeArtifacts(){sheet('产物 · '+flowScopeLabel(),b=>{const stats=flowSummary();b.append(table(['产物','当前范围','查看'],[['测试用例',stats.list.length,button('进入复核',()=>enterReview({module:R.module,story:R.story}))],['测试代码',stats.codes.length,button('查看代码',openFlowCode)],['执行证据',stats.results.length+' 条历史结果'+(stats.stale.length?' · '+stats.stale.length+' 条待重验':''),button('查看执行证据',openFlowResults)]]));});}
function setWorkflowSource(kind,reopen=true){
  if(!['spec','explore'].includes(kind))return;productWorkspace().input.kind=kind;if(S.source===kind)return;
  const first=RUN.nodes.find(n=>n.type.startsWith('source.'));if(!first)return;
  const oldId=first.id,newId=kind==='spec'?'spec':'explore';
  first.id=newId;first.type='source.'+kind;S.source=kind;
  NODE_POS[newId]=NODE_POS[oldId];if(newId!==oldId)delete NODE_POS[oldId];
  for(const edge of EDGES){if(edge.from===oldId)edge.from=newId;if(edge.to===oldId)edge.to=newId;}
  S.nodeState[newId]='idle';if(newId!==oldId)delete S.nodeState[oldId];
  if(S.bp.delete(oldId))S.bp.add(newId);if(R.selected.delete(oldId))R.selected.add(newId);
  saveGraphRevision('修改输入来源');if(reopen){render();openWorkflowInput();}
}
function openWorkflowInput(){sheet('输入材料',b=>{const draw=()=>{b.replaceChildren(renderInputForm(draw,openWorkflowInput));};draw();});}
function workflowToolbar(){
  const bar=el('div','work-toolbar workflow-toolbar');
  if(R.project!=='selftest')return bar;
  if(R.workView==='structure'){bar.append(button('返回工作台',()=>goTo('ws'),''),button('用例复核',()=>enterReview({module:R.module,story:R.story,productNode:R.productNode}),''),button('融合审阅',openProductMerge,''),button('导出产品文档',()=>downloadProductModel(projectProductModel()),''));return bar;}
  bar.append(benchRunSelector());
  if(!R.benchRunId){const source=button('',openWorkflowInput,'workflow-source');source.setAttribute('aria-label','输入材料');source.title='输入材料';source.append(shellIcon('files'),el('span',null,productWorkspace().input.kind==='spec'?'规格文档':'探索界面'));bar.append(source);}
  if(!R.benchRunId&&(R.module||R.story)){const scope=el('div','workflow-scope');scope.append(el('span',null,flowScopeLabel()));const clear=button('×',()=>{R.module=R.story=R.caseId=null;render();},'');clear.title='查看整个项目';clear.setAttribute('aria-label','查看整个项目');scope.append(clear);bar.append(scope);}
  if(!R.benchRunId&&R.graphCustomized){const variant=button('实验流程',()=>goTo('st','workflow'),'workflow-variant');bar.append(variant);}
  const actions=el('div','toolbar-actions'),more=disclosure('更多');more.className='workflow-more';
  const menu=el('div','workflow-more-actions'),items=R.benchRunId?[['选择运行记录',openBenchRunPicker],['本次全部物料',openRunMaterials],['运行详情',()=>openWorkflowRun(R.benchRunId)]]:[['选择运行记录',openBenchRunPicker],['调试节点',()=>openRunScope('selected')],['范围产物',openScopeArtifacts],['流程设置',()=>goTo('st','workflow')]];for(const [label,action] of items)menu.append(button(label,()=>{more.open=false;action();},''));more.append(menu);
  more.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();more.open=false;more.firstElementChild.focus();}};
  actions.append(more);
  if(R.benchRunId){const run=benchRun(),resume=button(run?.status==='ready'?'启动此 run':'继续此 run',()=>executeBenchRun(R.benchRunId),'primary');resume.disabled=!run||run.kind!=='simulation'||!['ready','paused','failed'].includes(run.status);resume.title=resume.disabled?'仅暂停或失败且可恢复的 run 可以继续':'';actions.append(button('新建 run',prepareBenchRun,''),resume);}
  else actions.append(button('开始执行',()=>openRunScope('full'),'primary'));bar.append(actions);return bar;
}
renderWorkspace=function(){
  const ws=BASE_UI.workspace(), originalRight=ws.children[1], area=el('div','work-area');
  const chat=ws.querySelector('.chat');chat.hidden=!R.assistantOpen;ws.classList.toggle('assistant-open',R.assistantOpen);
  area.append(workflowToolbar());
  if(R.workView==='structure')area.append(renderProductReview());
  else if(R.project==='selftest'||R.benchRunId){originalRight.querySelector('.trace')?.remove();originalRight.style.flex='1';area.append(originalRight,renderFlowActivity());}
  else area.append(renderProductReview());
  if(originalRight.parentNode===ws)ws.replaceChild(area,originalRight);else ws.append(area);
  const hints=ws.querySelector('.hints');hints.replaceChildren();
  const suggestions=R.story?['核对当前故事的覆盖缺口','起草当前用例的断言修订','检查关联领域规则']:['按产品模块审阅覆盖缺口','查看需要核对的门禁意见','为节点调试制定范围'];
  const ta=ws.querySelector('#ta'), sendButton=ws.querySelector('#send');sendButton.disabled=true;
  ta.oninput=()=>{sendButton.disabled=!ta.value.trim();};suggestions.forEach(text=>hints.append(button(text,()=>{ta.value=text;ta.dispatchEvent(new Event('input'));ta.focus();},'hint')));
  const ch=ws.querySelector('.chat-h');ch.title='Web 使用规划模型；Claude / Codex / PenguinHarness 使用宿主模型。此原型仅演示对话上下文。';
  ch.querySelector('.card-s').textContent='演示对话';ch.append(button('收起助手',()=>{R.assistantOpen=false;render();},'chat-back text-button'));return ws;
};
reply=function(text){
  if(S.ctx?.kind==='case')return `当前范围：<b>${esc(S.ctx.label)}</b>。建议核对预期结果的可观察量与规格来源，再在「修订与对比」中保存草稿。此演示不会自动改写用例。`;
  if(/节点|调试|跑/.test(text))return '点击流程节点可只跑此节点或从此节点续跑；「更多 → 调试节点」可选择多个节点。运行前会列出实际执行范围、复用输入和版本；本原型只生成模拟 attempt。';
  return '从整理故事节点下方的「产品结构 + 用户故事」物料进入审阅，再按模块和故事查看用例与门禁意见。历史运行从工作台的运行选择器进入。需要修订时，将具体对象加入对话上下文。';
};
send=function(){const ta=$('#ta');if(!ta?.value.trim())return;const text=ta.value.trim();say('you',esc(text),S.ctx?.label);ta.value='';$('#send').disabled=true;say('bot',reply(text));};

function graphSnapshot() { const input=inputSnapshot();return {version:R.graphVersion,nodes:copy(RUN.nodes.map(n=>({id:n.id,type:n.type,params:PARAMS[n.id]||{},role:ROLE_BINDINGS[n.type]?.[0],skill:ROLE_BINDINGS[n.type]?.[1],skillVersion:R.roleVersions.get(n.type)||1,context:contextForNode(n.type,input,{module:R.module,story:R.story})}))),edges:copy(EDGES),modelConfigRevision:R.configRevision,models:copy({entry:R.mode,plannerOverride:R.plannerOverride,...R.models})}; }
function saveGraphRevision(description) {
  R.graphVersion=Math.max(R.graphVersion,...VERSIONS.map(v=>v.v))+1;
  VERSIONS.unshift({v:R.graphVersion,at:'本次会话',note:description});
  S.verA=R.graphVersion-1;S.verB=R.graphVersion;S.verDiff=null;
  R.graphSnapshots.set(R.graphVersion,graphSnapshot());
}
diffVersions=function(a,b){
  const left=R.graphSnapshots.get(a),right=R.graphSnapshots.get(b);if(!left||!right)return BASE_UI.diffVersions(a,b);
  if(a===b)return ['两个版本相同'];const changes=[];
  for(const n of left.nodes){const other=right.nodes.find(x=>x.id===n.id);if(!other)changes.push('- 节点 '+n.id);else for(const key of ['type','params','skill','skillVersion'])if(JSON.stringify(n[key])!==JSON.stringify(other[key]))changes.push('~ '+n.id+'.'+key+': '+JSON.stringify(n[key])+' → '+JSON.stringify(other[key]));}
  for(const n of right.nodes)if(!left.nodes.some(x=>x.id===n.id))changes.push('+ 节点 '+n.id);
  const wire=e=>e.from+' → '+e.to;left.edges.forEach(e=>{if(!right.edges.some(x=>wire(x)===wire(e)))changes.push('- 连线 '+wire(e));});right.edges.forEach(e=>{if(!left.edges.some(x=>wire(x)===wire(e)))changes.push('+ 连线 '+wire(e));});
  return changes.length?changes:['节点与连线定义相同；检查模型配置版本与运行设置。'];
};
RUN.nodes.forEach(n=>R.frozen.set(n.id,{revision:3,type:KINDS[n.type]?.out,source:'历史样例输入'}));
R.graphSnapshots.set(3,graphSnapshot());
// Capture archive facts before editing can mutate the working graph.
const ARCHIVED_WORKFLOW={id:RUN.id,project:'selftest',workflow:RUN.graph,kind:'archive',status:'archived',
  version:RUN.version,mode:'full',createdAt:null,entry:'未记录',calls:RUN.nodes.reduce((sum,n)=>sum+n.calls,0),
  tokens:RUN.nodes.reduce((sum,n)=>sum+n.tokens,0),nodes:copy(RUN.nodes),reused:[],
  graph:{version:RUN.version,nodes:copy(RUN.nodes.map(n=>({id:n.id,type:n.type}))),edges:copy(EDGES),prompts:RUN.prompts},
  cases:copy(CASES),outcomes:copy(CODE.outcomes),code:copy(CODE.code),
};
ARCHIVED_WORKFLOW.breakpoints=[];
ARCHIVED_WORKFLOW.nodeStates=Object.fromEntries(RUN.nodes.map(n=>[n.id,{status:'done',attempted:true}]));
ARCHIVED_WORKFLOW.artifacts=BASE_UI.artifactCards().map(c=>({id:RUN.id+'/'+c.id,nodeId:c.node,runId:RUN.id,version:RUN.version,kind:'archive',table:c.table,name:c.id==='a-cases'?'文本用例子集':c.id==='a-stories'?'产品结构 + 用户故事':c.t,count:c.id==='a-cases'?String(CASES.length):c.id==='a-code'?String(Object.keys(CODE.code).length):c.n,payload:c.table==='findings'?copy(RUN.gate):{count:c.n,description:c.s,note:c.table==='stories'?'归档记录 20 个故事，未嵌入完整故事明细。':'原型归档摘要；未记录的详细字段不补造。'}}));
function graphErrors() {
  const errors=[], ids=new Set(RUN.nodes.map(n=>n.id));
  for(const n of RUN.nodes){const kind=KINDS[n.type];if(!kind){errors.push(n.id+' 类型未知');continue;}if(kind.in!==null&&!EDGES.some(e=>e.to===n.id))errors.push(n.id+' 缺少上游连线');}
  for(const e of EDGES){const a=RUN.nodes.find(n=>n.id===e.from),b=RUN.nodes.find(n=>n.id===e.to);if(!a||!b)errors.push('存在悬空连线');else if(KINDS[a.type]?.out!==KINDS[b.type]?.in)errors.push(e.from+' → '+e.to+' 输入输出不兼容');}
  const visit=(id,path=new Set())=>{if(path.has(id)){errors.push('检测到环：'+id);return;}const next=new Set(path).add(id);EDGES.filter(e=>e.from===id&&ids.has(e.to)).forEach(e=>visit(e.to,next));};RUN.nodes.forEach(n=>visit(n.id));
  return [...new Set(errors)];
}
function scopePlan(mode,chosen, reuse=true) {
  let ids=new Set(mode==='full'?RUN.nodes.map(n=>n.id):chosen);
  if(mode==='from'){const expand=id=>EDGES.filter(e=>e.from===id).forEach(e=>{if(!ids.has(e.to)){ids.add(e.to);expand(e.to);}});[...ids].forEach(expand);}
  const errors=graphErrors(), reused=[];
  if(!ids.size)errors.push('请选择至少一个节点');
  for(const id of ids)if(!RUN.nodes.some(n=>n.id===id))errors.push('节点不存在：'+id);
  EDGES.filter(e=>ids.has(e.to)&&!ids.has(e.from)).forEach(e=>{
    const frozen=R.frozen.get(e.from), upstream=RUN.nodes.find(n=>n.id===e.from);
    if(!reuse||!frozen||frozen.revision!==R.graphVersion||frozen.type!==KINDS[upstream?.type]?.out)errors.push(e.to+' 缺少匹配当前版本的 '+e.from+' 输入');
    else reused.push(e.from+' → '+e.to+' · v'+frozen.revision);
  });
  const ordered=[], remaining=new Set(ids);
  while(remaining.size){const ready=[...remaining].find(id=>!EDGES.some(e=>e.to===id&&remaining.has(e.from)));if(!ready){errors.push('所选节点不能拓扑排序');break;}ordered.push(ready);remaining.delete(ready);}
  return {mode,nodes:ordered,reused,errors:[...new Set(errors)]};
}
function createAttempt(plan) {
  if(R.project!=='selftest')throw new Error('当前项目尚未配置工作流');
  if(plan.errors.length)throw new Error(plan.errors.join('；'));if(inputErrors().length)throw new Error(inputErrors().join('；'));
  const snapshot=graphSnapshot(), attempt={id:'preview-'+String(R.attempts.length+1).padStart(3,'0'),kind:'simulation',status:'simulated',project:R.project,workflow:RUN.graph,version:snapshot.version,mode:plan.mode,entry:({web:'Web UI',claude:'Claude Code',codex:'Codex',penguin:'PenguinHarness'})[R.mode],scope:{module:R.module,story:R.story,productNode:R.productNode},nodes:[...plan.nodes],reused:[...plan.reused],graph:snapshot,createdAt:new Date().toISOString(),calls:0};
  attempt.sourceKind=productWorkspace().input.kind;attempt.input=inputSnapshot();attempt.productReference=copy(projectProductModel());initializeBenchAttempt(attempt);R.attempts.push(attempt);return attempt;
}
function openRunScope(mode='selected',id) {
  const chosen=new Set(id?[id]:R.selected), labels={single:'只跑此节点',selected:'运行选中节点',from:'从此节点续跑',full:'运行全流程'};let reuse=true;
  sheet(mode==='full'?'执行预览':'节点调试 · '+labels[mode],b=>{
    b.append(row(pill('工作副本 v'+R.graphVersion),pill('模拟运行 · 0 模型调用')),el('p','execution-scope','当前范围：'+flowScopeLabel()),note('先确认执行范围。未选中的上游可复用同版本的已完成产物；缺失或过期输入会阻止运行。'));
    const inputs=el('div'),nodes=el('div'), preview=el('div','scope-preview'), footer=el('div','detail-footer');preview.setAttribute('aria-live','polite');
    const go=button('创建模拟运行',()=>{const plan=scopePlan(mode,chosen,reuse);if(plan.errors.length||inputErrors().length)return;R.selected=new Set(chosen);const a=createAttempt(plan);openAttempt(a);toast(a.id+' 已记录；未调用模型或目标服务');},'primary');
    const draw=()=>{const p=scopePlan(mode,chosen,reuse);p.errors.push(...inputErrors());preview.classList.toggle('scope-error',!!p.errors.length);preview.textContent=p.errors.length?p.errors.join('\n'):`执行 ${p.nodes.length} 个节点：${p.nodes.join(' → ')}\n复用：${p.reused.join('；')||'无'}\n断点：${[...S.bp].filter(id=>p.nodes.includes(id)).join('、')||'无'}\n下游范围：${mode==='single'?'不自动运行':mode==='selected'?'仅选中节点':'按依赖顺序'}`;go.disabled=!!p.errors.length;};
    const drawNodes=()=>{nodes.replaceChildren();RUN.nodes.forEach(n=>{const line=el('label','scope-node'), cb=el('input');cb.type='checkbox';cb.checked=mode==='full'||mode==='from'&&scopePlan(mode,chosen,reuse).nodes.includes(n.id)||chosen.has(n.id);cb.disabled=mode!=='selected';cb.onchange=()=>{cb.checked?chosen.add(n.id):chosen.delete(n.id);draw();};line.append(cb,el('span',null,n.id),el('small',null,n.type));nodes.append(line);});};const drawInput=(reset=false)=>{if(reset){for(const picked of chosen)if(['spec','explore'].includes(picked)&&!RUN.nodes.some(n=>n.id===picked)){chosen.delete(picked);chosen.add(S.source);}inputs.replaceChildren(renderInputForm(drawInput,()=>{R.selected=new Set(chosen);openRunScope(mode,id);}));drawNodes();}draw();};inputs.append(renderInputForm(drawInput,()=>{R.selected=new Set(chosen);openRunScope(mode,id);}));drawNodes();b.append(inputs,disclosure('执行节点与依赖',nodes));
    const reuseLabel=el('label','scope-node'), cb=el('input');cb.type='checkbox';cb.checked=true;cb.onchange=()=>{reuse=cb.checked;draw();};reuseLabel.append(cb,el('span',null,'复用相同工作流版本的上游样例输入'));b.append(reuseLabel,preview);footer.append(go,button('返回画布',()=>goTo('ws'),''));b.append(footer);draw();
  });
}
function openAttempt(a){executeBenchRun(a.id);}
startRun=function(id){openRunScope(id?'from':'full',id);};
resumeRun=function(){openRunScope('from',RUN.nodes.find(n=>S.nodeState[n.id]==='paused')?.id||RUN.nodes[0].id);};
openNode=function(id){
  if(R.benchRunId&&S.view==='ws'&&R.workView==='workflow'&&benchRun()){openBenchNode(benchRun(),id);return;}
  const n=RUN.nodes.find(n=>n.id===id);if(!n)return;const binding=ROLE_BINDINGS[n.type]||['未绑定','未绑定','需要配置'];
  if(S.editing){sheet('节点 '+id,b=>b.append(el('h3',null,NODE_NAMES[n.type]||id),row(pill(KINDS[n.type]?.in||'来源'),pill(KINDS[n.type]?.out||'未知')),note('先保存或放弃结构草稿，再配置节点参数或运行。')));return;}
  sheet('节点 '+id,b=>{
    b.append(row(pill(n.type),pill('工作副本 v'+R.graphVersion),pill(S.bp.has(id)?'断点开启':'断点关闭')),
      detailSection('输入 → 处理 → 输出',flow([[KINDS[n.type]?.in||'来源',()=>toast('查看下方输入输出契约')],[id,()=>{}],[KINDS[n.type]?.out||'未知',()=>toast('产物类型随节点定义冻结')]])),
      table(['Role','Skill','版本','职责'],[[binding[0],button(binding[1],()=>openRole(n.type)),'v'+(R.roleVersions.get(n.type)||1),binding[2]]]),
      detailSection('历史运行样例',`${fmtMs(n.ms)} · ${n.calls} calls · ${n.tokens} tokens；点击调试产生新的模拟记录。`));
    let value=JSON.stringify(PARAMS[id]||{},null,2);b.append(field('节点参数（JSON）',value,v=>{value=v;},{multiline:true}));
    const status=el('div','status'), footer=el('div','detail-footer');status.setAttribute('role','status');
    footer.append(button('保存为新版本',()=>{try{const parsed=JSON.parse(value);if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw Error('参数须为 JSON 对象');if(JSON.stringify(parsed)===JSON.stringify(PARAMS[id]||{})){status.textContent='没有参数改动。';return;}PARAMS[id]=parsed;saveGraphRevision('修改 '+id+' 参数');render();openNode(id);toast('已保存 v'+R.graphVersion+'；旧输入需重新验证');}catch(e){status.textContent=e.message;}},'primary'),button('只跑此节点',()=>openRunScope('single',id),''),button('从此节点续跑',()=>openRunScope('from',id),''),button('选择多个节点',()=>{R.selected=new Set([id]);openRunScope('selected');},''),button(S.bp.has(id)?'取消断点':'设置断点',()=>{S.bp.has(id)?S.bp.delete(id):S.bp.add(id);render();openNode(id);},''),status);b.append(footer);
    const actions=el('div','detail-footer');for(const action of [...footer.querySelectorAll('button')])if(['只跑此节点','从此节点续跑','选择多个节点'].includes(action.textContent))actions.append(action);
    const advanced=disclosure('高级配置',...b.childNodes);b.append(el('h3',null,NODE_NAMES[n.type]||id),el('p',null,binding[2]),actions,nodeDestinations(n),advanced);
  });
};
dropNode=function(id){const n=RUN.nodes.find(n=>n.id===id);if(n?.type.startsWith('gate.')){S.editIssue='质量门禁是此模板的执行约束，不能从工作副本中移除。';render();toast(S.editIssue);return;}BASE_UI.dropNode(id);};
function discardTopology(){const base=R.editBaseline;if(base){RUN.nodes.splice(0,RUN.nodes.length,...copy(base.nodes));EDGES.splice(0,EDGES.length,...copy(base.edges));for(const id of Object.keys(NODE_POS))delete NODE_POS[id];Object.assign(NODE_POS,copy(base.positions));S.nodeState=copy(base.states);}S.editing=false;S.draft=null;S.linkFrom=null;S.editIssue='';R.editBaseline=null;}
saveTopology=function(){const errors=graphErrors();if(errors.length){S.editIssue=errors.join('；');render();toast(S.editIssue);return;}const previous=VERSIONS.length;BASE_UI.saveTopology();if(VERSIONS.length!==previous){R.graphVersion=Math.max(R.graphVersion+1,VERSIONS[0].v);R.graphSnapshots.set(R.graphVersion,graphSnapshot());R.editBaseline=null;R.graphCustomized=true;render();toast('已保存实验流程 v'+R.graphVersion);}};
artifactCards=function(){
  const stats=flowSummary();return BASE_UI.artifactCards().filter(c=>RUN.nodes.some(n=>n.id===c.node)&&NODE_POS[c.node]).map(c=>{
    if(c.id==='a-stories')return {...c,n:String(stats.stories),s:'规格中的故事 · 点击结构下钻'};
    if(c.id==='a-cases')return {...c,n:String(stats.list.length),s:'当前范围 · 点击进入复核',samples:stats.list.slice(0,3).map(x=>x.t)};
    if(c.id==='a-code')return {...c,n:String(stats.codes.length),s:'当前范围 · 已嵌入历史代码'};
    if(c.id==='a-runs')return {...c,n:stats.results.length?stats.results.filter(x=>x.status==='passed').length+'/'+stats.results.length:'—',s:stats.stale.length?'当前范围 · '+stats.stale.length+' 条待重验':stats.results.length?'当前范围 · 历史执行结果':'当前范围没有执行证据'};
    return {...c,s:'归档整体 · '+c.s};
  });
};
selectCard=function(c){
  S.sel={kind:'card',id:c.id};S.ctx={kind:'card',id:c.id,label:c.t};
  if(c.table==='stories')switchWorkView('structure');
  else if(c.table==='cases')enterReview({module:R.module,story:R.story});
  else if(c.table==='code')openFlowCode();else if(c.table==='runs')openFlowResults();else openTable(c.table);
};
renderCanvas=function(){
  if(!S.editing)return renderBenchCanvas();
  if(S.editing&&!R.editBaseline)R.editBaseline={nodes:copy(RUN.nodes),edges:copy(EDGES),positions:copy(NODE_POS),states:copy(S.nodeState)};
  const canvas=BASE_UI.canvas();
  for(const control of canvas.querySelectorAll('.node,.card')){control.tabIndex=0;control.setAttribute('role','button');control.setAttribute('aria-label',control.querySelector('.node-t,.card-t')?.textContent||control.textContent.slice(0,60));control.onkeydown=event=>{if(event.target!==control)return;if(event.key==='Enter'||event.key===' '){event.preventDefault();control.click();}};}
  for(const node of canvas.querySelectorAll('.node')){const title=node.querySelector('.node-t'),id=title.textContent,n=RUN.nodes.find(n=>n.id===id);if(n){title.textContent=NODE_NAMES[n.type]||id;node.querySelector('.node-y').textContent=id+' · '+n.type;node.setAttribute('aria-label',title.textContent+' · '+id);}}
  const cards=artifactCards();[...canvas.querySelectorAll('.card')].forEach((card,i)=>{const c=cards[i];if(!c)return;card.dataset.artifact=c.id;const expand=card.querySelector('.card-a');if(expand)expand.onclick=e=>{e.stopPropagation();selectCard(c);};});
  const cancel=[...canvas.querySelectorAll('button')].find(b=>b.textContent==='放弃');if(cancel)cancel.onclick=()=>{discardTopology();render();toast('已放弃拓扑草稿，恢复编辑前定义');};
  canvas.querySelector('.runbar')?.remove();canvas.querySelector('.vers')?.remove();
  if(!S.editing)canvas.querySelector('.editbar')?.remove();
  return canvas;
};

function renderWorkflowTemplate(){
  if(R.project!=='selftest')return empty('尚无已配置流程','配置项目并导入材料后，可使用标准测试流程。',button('配置项目',()=>goTo('st','target')));
  const page=el('div','workflow-template');
  page.append(titleRow(R.graphCustomized?'实验流程':'标准测试流程','日常使用直接执行；按需配置输入、领域知识与节点参数。'),row(pill('工作副本 v'+R.graphVersion),pill(R.graphCustomized?'实验候选 · 未晋升':'内置模板')));
  const shortcuts=el('div','detail-footer');shortcuts.append(button('输入材料',openWorkflowInput,''),button('领域知识',()=>goTo('as','domain'),''),button('Role / Skill',()=>goTo('st','roles'),''),button('节点调试',()=>openRunScope('selected'),''));if(!S.editing)page.append(shortcuts);
  if(S.editing){page.append(el('p','records-note','正在定制实验流程。保存会生成新版本；离开此页将放弃未保存的结构修改。'),renderCanvas());}
  else{const advanced=disclosure('高级：实验流程定制',el('p',null,'仅用于研究或特殊流程。质量门禁保留，改动另存版本；需隔离评估后才能晋升。'),button('定制实验流程',()=>{S.editing=true;S.draft={added:[],removed:[],edges:[]};render();},''));page.append(advanced);}
  const versions=renderVersions();versions.classList.add('template-versions');page.append(disclosure('版本与差异',versions));return page;
}

function renderDomains(){
  const b=el('div');b.append(renderKnowledgeBindings(()=>{S.view='as';S.as='domain';render();}));
  b.append(table(['知识包','版本 / 状态','适用范围','管理'],R.domains.map(d=>[button(d.name,()=>openDomain(d.id)),'v'+d.version+' · '+d.state,d.scope,button('查看 / 起草修订',()=>openDomain(d.id))])));
  b.append(detailSection('从知识到证据',flow([['来源文档',()=>openDomain('perp')],['领域约束',()=>openDomain('perp')],['设计节点',()=>{S.view='ws';R.workView='workflow';render();openNode('design');}],['隔离评估',()=>{S.view='ev';render();}]])),note('领域候选先作为版本化材料审阅，再做隔离数据上的对照评估。候选内容不会自动晋升为已验证知识。'));return b;
}
function openDomain(id){const d=R.domains.find(x=>x.id===id);let text=R.domainDrafts.get(id)?.content??d.content,source=R.domainDrafts.get(id)?.source??d.source;sheet('领域知识 · '+d.name,b=>{b.append(row(pill('v'+d.version),pill(d.state,'judge')),field('规则、术语、边界与反例',text,v=>text=v,{multiline:true}),field('来源与版本依据',source,v=>source=v));const foot=el('div','detail-footer'),status=el('div','status');foot.append(button('保存候选草稿',()=>{if(!text.trim()||!source.trim()){status.textContent='规则内容和来源不能为空。';return;}R.domainDrafts.set(id,{content:text,source,version:d.version+1,state:'candidate'});status.textContent='候选 v'+(d.version+1)+' 已保存，仅在本会话中。';},'primary'),button('查看评估要求',()=>{closeSheet(false);S.view='ev';render();},''),status);b.append(detailSection('绑定与影响',d.scope+'；修订影响新生成用例，不回写既有运行。'),foot);});}
function renderRoles(){const b=el('div');b.append(table(['节点类型','Role','Skill','绑定版本','查看'],Object.entries(ROLE_BINDINGS).map(([type,r])=>[type,r[0],r[1],'v'+(R.roleVersions.get(type)||1),button('详情 / 管理',()=>openRole(type))])));b.append(note('这是建议的角色与技能映射。版本号为原型绑定版本；具体 skill 的发布内容以仓库插件为准。'));return b;}
function openRole(type){const binding=ROLE_BINDINGS[type],version=R.roleVersions.get(type)||1;let draft=R.roleDrafts.get(type)||binding[2];sheet(binding[0]+' · '+binding[1],b=>{b.append(row(pill(type),pill('v'+version)),detailSection('职责与边界',binding[2]),table(['输入','输出','模型角色'],[[KINDS[type]?.in||'来源',KINDS[type]?.out||'未知',type.startsWith('gate.')?'规则校验；按需判定':'规划模型 / 宿主原生模型']]),field('职责与提示约束修订',draft,v=>draft=v,{multiline:true}),detailSection('本角色的知识与工具边界',renderContextSummary(contextForNode(type,inputSnapshot(),{module:R.module}))),button('配置本项目知识 / Skill',()=>openKnowledgeBinding(()=>openRole(type))));const foot=el('div','detail-footer');foot.append(button('保存技能候选',()=>{if(!draft.trim()){toast('请填写职责与约束');return;}R.roleDrafts.set(type,draft);toast('候选草稿已保存；现有绑定仍为 v'+version);},'primary'),button('模拟绑定新版本',()=>{if(!R.roleDrafts.has(type)){toast('先保存候选草稿');return;}R.roleVersions.set(type,version+1);R.roleBoundInstructions.set(type,R.roleDrafts.get(type));saveGraphRevision('修改 '+type+' 技能绑定');render();openRole(type);toast('工作副本已绑定候选；既有 attempt 不变');},''));b.append(detailSection('权限与晋升',note('技能候选可改生成策略；黄金标签、评估器、留出集和发布决策由独立流程控制。PenguinHarness 承担自进化实验与评估管理。')),foot);});}
withNav=compactSectionPage;
renderAssets=function(){return withNav('物料','按运行与产品结构查看产物。','as',[
  {group:'产品材料',id:'structure',label:'产品结构',build:()=>renderProductReview(true)},
  {group:'产品材料',id:'stories',label:'用户故事',build:renderStoryMaterials},
  {group:'产品材料',id:'cases',label:'文本用例',build:()=>renderCaseList(cases())},
  {group:'产品材料',id:'trace',label:'需求追溯',build:()=>{const b=el('div');b.append(note('故事归属来自原型用例 ID；规格锚点来自归档原文。尚未逐条确认断言的验收依据。'),table(['模块','故事 / 来源','用例'],cases().map(c=>[moduleFor(storyId(c))?.name,button(storyId(c),()=>openSource(storyId(c))),button(c.t,()=>selectCase(c.id))])));return b;}},
  {group:'知识与能力',id:'domain',label:'领域知识',build:renderDomains},
  {group:'知识与能力',id:'roles',label:'Role / Skill',build:renderRoles},
  {group:'代码线',id:'code',label:'测试代码',build:sectCode},
  {group:'代码线',id:'diffs',label:'变更',build:sectDiffs},
  {group:'交付',id:'deliver',label:'交付与接入',build:()=>{const b=el('div');b.append(titleRow('审阅包','产品结构、用户故事、用例、修订记录与证据状态。'),button('导出 HTML 审阅包',exportReview,'send'),detailSection('宿主接入',hostGuide()));return b;}},
]);};
renderHistory=renderReportSurface;
function renderResearchDetail(){
  if(R.evalView==='historical'){const old=BASE_UI.evals();old.prepend(button('← 返回记分板',()=>{R.evalView='current';render();}));return old;}
  const p=el('div','page-pad');p.append(el('h2',null,'迭代 · 研究与受控自进化'),el('p','sub','研究目标：可追溯、可执行、具有领域判据的自动测试生成。UI 完整度与论文证据分别验收。'));
  const head=el('div','box');head.append(row(pill('论文证据未齐备','judge'),pill('已有工程与小样本实验'),pill('未证明质量提升')),flow([['失败归因',()=>openEvidence('失败归因','区分产品断言失败、环境失败、无效计划与预算中止。')],['候选修订',()=>{S.view='as';S.as='roles';render();}],['隔离评估',()=>openEvidence('隔离评估','冻结数据、模型配置、运行预算、评估器和对照组。')],['人工评审',()=>openEvidence('晋升评审','黄金标签与发布决策不可由生成候选的 agent 自行改写。')],['版本晋升',()=>openEvidence('晋升状态','当前没有可据此宣称已提升质量的真实晋升结果。')]]));p.append(head);
  const layout=el('div','research-layout'), left=el('div'), right=el('div');left.append(detailSection('论文问题与可证伪假设',table(['问题','对照 / 消融','主要证据'],[
    ['RQ1 用例质量','直接 LLM / 固定流水线 / 完整 harness','缺陷检出、误报、可执行率'],
    ['RQ2 领域专业性','去知识 / 去 oracle / 完整领域包','约束违反、边界覆盖、oracle 正确率'],
    ['RQ3 自进化收益','无记忆 / 无修复 / 候选版本','跨任务留出收益与回归'],
    ['RQ4 双模型效率','相同规划器与预算，替换执行器','成本、时延、成功率与置信区间'],
  ])));
  right.append(detailSection('当前证据 · 2026-09-09 台账',el('div')));const entries=[['N-16 · 领域探针','两臂各 3/3；样本很小，不能证明提升。'],['N-22 · 分类错误暴露','5/6 计划有效；missing 类识别仍有问题。'],['N-21 · 真实候选未通过','六个计划均无效；0 对 0 不能视为等效。'],['正式论文评测','独立标签、留出集、多次重复、消融与统计仍需完成。']];entries.forEach(([t,s])=>{const n=el('div','evidence-line');n.append(el('strong',null,t),el('p',null,s));right.append(n);});layout.append(left,right);p.append(layout);
  const foot=el('div','detail-footer');foot.append(link('研究方案与任务台账','testpilot-ui-research-review-2026-09-09.html#research'),button('查看原有评测样例',()=>{R.evalView='historical';render();},''),button('PenguinHarness 交接信息',openPenguinHandoff,''));p.append(foot);return p;
};
renderEvals=renderEvaluationSurface;
function openEvidence(title,text){sheet(title,b=>b.append(note(text),link('打开研究设计与证据台账','testpilot-ui-research-review-2026-09-09.html')));}
function hostGuide(){const b=el('div');b.append(table(['入口','规划模型','执行模型'],[['Web UI','默认继承 Midscene；可独立覆盖','Midscene 环境配置'],['Claude Code / Codex','宿主原生模型，无需另配规划器','Midscene 环境配置'],['PenguinHarness','宿主模型与 harness 管理','Midscene 环境配置']]));b.append(detailSection('安装与验收',link('Claude Code / Codex 接入实操','../v3/14-Claude-Code与Codex接入实操.md')),note('接入指南包含构建、安装、doctor、自检和卸载。不要将 API Key 填入原型；真实配置保存在项目设置或 env 中。'));return b;}
function renderModels(){
  const b=el('div'), modes=el('div','seg');[['web','Web UI'],['claude','Claude Code'],['codex','Codex'],['penguin','PenguinHarness']].forEach(([key,t])=>{const bt=button(t,()=>{R.mode=key;render();},'');bt.setAttribute('aria-pressed',String(R.mode===key));modes.append(bt);});b.append(modes);
  const grid=el('div','model-grid'), planner=el('div','box'), executor=el('div','box');planner.append(el('h3',null,'01 / 思考与规划'),el('small',null,'需求理解、测试设计、工作流规划、修复决策'));
  if(R.mode!=='web')planner.append(detailSection('来源',pill('宿主原生模型','machine')),note('安装 TestPilot 后使用 '+({claude:'Claude Code',codex:'Codex',penguin:'PenguinHarness'}[R.mode])+' 当前模型，无需配置第二个规划端点。'));
  else {const label=el('label','scope-node'), cb=el('input');cb.type='checkbox';cb.checked=R.plannerOverride;cb.onchange=()=>{R.plannerOverride=cb.checked;render();};label.append(cb,el('span',null,'单独设置 Web 规划模型'));planner.append(label);
    planner.append(field('模型名称',R.models.plannerName,v=>R.models.plannerName=v,{disabled:!R.plannerOverride,placeholder:R.plannerOverride?'TP_PLANNER_MODEL_NAME':'继承 MIDSCENE_MODEL_NAME'}),field('API 地址',R.models.plannerUrl,v=>R.models.plannerUrl=v,{disabled:!R.plannerOverride,placeholder:R.plannerOverride?'TP_PLANNER_BASE_URL':'继承 Midscene API 地址'}),note(R.plannerOverride?'环境变量可独立覆盖：TP_PLANNER_MODEL_NAME / TP_PLANNER_BASE_URL。':'当前默认：Web 规划层与 Midscene 使用同一模型；两个角色分别记录配置与成本。'));
  }
  executor.append(el('h3',null,'02 / Midscene 执行'),el('small',null,'低成本视觉理解、定位与页面动作'),field('模型名称',R.models.executorName,v=>R.models.executorName=v,{placeholder:'MIDSCENE_MODEL_NAME · 由 env 提供'}),field('API 地址',R.models.executorUrl,v=>R.models.executorUrl=v,{placeholder:'MIDSCENE_MODEL_BASE_URL · 由 env 提供'}),note('原型不读取 .env、不显示密钥，也不发起模型连通性请求。'));grid.append(planner,executor);b.append(grid);
  const footer=el('div','detail-footer'),status=el('div','status');status.setAttribute('role','status');footer.append(button('保存配置草稿',()=>{const urls=[R.models.executorUrl,...(R.plannerOverride?[R.models.plannerUrl]:[])];if(urls.some(v=>v&&!/^https?:\/\//.test(v))){status.textContent='API 地址需以 http:// 或 https:// 开头。';return;}if(R.mode==='web'&&R.plannerOverride&&(!R.models.plannerName.trim()||!R.models.plannerUrl.trim())){status.textContent='独立规划模型需要名称和 API 地址。';return;}R.configRevision++;status.textContent='配置草稿 v'+R.configRevision+' 已保存到本会话；真实 env 未改动。';},'primary'),status);b.append(footer);return b;
}
renderSettings=function(){
  const secs=[{group:'项目',id:'target',label:'目标',build:sectTarget},{group:'项目',id:'env',label:'环境与登录',build:sectEnv}];
  if(CFG.target==='web'&&CFG.web3)secs.push({group:'项目',id:'chain',label:'链上（dapp）',build:sectChain});
  secs.push({group:'项目',id:'danger',label:'危险操作',build:sectDanger},{group:'模型与宿主',id:'model',label:'规划与执行模型',build:renderModels},{group:'模型与宿主',id:'host',label:'Claude / Codex 接入',build:hostGuide},{group:'模型与宿主',id:'prompt',label:'提示词模板',build:sectPrompt},{group:'运行时',id:'workflow',label:'流程模板',build:renderWorkflowTemplate},{group:'运行时',id:'proc',label:'进程',build:sectProc},{group:'运行时',id:'cap',label:'能力',build:sectCap},{group:'运行时',id:'roles',label:'Role / Skill',build:renderRoles},{group:'偏好',id:'pref',label:'语言与调试',build:sectPref});
  const page=withNav('设置','配置项目、连接模型，或接入宿主。','st',secs),nav=page.querySelector('.subnav');
  const basic=new Set(['target','env','model','host','pref']),advanced=disclosure('更多设置');
  for(const sec of secs){const b=[...nav.querySelectorAll('button')].find(b=>b.textContent===sec.label);if(!basic.has(sec.id))advanced.append(b);}
  nav.querySelectorAll('.grp').forEach(n=>n.remove());advanced.open=!basic.has(S.st);nav.append(advanced);return page;
};
// Keep all existing settings forms, and make their edits survive tab switches.
function rememberForm(key,build){return function(){const b=build(), saved=R.localConfig[R.project+':'+key]||{};[...b.querySelectorAll('input:not([type="checkbox"]),textarea,select')].forEach((input,i)=>{if(saved[i]!==undefined)input.value=saved[i];input.addEventListener('input',()=>{(R.localConfig[R.project+':'+key]??={})[i]=input.value;});if(!input.id){input.id='setting-'+key+'-'+i;const label=input.parentElement.querySelector('label');if(label)label.htmlFor=input.id;else input.setAttribute('aria-label',key+' 配置 '+(i+1));}});return b;};}
sectTarget=function(){return R.project==='selftest'?rememberForm('target',BASE_UI.target)():projectTargetForm();};
sectEnv=function(){return rememberForm('env-'+CFG.login,BASE_UI.env)();};sectPrompt=rememberForm('prompt',BASE_UI.prompt);
sectPref=function(){const b=BASE_UI.pref();[...b.querySelectorAll('.seg button')].forEach((button,i)=>{const lang=SHELL_LANGS[i][0];button.setAttribute('aria-pressed',String(R.language===lang));button.onclick=()=>setUILanguage(lang);});b.append(note('界面语言与左下角同步；文档和样例保留原语言。'));const fieldBox=el('div','field'),label=el('label',null,'产出材料语言'),select=el('select');label.htmlFor='output-language';select.id='output-language';[['zh','中文'],['en','English'],['ja','日本語']].forEach(([k,t])=>select.append(new Option(t,k)));select.value=R.outputLanguage;select.onchange=()=>{R.outputLanguage=select.value;toast('后续材料语言偏好已更新；历史材料保持原语言');};fieldBox.append(label,select);b.append(fieldBox);return b;};

function exportDocument(){
  const sections=MODULES.map(m=>`<section id="${m.id}"><h2>${esc(m.name)}</h2><p>${esc(m.desc)}</p>${m.stories.map(id=>`<details open><summary>${esc(id+' '+STORY_NAMES[Number(id.slice(3))-1])}</summary><p>${esc(REFINEMENT_DATA.stories[id].text)}</p><pre>${esc(REFINEMENT_DATA.stories[id].excerpt)}</pre>${storyCases(id).length?storyCases(id).map(c=>`<article><h4>${esc(c.t)}</h4><p>${esc(c.id)} · ${esc(c.m)}</p><p>${esc(currentCase(c.id).exp)}</p><ol>${c.steps.map(s=>`<li>${esc(s)}</li>`).join('')}</ol><p>证据：${CODE.code[c.id]?'有历史样例':'尚未嵌入'}${caseReview(c.id)?.stale?' · 修订后待重验':''}</p></article>`).join(''):'<p>原型未嵌入本故事用例。</p>'}</details>`).join('')}</section>`).join('');
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TestPilot 审阅包 · 原型</title><style>body{max-width:1080px;margin:48px auto;padding:0 24px;color:#152422;font:14px/1.8 system-ui}h1{font-size:30px}nav{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}a{color:#0b5a54}nav a,article{padding:16px;border:1px solid #d2dad8;border-radius:6px}section{margin:40px 0}summary{cursor:pointer;font-weight:600}details{padding:16px 0;border-bottom:1px solid #d2dad8}pre{white-space:pre-wrap;background:#eef2f1;padding:14px}article{margin:12px 0}@media print{details{break-inside:avoid}}'+REFINEMENT_DATA.moduleMapCss+'</style><h1>TestPilot · 产品结构与测试审阅包</h1><p>原型导出；归档规格与样例子集。所有修订均为本会话模拟，不构成真实批准或论文证据。</p>'+renderModuleMap(false).outerHTML+''+sections+'<h2>领域知识与技能</h2><pre>'+esc(JSON.stringify({domains:R.domains,domainCandidates:[...R.domainDrafts],projectKnowledge:inputSnapshot().knowledge,productModel:projectProductModel(),roles:ROLE_BINDINGS,roleCandidates:[...R.roleDrafts]},null,2))+'</pre><h2>本地修订记录</h2><pre>'+esc(JSON.stringify([...R.cases],null,2))+'</pre><h2>Workflow 快照与模拟调试</h2><pre>'+esc(JSON.stringify({definition:graphSnapshot(),attempts:R.attempts},null,2))+'</pre><h2>研究状态</h2><p>论文证据未齐备。N-16 小样本无提升证明，N-21 无效计划不支持晋升；正式评估仍需独立标签、留出数据、多次重复与消融。</p></html>';
}
function exportReview(){if(R.project!=='selftest'){toast('此项目尚无可导出的材料');return;}const blob=new Blob([exportDocument()],{type:'text/html;charset=utf-8'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download='testpilot-review-session.html';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);toast('已导出模块、故事、用例、修订、领域知识与工作流快照');}

sheet=function(title,build){R.lastFocus=document.activeElement;BASE_UI.sheet(title,build);const panel=$('#sheet .panel');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','sheet-t');localizeUI($('#sheet'));$('#sheet-x').focus();};
function closeSheet(update=true){$('#sheet').hidden=true;if(!R.reviewInline)R.caseId=null;if(update&&R.reviewInline&&$('#case-detail')&&R.caseId)openCase(R.caseId,R.caseTab);if(update)syncRoute();if(R.lastFocus?.isConnected)R.lastFocus.focus();else if(update&&R.reviewInline){const heading=$('#case-detail h2');if(heading){heading.tabIndex=-1;heading.focus();}}}
$('#sheet-x').onclick=()=>closeSheet();
$('#sheet').onclick=event=>{if(event.target.id==='sheet')closeSheet();};
function disclosed(n){if(n.closest('[hidden]'))return false;for(let parent=n.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&!parent.open&&!parent.querySelector(':scope > summary')?.contains(n))return false;return true;}
document.addEventListener('keydown',event=>{if($('#sheet').hidden)return;if(event.key==='Escape'){event.preventDefault();closeSheet();}if(event.key==='Tab'){const focusable=[...$('#sheet').querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary')].filter(disclosed);const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}});
function goTo(view,section){closeSheet(false);R.caseId=null;S.view=view;if(section)S[view]=section;if(view==='ws')R.workView='workflow';R.materialsNav=view==='as'&&section!=='cases';R.batchMode=false;render();}
// The shell follows src/components/AppNav.tsx and src/pages/Review.tsx.
// The archive supplies demo content; these screens do not invoke production services.
function reviewItems(){
  const scope=R.reviewScope;
  let items=scope.story?storyCases(scope.story):scope.module?moduleCases(scope.module):cases();if(scope.productNode){const ids=new Set(productNodeStoryIds(projectProductModel(),scope.productNode));items=items.filter(c=>ids.has(storyId(c)));}
  return items.filter(c=>(!R.reviewQuery||(c.id+' '+c.t+' '+currentCase(c.id).exp).toLowerCase().includes(R.reviewQuery.toLowerCase())) && (R.reviewFilter==='all'||R.reviewFilter==='pending'&&needsReview(c)||R.reviewFilter==='findings'&&c.f.length||R.reviewFilter==='draft'&&caseReview(c.id)?.draft));
}
function refreshReviewQueue(){
  const queue=$('#case-queue');if(!queue)return;const scroll=queue.scrollTop||R.reviewScroll||0;queue.replaceChildren();R.reviewQueue=reviewItems();
  const head=el('div','queue-heading');head.append(el('span',null,'用例队列'),el('span','mono',R.reviewQueue.length+' 条'));queue.append(head);
  for(const c of R.reviewQueue){const state=caseReview(c.id),b=button('',()=>selectCase(c.id),'queue-case');b.dataset.case=c.id;b.setAttribute('aria-pressed',String(c.id===R.caseId));
    b.append(el('span','queue-id',c.id),el('strong',null,c.t));const meta=el('span','queue-meta');meta.append(el('span',null,state?.draft?'有草稿':needsReview(c)?'待复核':state?.reviewStatus==='rejected'?'已拒绝':'已确认'));
    if(c.f.length)meta.append(el('span','queue-finding',c.f.length+' 条检查意见'));if(state?.stale)meta.append(el('span','queue-finding','证据待重验'));b.append(meta);queue.append(b);
  }
  if(!R.reviewQueue.length)queue.append(el('p','queue-empty','当前范围没有匹配的用例。'));
  queue.scrollTop=scroll;
}
function inlineCase(title,build){
  const host=$('#case-detail');if(!host)return;$('#sheet').hidden=true;host.replaceChildren();
  refreshReviewQueue();const h=el('header','case-detail-heading');h.append(el('h2',null,title));
  const pager=el('div','toolbar-actions');const index=R.reviewQueue.findIndex(c=>c.id===R.caseId);
  for(const [label,offset] of [['上一条',-1],['下一条',1]]){const item=R.reviewQueue[index+offset];const b=button(label,()=>item&&selectCase(item.id),'');b.disabled=!item;pager.append(b);}h.append(pager);host.append(h);
  const body=el('div','case-detail-body');build(body);host.append(body);
}
function enterReview(scope={module:null,story:null}){R.reviewScope={...scope};R.reviewQuery='';R.reviewFilter='all';R.reviewScroll=0;goTo('as','cases');}
function renderReviewWorkspace(){
  const page=el('div','code-review');
  const tabs=el('div','review-view-tabs');const active=button('用例复核',()=>{},'active');active.setAttribute('aria-current','page');tabs.append(active,button('产品结构',()=>{R.module=R.reviewScope.module;R.story=R.reviewScope.story;switchWorkView('structure');},''));
  const actions=el('div','toolbar-actions');actions.append(button('批量处理',()=>{R.batchMode=true;sheet('批量复核',b=>b.append(renderCaseList(reviewItems())));},''),button('导出审阅文档',exportReview,''));tabs.append(actions);page.append(tabs);const graphFilter=disclosure('按产品结构筛选',productHierarchy(projectProductModel(),id=>{const chain=productNodePath(projectProductModel(),id);R.reviewScope={module:chain[0]?.id||null,story:null,productNode:id};R.productNode=id;R.caseId=null;R.reviewGraphOpen=true;render();},R.reviewScope.productNode||R.reviewScope.module));graphFilter.className='product-graph-filter';graphFilter.open=!!R.reviewGraphOpen;graphFilter.ontoggle=()=>R.reviewGraphOpen=graphFilter.open;graphFilter.append(button('清除结构筛选',()=>{R.reviewScope={module:null,story:null};R.productNode=null;R.caseId=null;render();}));page.append(graphFilter);
  const filters=el('div','queue-filters');const modules=el('select');modules.setAttribute('aria-label','产品模块');modules.append(new Option('全部模块',''));MODULES.forEach(m=>modules.append(new Option(m.name,m.id)));modules.value=R.reviewScope.module||'';
  const stories=el('select');stories.setAttribute('aria-label','用户故事');stories.append(new Option('全部故事',''));(R.reviewScope.module?productNodeStoryIds(projectProductModel(),R.reviewScope.module):Object.keys(REFINEMENT_DATA.stories)).forEach(id=>stories.append(new Option(id+' '+STORY_NAMES[Number(id.slice(3))-1],id)));stories.value=R.reviewScope.story||'';
  modules.onchange=()=>{R.reviewScope={module:modules.value||null,story:null};R.module=R.reviewScope.module;R.story=null;R.caseId=null;render();};stories.onchange=()=>{R.reviewScope={module:moduleFor(stories.value)?.id||R.reviewScope.module,story:stories.value||null};R.module=R.reviewScope.module;R.story=R.reviewScope.story;R.caseId=null;render();};
  const search=el('input');search.type='search';search.placeholder='搜索用例';search.setAttribute('aria-label','搜索用例队列');search.value=R.reviewQuery;
  const filter=el('select');filter.setAttribute('aria-label','队列状态');[['all','全部状态'],['pending','待复核'],['findings','有检查意见'],['draft','有修订草稿']].forEach(([value,label])=>filter.append(new Option(label,value)));filter.value=R.reviewFilter;
  const redraw=()=>{refreshReviewQueue();if(!R.reviewQueue.some(c=>c.id===R.caseId)){if(R.reviewQueue[0])openCase(R.reviewQueue[0].id,'detail');else{$('#case-detail').replaceChildren(empty('当前筛选没有用例','调整模块、故事或搜索条件。'));R.caseId=null;syncRoute();}}};
  search.oninput=()=>{R.reviewQuery=search.value;redraw();};filter.onchange=()=>{R.reviewFilter=filter.value;redraw();};filters.append(modules,stories,search,filter);page.append(filters);
  const split=el('div','review-split'),queue=el('aside','case-queue'),detail=el('main','case-detail');queue.id='case-queue';queue.setAttribute('aria-label','用例复核队列');detail.id='case-detail';detail.setAttribute('aria-label','当前用例详情');split.append(queue,detail);page.append(split);return page;
}
function renderMainNav(){
  const nav=$('#nav');nav.replaceChildren();
  const groups=[
    ['工作流', [['工作台',()=>goTo('ws'),S.view==='ws'&&R.workView==='workflow'||S.view==='hi'&&['workflow','workflow-detail'].includes(S.hi)]]],
    ['产物审阅', [['复核',()=>enterReview(),S.view==='as'&&S.as==='cases'||S.view==='ws'&&R.workView==='structure'],['物料',()=>goTo('as','stories'),S.view==='as'&&S.as!=='cases'],['运行报告',()=>goTo('hi','runs'),S.view==='hi'&&!isBaselineView()&&!['workflow','workflow-detail'].includes(S.hi)],['基线',()=>goTo('hi','base'),S.view==='hi'&&isBaselineView()]]],
    ['评测', [['记分板',()=>{R.evalView='current';goTo('ev');},S.view==='ev'&&R.evalView!=='gold'],['gold',()=>{R.evalView='gold';goTo('ev');},S.view==='ev'&&R.evalView==='gold']]],
    ['项目', [['设置',()=>goTo('st'),S.view==='st']]],
  ];
  const icons=['home','review','files','report','baseline','score','gold','settings'];let index=0;
  for(const [title,items] of groups){const group=el('div','nav-group');group.setAttribute('role','group');group.setAttribute('aria-label',title);group.append(el('div','nav-group-title',title));for(const [label,action,selected] of items){const b=button('',action,'nav-item');b.append(shellIcon(icons[index++]),el('span','nav-label',label));b.title=label;b.setAttribute('aria-label',label);b.setAttribute('aria-current',String(!!selected));group.append(b);}nav.append(group);}
  renderSidebarChrome();
  const context=$('#page-context');if(context)context.textContent=S.view==='ws'?(R.workView==='structure'?'复核 / 产品结构':'工作台'):S.view==='as'?(S.as==='cases'?'复核':'物料'):S.view==='hi'?(['workflow','workflow-detail'].includes(S.hi)?'工作流执行记录'+(R.runId?' / '+R.runId:''):'产物审阅 / '+(isBaselineView()?'基线':'运行报告')):S.view==='ev'?(R.evalView==='gold'?'Gold 基准':'记分板'):'项目设置';
}
render=function(skipRoute=false){
  const leavingDraft=S.editing&&!(S.view==='st'&&S.st==='workflow'&&R.project==='selftest');if(leavingDraft)discardTopology();
  R.reviewInline=S.view==='as'&&S.as==='cases'&&!R.materialsNav;
  BASE_UI.render();
  if(R.reviewInline&&R.project==='selftest'){
    $('#view').replaceChildren(renderReviewWorkspace());refreshReviewQueue();
    if(!R.caseId&&R.reviewQueue.length)R.caseId=R.reviewQueue[0].id;
    if(R.caseId)openCase(R.caseId,R.caseTab);else $('#case-detail').append(empty('当前范围没有用例','可以切换故事，或返回产品结构查看材料缺口。'));
  }
  if(R.project!=='selftest'&&(S.view==='as'||S.view==='hi'&&!['workflow','workflow-detail'].includes(S.hi)))$('#view').replaceChildren(renderProjectEmpty());
  renderMainNav();localizeUI(document);if(!skipRoute)syncRoute();if(leavingDraft)toast('已放弃未保存的流程草稿');
};
$('#nav').onclick=null;
const shellNav=el('aside','app-sidebar');$('.app').prepend(shellNav);$('.top').replaceChildren(el('div'),el('div','top-right'));$('.top').firstElementChild.id='page-context';initSidebar();
const banner=el('div','prototype-line');banner.append(el('strong',null,'交互原型'),el('span',null,'历史样例 · 所有操作仅本地演示'));
$('.app').insertBefore(banner,$('#view'));
$('.top-right').replaceChildren(button('AI 助手',openAssistant,'hint'));document.documentElement.dataset.theme=R.theme;
document.addEventListener('click',event=>{for(const more of document.querySelectorAll('.nav-more,.workflow-more'))if(!more.contains(event.target))more.open=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){const more=$('.nav-more');if(more?.open){more.open=false;more.querySelector('summary').focus();}}});
CFG.lang=R.language;
S.traceOpen=false;S.pan={x:32,y:8};S.bp.clear();
S.msgs=[];say('bot','选择一个模块或用例，我会带着它的上下文帮助你审阅。');
const restore=()=>{readRoute();render(true);if(R.caseId)openCase(R.caseId,R.caseTab);else $('#sheet').hidden=true;};
window.addEventListener('popstate',restore);window.addEventListener('hashchange',restore);
if(location.hash)restore();else{S.view='ws';R.workView='workflow';render();}
// Explicit inspection surface for DOM tests and handoff; no network or backend API.
window.TestPilotPrototype={state:R,ui:S,modules:MODULES,cases,scopePlan,createAttempt,graphErrors,graphSnapshot,exportDocument,currentCase,readRoute,restore,flowSummary,reviewItems,workflowRecords,archivedWorkflow:ARCHIVED_WORKFLOW,benchRun,selectBenchRun,prepareBenchRun,executeBenchRun,canSetBenchBreakpoint,toggleBenchBreakpoint,productWorkspace,inputErrors,contextForNode,readLocalText,buildReferenceProductModel,projectProductModel,productNodeStoryIds,productMergePlan,productModelDocument,openProductBundle,openProductMerge,openBenchArtifact};
