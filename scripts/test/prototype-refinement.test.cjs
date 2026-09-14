const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require(process.env.TP_DOM_MODULE || 'jsdom');
const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'docs/reports/testpilot-review-prototype.html'), 'utf8');

// DOM emulation only: no browser, network, target process or model calls.
function setup(t, hash = '#view=ws&work=workflow', storage = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.detail?.stack || e.stack));
  const dom = new JSDOM(html, {
    url: 'https://prototype.test/docs/reports/testpilot-review-prototype.html' + hash,
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      for (const [key, value] of Object.entries(storage)) w.localStorage.setItem(key, value);
      w.alert = () => {}; w.confirm = () => false;
      w.URL.createObjectURL = () => 'blob:prototype-test';
      w.URL.revokeObjectURL = () => {};
    },
  });
  t.after(() => { dom.window.close(); assert.deepEqual(errors, [], 'uncaught DOM errors'); });
  const w = dom.window, d = w.document, p = w.TestPilotPrototype;
  assert.ok(p, 'refinement initialized');
  function click(text, scope = d) {
    const b = [...scope.querySelectorAll('button,summary')].find(n => n.textContent.trim() === text || n.getAttribute('aria-label') === text);
    assert.ok(b, 'control exists: ' + text);
    // Follow the disclosure path before using its action, like a user opening More.
    const parents=[];for(let n=b.parentElement;n;n=n.parentElement)if(n.tagName==='DETAILS'&&!n.open&&n.firstElementChild!==b)parents.unshift(n);
    parents.forEach(n=>n.querySelector(':scope > summary').click());
    assert.equal(!!b.closest('[hidden]'),false,text+' is not hidden');
    assert.notEqual(b.disabled,true,text+' enabled');b.click();return b;
  }
  const input = (label, value) => {
    const l = [...d.querySelectorAll('label')].find(n => n.textContent === label);
    assert.ok(l, 'label exists: ' + label);const field=d.getElementById(l.htmlFor);assert.ok(field);
    field.value=value;field.dispatchEvent(new w.Event('input',{bubbles:true}));return field;
  };
  return { w, d, p, click, input, sheet: () => d.getElementById('sheet') };
}

test('sidebar collapses to named icons without losing run context and supports icon navigation', t => {
  const {d,w,p,click}=setup(t,'#view=hi&project=selftest&section=workflow&run=wf-mt0xaw2g&runTab=nodes');
  const hash=w.location.hash;
  click('收起侧栏');assert.equal(d.querySelector('.app').classList.contains('sidebar-collapsed'),true);
  assert.equal(d.getElementById('sidebar-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(w.location.hash,hash);assert.equal(p.state.runId,'wf-mt0xaw2g');
  for(const b of d.querySelectorAll('#nav .nav-item')){assert.ok(b.querySelector('svg'));assert.ok(b.getAttribute('aria-label'));assert.ok(b.title);}
  assert.equal(d.querySelectorAll('#nav .nav-item').length,8);
  assert.equal(w.getComputedStyle(d.querySelector('.nav-label')).display,'none');
  click('工作台',d.getElementById('nav'));assert.ok(d.querySelector('.canvas-wrap'));assert.equal(p.state.sidebarCollapsed,true);
  click('展开侧栏');assert.equal(d.querySelector('.app').classList.contains('sidebar-collapsed'),false);
  assert.equal(JSON.parse(w.localStorage.getItem('testpilot.prototype.ui.v1')).collapsed,false);
});

test('bottom controls translate navigation and forms while preserving source cases and output language', t => {
  const {d,w,p,click,sheet}=setup(t);const cases=JSON.stringify(p.cases());
  click('EN',d.querySelector('.sidebar-language'));assert.equal(d.documentElement.lang,'en');
  click('Dark theme');assert.equal(d.documentElement.dataset.theme,'dark');
  click('Select a run');click('Workbench',d.getElementById('nav'));
  assert.equal(p.state.outputLanguage,'zh');assert.equal(JSON.stringify(p.cases()),cases);
  const select=d.getElementById('proj');select.value='__new_project__';select.dispatchEvent(new w.Event('change'));
  assert.match(sheet().textContent,/Add project/);assert.match(sheet().textContent,/Project name/);assert.match(sheet().textContent,/Create project/);
  click('Cancel',sheet());click('Collapse sidebar');click('Change language');
  click('日本語',d.querySelector('.shell-popover'));assert.equal(d.documentElement.lang,'ja');
  click('設定',d.getElementById('nav'));assert.equal(d.documentElement.dataset.theme,'dark');
  click('言語を切り替え');click('中文',d.querySelector('.shell-popover'));assert.equal(d.documentElement.lang,'zh-CN');
  assert.equal(d.querySelector('#nav [aria-current="true"]').textContent,'设置');assert.equal(p.state.outputLanguage,'zh');
});

test('project dropdown can open and cancel creation without changing the selected project', t => {
  const {d,w,p,click,sheet,input}=setup(t);
  const select=d.getElementById('proj');assert.equal(select.lastElementChild.tagName,'OPTGROUP');
  assert.equal(select.options[select.options.length-1].value,'__new_project__');
  select.value='__new_project__';select.dispatchEvent(new w.Event('change'));
  assert.equal(p.state.project,'selftest');assert.equal(select.value,'selftest');assert.equal(sheet().hidden,false);
  input('项目名称','草稿项目');click('取消',sheet());assert.equal(sheet().hidden,true);
  assert.equal(p.state.projects.length,2);assert.equal(w.localStorage.getItem('testpilot.prototype.projects.v1'),null);
});

test('project creation validates input, selects an isolated workspace and supports editing its settings', t => {
  const {d,w,p,click,input,sheet}=setup(t);w.openNewProject();
  click('创建项目',sheet());assert.match(sheet().textContent,/请填写项目名称/);
  input('项目名称','TestPilot 自举');click('创建项目',sheet());assert.match(sheet().textContent,/项目名称已存在/);
  input('项目名称','客户平台');input('入口地址','javascript:alert(1)');click('创建项目',sheet());
  assert.match(sheet().textContent,/请填写有效的 HTTP 或 HTTPS/);assert.equal(p.state.projects.length,2);
  input('入口地址','https://portal.example');input('规格材料（可选）','spec/产品说明.md\n\n用例要求.md');
  d.getElementById('project-platform').value='android';click('创建项目',sheet());
  assert.equal(sheet().hidden,true);assert.equal(p.state.projects.length,3);
  const id=p.state.project,project=p.state.projects.find(x=>x.id===id);
  assert.match(id,/^project-/);assert.match(w.location.hash,new RegExp('project='+id));
  assert.equal(project.name,'客户平台');assert.equal(project.url,'https://portal.example/');assert.equal(project.platform,'android');assert.equal(project.materials.length,2);
  assert.equal(p.cases().length,0);assert.equal(d.querySelector('.canvas-wrap'),null);
  assert.match(d.getElementById('view').textContent,/尚未导入材料/);assert.match(d.getElementById('view').textContent,/spec\/产品说明.md/);
  click('选择运行记录');assert.equal(d.querySelectorAll('.record-list tbody tr').length,0);assert.doesNotMatch(d.getElementById('view').textContent,/wf-mt0xaw2g/);
  click('设置',d.getElementById('nav'));click('目标',d.querySelector('.subnav'));
  assert.equal(d.querySelector('.project-form input').value,'客户平台');assert.equal(d.getElementById('project-platform').value,'android');
  input('项目名称','客户平台二期');click('保存项目设置');assert.equal(p.state.projects.find(x=>x.id===id).name,'客户平台二期');
  assert.equal(JSON.parse(w.localStorage.getItem('testpilot.prototype.projects.v1'))[0].name,'客户平台二期');
});

test('new projects and shell preferences survive reload, with project names treated as text', t => {
  const first=setup(t);first.w.openNewProject();first.input('项目名称','<img src=x onerror=alert(1)>');first.input('入口地址','https://portal.example');first.click('创建项目',first.sheet());
  first.click('EN',first.d.querySelector('.sidebar-language'));first.click('Dark theme');first.click('Collapse sidebar');
  const storage={};for(const key of ['testpilot.prototype.projects.v1','testpilot.prototype.ui.v1'])storage[key]=first.w.localStorage.getItem(key);
  const next=setup(t,first.w.location.hash,storage);
  assert.equal(next.p.state.project,first.p.state.project);assert.equal(next.p.state.sidebarCollapsed,true);
  assert.equal(next.d.documentElement.lang,'en');assert.equal(next.d.documentElement.dataset.theme,'dark');
  assert.equal(next.d.querySelector('.project-empty h1').textContent,'<img src=x onerror=alert(1)>');assert.equal(next.d.querySelector('.project-empty img'),null);
  assert.equal(next.p.cases().length,0);assert.equal(next.p.state.attempts.length,0);
});

test('collapsed project menu supports keyboard navigation, switching and new-project entry', t => {
  const {d,w,p,click,sheet}=setup(t);click('收起侧栏');d.getElementById('project-picker').click();
  let pop=d.querySelector('.shell-popover');assert.equal(pop.getAttribute('role'),'menu');assert.equal(d.activeElement.dataset.value,'selftest');
  pop.dispatchEvent(new w.KeyboardEvent('keydown',{key:'End',bubbles:true}));assert.equal(d.activeElement.textContent,'添加新项目');
  pop.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(d.querySelector('.shell-popover'),null);assert.equal(d.activeElement.id,'project-picker');
  d.getElementById('project-picker').click();pop=d.querySelector('.shell-popover');pop.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  assert.equal(d.activeElement.dataset.value,'acme');d.activeElement.click();assert.equal(p.state.project,'acme');assert.equal(p.cases().length,0);
  d.getElementById('project-picker').click();click('添加新项目',d.querySelector('.shell-popover'));assert.equal(sheet().hidden,false);click('取消',sheet());
  d.getElementById('project-picker').click();click('TestPilot 自举',d.querySelector('.shell-popover'));assert.equal(p.cases().length,40);assert.ok(d.querySelector('.canvas-wrap'));
});

test('project creation remains usable in-session when local storage is unavailable', t => {
  const {w,p,click,input,sheet,d}=setup(t);
  w.Storage.prototype.setItem=()=>{throw new w.DOMException('Unavailable','SecurityError');};
  w.openNewProject();input('项目名称','会话项目');input('入口地址','https://session.example');click('创建项目',sheet());
  assert.equal(p.state.projects.length,3);assert.equal(sheet().hidden,true);assert.match(d.querySelector('.toast').textContent,/仅保留本次会话/);
  click('收起侧栏');assert.equal(p.state.sidebarCollapsed,true);
});

test('Flow has one task toolbar without topology controls and full execution keeps the visible scope', t => {
  const {d,p,click,sheet}=setup(t,'#view=ws&project=selftest&work=workflow&module=project&story=US-01');
  const toolbar=d.querySelector('.workflow-toolbar');assert.equal(d.querySelectorAll('.work-toolbar').length,1);assert.equal(toolbar.querySelector('.workspace-views'),null);assert.equal(toolbar.firstElementChild.id,'bench-run-selector');assert.ok(![...d.querySelectorAll('#nav .nav-item')].some(n=>n.textContent==='工作流执行记录'));
  for(const selector of ['.runbar','.editbar','.vers','.node.editable'])assert.equal(d.querySelector(selector),null);
  assert.doesNotMatch(toolbar.textContent,/编辑流程|工作副本|selftest-g1|断点/);assert.match(toolbar.textContent,/US-01/);
  assert.equal(toolbar.querySelector('.workflow-more').open,false);assert.equal(d.getElementById('page-context').textContent,'工作台');
  assert.ok(d.querySelector('.flow-activity'));assert.equal(p.state.attempts.length,0);
  click('开始执行');assert.match(sheet().textContent,/执行预览/);assert.match(sheet().textContent,/当前范围：US-01/);
  assert.match(sheet().textContent,/执行 7 个节点/);click('创建模拟运行',sheet());
  assert.equal(p.state.attempts[0].scope.story,'US-01');assert.equal(p.state.attempts[0].mode,'full');assert.equal(p.state.attempts[0].calls,0);
});

test('consolidated input selection versions the next run and leaves archived facts unchanged', t => {
  const {d,p,click,sheet}=setup(t),before=JSON.stringify(p.archivedWorkflow);
  click('输入材料',d.querySelector('.workflow-toolbar'));click('Explore · 探索产品',sheet());
  assert.equal(p.graphSnapshot().nodes[0].type,'source.explore');assert.equal(p.state.graphVersion,4);assert.equal(p.graphErrors().length,0);
  assert.ok(p.scopePlan('single',new Set(['stories']),true).errors.length);assert.equal(JSON.stringify(p.archivedWorkflow),before);
  click('Spec · 规格材料',sheet());assert.equal(p.graphSnapshot().nodes[0].id,'spec');assert.equal(p.state.graphVersion,5);assert.equal(p.graphErrors().length,0);
  click('Spec · 规格材料',sheet());assert.equal(p.state.graphVersion,5);d.getElementById('sheet-x').click();
  click('EN',d.querySelector('.sidebar-language'));assert.ok(d.querySelector('[aria-label="Inputs"]'));
  click('Start run');assert.match(sheet().textContent,/Run preview/);
});

test('advanced flow customization preserves gates and freezes experiments without exposing edit controls on the home', t => {
  const {d,w,p,click,sheet}=setup(t);const attempt=p.createAttempt(p.scopePlan('full',new Set(),true)),frozen=JSON.stringify(attempt.graph);
  click('流程设置');assert.equal(p.ui.view,'st');assert.equal(p.ui.st,'workflow');assert.equal(d.querySelector('.workflow-template details').open,false);
  click('定制实验流程');assert.ok(d.querySelector('.node.editable'));assert.equal(d.querySelector('.workflow-template > .detail-footer'),null);
  w.openNode('design');assert.match(sheet().textContent,/先保存或放弃结构草稿/);assert.equal(sheet().querySelector('textarea'),null);d.getElementById('sheet-x').click();
  w.dropNode('gate');assert.ok(p.graphSnapshot().nodes.find(n=>n.id==='gate'));
  w.dropNode('repair');assert.equal(p.graphErrors().length,0);click('保存为新版本',d.querySelector('.editbar'));
  assert.equal(p.ui.editing,false);assert.equal(p.state.graphCustomized,true);assert.equal(p.state.graphVersion,4);assert.equal(JSON.stringify(attempt.graph),frozen);
  click('工作台',d.getElementById('nav'));assert.ok(d.querySelector('.workflow-variant'));assert.equal(d.querySelector('.editbar'),null);assert.equal(d.querySelector('.node.editable'),null);
});

test('leaving the advanced draft restores the saved graph and the More menu keeps multi-node debugging reachable', t => {
  const {d,w,p,click,sheet}=setup(t),before=JSON.stringify(p.graphSnapshot());
  click('流程设置');click('定制实验流程');w.dropNode('repair');click('工作台',d.getElementById('nav'));
  assert.equal(JSON.stringify(p.graphSnapshot()),before);assert.equal(p.ui.editing,false);assert.equal(d.querySelector('.node.editable'),null);
  click('调试节点');assert.match(sheet().textContent,/请选择至少一个节点/);
  const boxes=[...sheet().querySelectorAll('.scope-node')];for(const id of ['design','gate'])boxes.find(n=>n.querySelector('span')?.textContent===id).querySelector('input').click();
  assert.match(sheet().textContent,/执行 2 个节点：design → gate/);click('创建模拟运行',sheet());assert.deepEqual(Array.from(p.state.attempts[0].nodes),['design','gate']);
});

test('product mindmap keeps all modules visible and filters the list below through module and story drilldown', t => {
  const {d,p,click}=setup(t,'#view=ws&project=selftest&work=structure');
  const map=()=>d.querySelector('.product-module-map'),list=()=>d.getElementById('module-content');
  assert.equal(map().querySelectorAll('.module-map-node').length,6);assert.equal(map().querySelectorAll('svg path').length,6);
  assert.equal(map().nextElementSibling,list());
  assert.equal(list().querySelector('table').querySelectorAll('tbody tr').length,22);
  click('项目与环境',map());assert.equal(p.state.module,'project');assert.equal(list().querySelectorAll('tbody tr').length,3);
  assert.match(list().textContent,/US-01/);assert.match(list().textContent,/US-22/);assert.doesNotMatch(list().textContent,/US-04/);
  assert.equal(map().querySelector('[data-module="project"]').getAttribute('aria-pressed'),'true');assert.equal(map().querySelector('path.selected').dataset.connection,'project');
  click('US-01 · 项目与目标端',list());assert.equal(p.state.story,'US-01');assert.equal(map().querySelectorAll('.module-map-node').length,6);assert.match(list().textContent,/测试用例 · 2 条/);
  click('Harness 与自进化',map());assert.equal(p.state.story,null);assert.equal(p.state.caseId,null);assert.equal(p.state.module,'harness');assert.equal(list().querySelectorAll('tbody tr').length,6);assert.doesNotMatch(list().textContent,/US-01/);
  map().querySelector('.module-map-root').click();assert.equal(p.state.module,null);assert.equal(list().querySelector('table').querySelectorAll('tbody tr').length,22);
});

test('module mindmap keyboard focus, selected branch and URL scope remain consistent', t => {
  const {d,w,p,click}=setup(t,'#view=ws&project=selftest&work=structure&module=workflow&story=US-14');
  const map=d.querySelector('.module-map-canvas'),root=map.querySelector('.module-map-root');
  assert.equal(map.querySelector('[data-module="workflow"]').getAttribute('aria-pressed'),'true');
  root.focus();root.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));assert.equal(d.activeElement.dataset.module,'project');
  d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));assert.equal(d.activeElement.dataset.module,'requirements');
  assert.equal(p.state.module,'workflow');d.activeElement.click();assert.equal(p.state.module,'requirements');assert.equal(d.activeElement.dataset.module,'requirements');assert.equal(p.state.story,null);
  assert.match(w.location.hash,/module=requirements/);assert.doesNotMatch(w.location.hash,/story=/);
  const restored=setup(t,w.location.hash);assert.equal(restored.d.querySelector('.module-map-node[aria-pressed="true"]').dataset.module,'requirements');assert.equal(restored.d.getElementById('module-content').querySelectorAll('tbody tr').length,5);
  click('EN',d.querySelector('.sidebar-language'));assert.match(d.querySelector('.module-map-node[data-module="requirements"]').textContent,/5 linked stories/);
});

test('module list can review all module cases, exposes source gaps and never leaks its graph to an empty project', t => {
  const {d,w,p,click}=setup(t,'#view=ws&project=selftest&work=structure&module=project');
  click('复核模块用例',d.getElementById('module-content'));assert.equal(p.state.reviewScope.module,'project');assert.equal(p.state.reviewScope.story,null);assert.equal(p.reviewItems().length,4);
  click('产品结构');assert.equal(d.querySelector('.module-map-node[aria-pressed="true"]').dataset.module,'project');
  click('US-22 · 语言与模板',d.getElementById('module-content'));assert.equal(p.state.story,'US-22');assert.match(d.getElementById('module-content').textContent,/测试用例 · 0 条/);
  w.selectProject('acme');click('物料',d.getElementById('nav')); assert.equal(d.querySelector('.product-module-map'),null);assert.equal(d.querySelectorAll('.module-map-node').length,0);assert.match(d.getElementById('view').textContent,/尚未导入材料/);
});

test('exported review includes a standalone linked module graph and all story and case sections', t => {
  const {p}=setup(t,'#view=ws&project=selftest&work=structure&module=workflow');
  const doc=new JSDOM(p.exportDocument());t.after(()=>doc.window.close());const d=doc.window.document,map=d.querySelector('nav.product-module-map');
  assert.ok(map);assert.equal(map.querySelectorAll('svg path').length,6);assert.equal(map.querySelectorAll('a.module-map-node').length,6);
  for(const a of map.querySelectorAll('a')){const target=d.querySelector(a.getAttribute('href'));assert.ok(target);assert.ok(target.querySelector('details'));}
  assert.equal(d.querySelectorAll('details').length,22);assert.equal(d.querySelectorAll('article').length,40);
  assert.equal(d.querySelectorAll('script,script[src],link[rel="stylesheet"],svg foreignObject').length,0);assert.match(d.querySelector('style').textContent,/module-map-lines/);
});

test('full workbench navigation, editable graph, assets and historical views remain reachable', t => {
  const { d, p, click } = setup(t);
  assert.equal(d.querySelectorAll('#nav .nav-item').length, 8);
  assert.equal(p.state.workView,'workflow');assert.ok(d.querySelector('.canvas-wrap'));
  click('物料',d.getElementById('nav'));click('产品结构',d.querySelector('.subnav'));
  assert.equal(d.querySelectorAll('.module-tile').length, 6);
  d.querySelector('.module-map-root').click();assert.ok(d.getElementById('ta'));assert.ok(p.cases().length > 20);
  click('工作台');click('设置',d.getElementById('nav'));click('流程模板',d.querySelector('.subnav'));click('定制实验流程');assert.ok(d.querySelector('.canvas-wrap'));assert.ok(d.querySelectorAll('.node').length >= 7);
  assert.ok(d.querySelectorAll('.card').length >= 4);
  click('物料');for(const name of ['用户故事','文本用例','需求追溯','领域知识','Role / Skill','测试代码','变更','交付与接入'])click(name,d.querySelector('.subnav'));
  click('运行报告');assert.match(d.getElementById('view').textContent,/执行记录/);
  click('记分板');assert.match(d.getElementById('view').textContent,/未证明质量提升/);
  click('查看原有评测样例');assert.match(d.getElementById('view').textContent,/黄金清单/);click('gold');assert.equal(d.querySelectorAll('.review-table tbody tr').length,16);assert.match(d.getElementById('view').textContent,/不写研究标签/);
  click('设置');for(const name of ['目标','环境与登录','链上（dapp）','危险操作','规划与执行模型','Claude / Codex 接入','提示词模板','进程','能力','Role / Skill','语言与调试'])click(name,d.querySelector('.subnav'));
});

test('module → story → case → source drilldown and returning preserve object scope', t => {
  const { d, p, w, click, sheet } = setup(t);
  click('物料',d.getElementById('nav'));click('产品结构',d.querySelector('.subnav'));
  d.querySelector('.module-tile[data-module="project"]').click();
  click('US-01 · 项目与目标端');assert.equal(p.state.story,'US-01');
  const c = p.cases().find(x=>x.id.startsWith('US-01-'));
  click(c.t,d.querySelector('.structure-content'));assert.equal(p.state.caseId,c.id);assert.equal(sheet().hidden,true);assert.ok(d.querySelector('#case-detail'));
  click('规格原文',d.querySelector('#case-detail'));assert.match(sheet().textContent,/02-业务规格与用户故事.md/);
  click('返回故事',sheet());assert.equal(sheet().hidden,true);assert.equal(p.state.story,'US-01');
  assert.match(w.location.hash,/story=US-01/);
  click('TestPilot 自举',d.querySelector('.review-header'));
  assert.equal(p.state.module,null);assert.equal(d.querySelectorAll('.module-tile').length,6);
});

test('case draft, confirmation and evidence invalidation affect only the selected case', t => {
  const { p, w, d, click, input, sheet } = setup(t);
  const c=p.cases()[0], other=p.cases()[1], before=c.exp;
  w.selectCase(c.id);click('修订与对比',sheet());
  input('修订后的预期结果','页面展示目标端 Web，并保留配置项');input('修订依据 / 原因','依据 US-01 的目标端与保存要求');
  click('保存草稿',sheet());assert.equal(p.currentCase(c.id).exp,before);
  click('模拟确认修订',sheet());assert.match(p.currentCase(c.id).exp,/保留配置项/);
  assert.equal(p.currentCase(other.id).exp,other.exp);assert.equal(c.exp,before);
  click('代码与证据',sheet());assert.match(sheet().textContent,/历史代码与结果已过期/);
  assert.match(p.exportDocument(),/本地修订记录/);assert.match(p.exportDocument(),/保留配置项/);
  assert.ok(d.querySelector('.prototype-line').textContent.includes('本地演示'));
});

test('single node is distinct from downstream continuation; missing inputs block selected scope', t => {
  const { p, w, click, sheet } = setup(t);
  w.openNode('design');click('只跑此节点',sheet());
  assert.match(sheet().textContent,/执行 1 个节点：design/);click('创建模拟运行',sheet());
  assert.deepEqual(Array.from(p.state.attempts[0].nodes),['design']);assert.equal(p.state.attempts[0].calls,0);
  p.prepareBenchRun();w.openNode('design');click('从此节点续跑',sheet());
  assert.match(sheet().textContent,/design → gate → codegen → codegate → repair/);
  const blocked=p.scopePlan('selected',new Set(['design','codegen']),false);assert.ok(blocked.errors.length);
  const ready=p.scopePlan('selected',new Set(['design','gate']),true);assert.deepEqual(Array.from(ready.nodes),['design','gate']);assert.equal(ready.errors.length,0);
  const a=p.createAttempt(ready);assert.deepEqual(Array.from(a.nodes),['design','gate']);
});

test('editing a node creates a new snapshot, leaves earlier attempts frozen and invalidates inputs', t => {
  const { p, w, click, input, sheet } = setup(t);
  const a=p.createAttempt(p.scopePlan('single',new Set(['design']),true));
  const before=JSON.stringify(a.graph);w.openNode('design');click('高级配置',sheet());input('节点参数（JSON）','{"maxCases":2,"lang":"zh"}');click('保存为新版本',sheet());
  assert.equal(p.state.graphVersion,4);assert.equal(JSON.stringify(a.graph),before);
  assert.ok(p.scopePlan('single',new Set(['design']),true).errors.some(e=>e.includes('当前版本')));
  click('只跑此节点',sheet());assert.equal([...sheet().querySelectorAll('button')].find(b=>b.textContent==='创建模拟运行').disabled,true);
});

test('host planners require no endpoint; Web planner can inherit or independently configure', t => {
  const { p, d, click, input } = setup(t);
  click('设置');click('规划与执行模型',d.querySelector('.subnav'));
  assert.match(d.getElementById('view').textContent,/Web 规划层与 Midscene 使用同一模型/);
  click('Codex',d.getElementById('view'));assert.match(d.getElementById('view').textContent,/无需配置第二个规划端点/);
  assert.equal(d.querySelectorAll('.model-grid input').length,2);
  click('Web UI',d.getElementById('view'));const toggle=d.querySelector('.model-grid input[type="checkbox"]');toggle.click();
  const inputs=d.querySelectorAll('.model-grid input:not([type="checkbox"])');
  inputs[0].value='planner-example';inputs[0].dispatchEvent(new d.defaultView.Event('input'));inputs[1].value='https://models.example/v1';inputs[1].dispatchEvent(new d.defaultView.Event('input'));
  click('保存配置草稿');assert.equal(p.state.configRevision,2);
  click('环境与登录',d.querySelector('.subnav'));click('规划与执行模型',d.querySelector('.subnav'));
  assert.equal(d.querySelector('.model-grid input:not([type="checkbox"])').value,'planner-example');
});

test('domain and skill drafts retain versions without claiming real promotion', t => {
  const { p, d, click, input, sheet } = setup(t);
  click('物料');click('领域知识',d.querySelector('.subnav'));click('永续合约领域');
  input('规则、术语、边界与反例','测试规则：数量精度不得通过四舍五入改变用户意图。');click('保存候选草稿',sheet());
  assert.equal(p.state.domainDrafts.get('perp').version,2);assert.equal(p.state.domains[1].version,1);
  d.getElementById('sheet-x').click();click('Role / Skill',d.querySelector('.subnav'));
  click('详情 / 管理',d.querySelector('.review-table'));input('职责与提示约束修订','每条观察都保留出处');click('保存技能候选',sheet());
  assert.equal(p.state.roleVersions.size,0);click('模拟绑定新版本',sheet());assert.equal(p.state.roleVersions.size,1);
});

test('deep links reopen the specific case and missing IDs show an honest empty state', t => {
  const first=setup(t);const id=first.p.cases()[0].id;
  const q=new URLSearchParams({view:'ws',project:'selftest',work:'structure',case:id,tab:'evidence'});
  const {p,sheet}=setup(t,'#'+q.toString());assert.equal(p.state.caseId,id);assert.equal(p.state.caseTab,'evidence');assert.equal(sheet().hidden,false);
  const missing=setup(t,'#view=ws&case=missing-id');assert.match(missing.sheet().textContent,/找不到这条用例/);
});

test('project switch clears stale objects, empty messages cannot send, and theme toggles', t => {
  const {p,d,w,click}=setup(t);click('AI 助手');assert.equal(d.getElementById('send').disabled,true);
  const ta=d.getElementById('ta');ta.value=' ';ta.dispatchEvent(new w.Event('input'));assert.equal(d.getElementById('send').disabled,true);
  click('深色');assert.equal(d.documentElement.dataset.theme,'dark');
  const proj=d.getElementById('proj');proj.selectedIndex=1;proj.dispatchEvent(new w.Event('change'));
  assert.equal(p.state.caseId,null);assert.equal(p.cases().length,0);assert.match(d.getElementById('view').textContent,/尚未导入材料/);
});

test('export contains clickable module/story structure, case provenance and separate research status', t => {
  const {p}=setup(t);const doc=new JSDOM(p.exportDocument());t.after(()=>doc.window.close());
  assert.equal(doc.window.document.querySelectorAll('nav a').length,6);
  assert.equal(doc.window.document.querySelectorAll('details').length,22);
  assert.equal(doc.window.document.querySelectorAll('article').length,p.cases().length);
  assert.match(doc.window.document.body.textContent,/不构成真实批准或论文证据/);
});

test('batch actions only affect selected cases in the current filter, and retain original materials', t => {
  const {p,d,w,click}=setup(t);click('复核');click('批量处理');
  const a=p.cases()[0],b=p.cases()[1],before=a.exp;
  const cb=[...d.querySelectorAll('input[type="checkbox"]')].find(n=>n.getAttribute('aria-label')==='选择 '+a.id);cb.click();
  const find=d.querySelector('[aria-label="批量查找"]'),replace=d.querySelector('[aria-label="批量替换为"]');find.value=before;replace.value='新的完整预期';click('预览替换');
  assert.equal(p.state.cases.get('selftest:'+a.id).draft.exp,'新的完整预期');assert.equal(p.state.cases.has('selftest:'+b.id),false);assert.equal(a.exp,before);
  const filter=d.querySelector('[aria-label="审阅状态"]');filter.value='draft';filter.dispatchEvent(new w.Event('change'));
  assert.equal(d.querySelectorAll('.review-table tbody tr').length,1);click('模拟拒绝选中');
  assert.equal(p.state.cases.get('selftest:'+a.id).reviewStatus,'rejected');assert.equal(p.state.cases.get('selftest:'+a.id).draft.exp,'新的完整预期');
});

test('cancel topology restores deleted nodes and quality gates cannot be removed', t => {
  const {p,w,d,click}=setup(t);const before=JSON.stringify(p.graphSnapshot());click('设置',d.getElementById('nav'));click('流程模板',d.querySelector('.subnav'));click('定制实验流程');
  w.dropNode('gate');assert.ok(p.graphSnapshot().nodes.some(n=>n.id==='gate'));
  w.dropNode('codegen');assert.equal(p.graphSnapshot().nodes.some(n=>n.id==='codegen'),false);
  assert.ok(p.graphErrors().length);click('放弃');assert.equal(JSON.stringify(p.graphSnapshot()),before);
  click('工作台',d.getElementById('nav'));assert.ok(d.querySelector('.canvas-wrap'));assert.equal(d.querySelector('.bench-artifact'),null);
});

test('US-14 deep link defaults to the story and cases, with tools disclosed only on demand', t => {
  const {d,p,click}=setup(t,'#view=ws&project=selftest&work=structure&module=workflow&story=US-14');
  assert.equal(p.state.story,'US-14');assert.equal(d.querySelector('.chat').hidden,true);
  assert.equal(d.querySelectorAll('#nav .nav-item').length,8);assert.equal(d.querySelectorAll('#nav .nav-group').length,4);
  const source=[...d.querySelectorAll('.structure-content details')].find(n=>n.firstElementChild.textContent==='需求原文');
  assert.ok(source);assert.equal(source.open,false);assert.equal(d.querySelector('.review-bulk').hidden,true);
  assert.equal(d.querySelector('.filter-disclosure').open,false);
  assert.equal(d.querySelector('.review-table th').hidden,true);
  click('需求原文');assert.equal(source.open,true);
  click('批量处理');assert.equal(d.querySelector('.review-bulk').hidden,false);assert.equal(d.querySelector('.review-table th').hidden,false);
  click('退出批量');assert.equal(d.querySelector('.review-bulk').hidden,true);
  click('AI 助手');assert.equal(d.querySelector('.chat').hidden,false);assert.equal(p.state.story,'US-14');
  click('收起助手');assert.equal(d.querySelector('.chat').hidden,true);assert.equal(p.state.story,'US-14');
});

test('workflow opens the complete canvas and node details keep advanced controls on demand', t => {
  const {d,w,click,sheet}=setup(t);
  assert.ok(d.querySelector('.canvas-wrap'));assert.equal(d.querySelector('.flow-phase'),null);w.openNode('stories');assert.match(sheet().textContent,/运行完成后/);assert.ok(![...sheet().querySelectorAll('button')].some(b=>b.textContent==='产品结构'));d.getElementById('sheet-x').click();
  d.querySelector('[aria-label="设计用例 · design"]').click();
  const advanced=sheet().querySelector('details');assert.equal(advanced.open,false);
  const x=d.getElementById('sheet-x');x.focus();x.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true}));
  assert.equal(d.activeElement,advanced.querySelector('summary'));
  click('只跑此节点',sheet());assert.match(sheet().textContent,/执行 1 个节点：design/);
  d.getElementById('sheet-x').click();click('设置',d.getElementById('nav'));click('流程模板',d.querySelector('.subnav'));click('定制实验流程');assert.ok(d.querySelector('.node.editable'));click('放弃');click('工作台',d.getElementById('nav'));assert.ok(d.querySelector('.canvas-wrap'));
});

test('structure and workflow retain story scope without unrelated evidence', t => {
  const {d,p,click,sheet}=setup(t,'#view=ws&work=structure&module=workflow&story=US-14');
  const expected=p.cases().filter(c=>c.id.startsWith('US-14-')).length;
  click('工作台');assert.equal(p.state.story,'US-14');assert.equal(p.flowSummary().list.length,expected);
  click('范围产物');click('查看执行证据',sheet());assert.match(sheet().textContent,/当前范围没有执行证据/);
  assert.equal(sheet().querySelector('table'),null);d.getElementById('sheet-x').click();
  click('物料',d.getElementById('nav'));click('产品结构',d.querySelector('.subnav'));assert.equal(p.state.story,'US-14');assert.match(d.querySelector('.review-header h1').textContent,/工作流画布/);
  click('工作台');click('查看整个项目');assert.equal(p.state.story,null);assert.equal(p.flowSummary().results.length,2);
  assert.ok(p.flowSummary().results.every(r=>p.cases().some(c=>c.id===r.id)));
});

test('review retains the implemented queue/detail pattern; confirmation keeps queue and selected context', t => {
  const {d,p,click}=setup(t,'#view=as&section=cases');const c=p.cases()[0],original=JSON.stringify(c);
  assert.equal(p.ui.view,'as');assert.equal(p.ui.as,'cases');assert.equal(d.querySelectorAll('.queue-case').length,40);
  assert.equal(d.getElementById('sheet').hidden,true);assert.ok(d.querySelector('#case-detail .detail-section'));
  click('模拟确认此用例',d.querySelector('#case-detail'));
  assert.equal(p.state.cases.get('selftest:'+c.id).reviewStatus,'approved');assert.equal(JSON.stringify(c),original);assert.equal(p.state.attempts.length,0);
  assert.equal(d.querySelectorAll('.queue-case').length,40);assert.match(d.querySelector('.queue-case').textContent,/已确认/);
  click('下一条',d.querySelector('#case-detail'));assert.equal(p.state.caseId,p.cases()[1].id);assert.equal(d.getElementById('sheet').hidden,true);
});

test('a revised executed case is marked stale in workflow evidence', t => {
  const {d,p,w,click,input,sheet}=setup(t);const c=p.flowSummary().codes[0];
  w.selectCase(c.id);click('修订与对比',sheet());input('修订后的预期结果',c.exp+'；补充可观察量');input('修订依据 / 原因','本地测试修订依据');click('保存草稿',sheet());click('模拟确认修订',sheet());
  d.getElementById('sheet-x').click();click('工作台');assert.equal(p.flowSummary().stale.length,1);
  click('范围产物');assert.match(sheet().textContent,/1 条待重验/);click('查看执行证据',sheet());assert.match(sheet().textContent,/已过期 · 待重验/);
  assert.equal(sheet().querySelectorAll('tbody tr').length,p.flowSummary().results.length);
});

test('review scope is distinct from selected story; search stays inline and reload preserves scope', t => {
  const {d,p,w,click}=setup(t,'#view=as&section=cases');
  const module=d.querySelector('[aria-label="产品模块"]');module.value='workflow';module.dispatchEvent(new w.Event('change'));
  const story=d.querySelector('[aria-label="用户故事"]');story.value='US-14';story.dispatchEvent(new w.Event('change'));
  assert.equal(p.state.reviewScope.story,'US-14');const items=p.cases().filter(c=>c.id.startsWith('US-14-'));assert.equal(d.querySelectorAll('.queue-case').length,items.length);
  click('下一条',d.querySelector('#case-detail'));assert.equal(p.state.reviewScope.story,'US-14');assert.equal(d.querySelectorAll('.queue-case').length,items.length);
  const restored=setup(t,w.location.hash);assert.equal(restored.p.state.reviewScope.story,'US-14');assert.equal(restored.p.state.caseId,p.state.caseId);assert.equal(restored.d.getElementById('sheet').hidden,true);
  const search=d.querySelector('[aria-label="搜索用例队列"]');search.value='no-such-test-case';search.dispatchEvent(new w.Event('input'));
  assert.equal(d.querySelectorAll('.queue-case').length,0);assert.match(d.querySelector('#case-detail').textContent,/当前筛选没有用例/);assert.equal(p.state.caseId,null);
  search.value='';search.dispatchEvent(new w.Event('input'));assert.equal(d.querySelectorAll('.queue-case').length,items.length);
  click('产品结构');assert.equal(p.state.story,'US-14');click('用例复核');assert.equal(p.state.reviewScope.story,'US-14');assert.ok(d.querySelector('#case-detail'));
});

test('inline revisions keep evidence invalidation, source return and review state on the same screen', t => {
  const {d,p,w,click,input,sheet}=setup(t,'#view=as&section=cases');const c=p.cases()[0];
  click('修订与对比',d.querySelector('#case-detail'));input('修订后的预期结果',c.exp+'；明确可观察量');input('修订依据 / 原因','引用 US-01 原文核对');
  click('保存草稿',d.querySelector('#case-detail'));assert.equal(sheet().hidden,true);assert.match(d.querySelector('.queue-case').textContent,/有草稿/);
  click('模拟确认修订',d.querySelector('#case-detail'));assert.match(d.querySelector('.queue-case').textContent,/证据待重验/);
  click('规格原文',d.querySelector('#case-detail'));assert.equal(sheet().hidden,false);d.getElementById('sheet-x').click();
  assert.equal(p.state.caseId,c.id);assert.equal(sheet().hidden,true);assert.match(d.querySelector('#case-detail').textContent,/明确可观察量/);
  click('代码与证据',d.querySelector('#case-detail'));assert.match(d.querySelector('#case-detail').textContent,/历史代码与结果已过期/);
  assert.equal(p.state.attempts.length,0);assert.equal(d.querySelectorAll('.queue-case').length,40);
});

test('Flow is home; navigation, artifacts and related node actions radiate into review and settings', t => {
  const {d,p,w,click,sheet}=setup(t,'');
  const labels=[...d.querySelectorAll('#nav .nav-item')].map(n=>n.textContent);
  assert.deepEqual(labels.slice(0,4),['工作台','复核','物料','运行报告']);assert.equal(labels.length,8);
  assert.equal(p.ui.view,'ws');assert.equal(p.state.workView,'workflow');assert.ok(d.querySelector('.canvas-wrap'));
  assert.match(d.querySelector('.flow-activity').textContent,/wf-mt0xaw2g/);
  click('物料',d.getElementById('nav'));click('产品结构',d.querySelector('.subnav'));assert.equal(d.querySelectorAll('.module-tile').length,6);
  d.querySelector('[data-module="workflow"]').click();click('US-16 · 节点调试');click('工作台');
  const count=p.cases().filter(c=>c.id.startsWith('US-16-')).length;
  assert.equal(d.querySelector('.bench-artifact'),null);click('范围产物');click('进入复核',sheet());assert.equal(p.state.reviewScope.story,'US-16');assert.equal(d.querySelectorAll('.queue-case').length,count);
  click('工作台');d.querySelector('[aria-label="生成代码 · codegen"]').click();click('执行模型',sheet());assert.equal(p.ui.st,'model');assert.ok(d.querySelector('.model-grid'));
});

test('simulated runs enter the bench with run-scoped placeholders and no real model execution', t => {
  const {d,p,w,click,sheet}=setup(t);
  w.openNode('design');click('只跑此节点',sheet());click('创建模拟运行',sheet());
  assert.equal(p.ui.view,'ws');assert.equal(p.state.benchRunId,'preview-001');assert.equal(sheet().hidden,true);assert.equal(d.querySelectorAll('.bench-artifact').length,1);click('运行详情');
  assert.match(d.querySelector('.run-meta').textContent,/模拟完成.*单节点.*0 calls/);
  assert.equal(d.querySelectorAll('.run-detail-content tbody tr').length,1);
  click('产出物料');assert.match(d.querySelector('.run-detail-content').textContent,/没有生成真实用例/);assert.equal(d.querySelectorAll('.run-detail-content tbody tr').length,1);
  click('日志与事件');assert.match(d.querySelector('.run-detail-content').textContent,/run.created/);
  click('返回记录列表');assert.equal(d.querySelectorAll('.record-list tbody tr').length,2);assert.match(d.querySelector('.record-list').textContent,/wf-mt0xaw2g/);
  click('运行报告',d.querySelector('#nav'));assert.equal(d.querySelector('.workflow-records'),null);assert.doesNotMatch(d.getElementById('view').textContent,/preview-001/);
  click('工作台');assert.match(d.querySelector('.flow-activity').textContent,/preview-001/);
});

test('run details read their frozen graph and archive materials after workbench edits', t => {
  const {p,w,d,click,input,sheet}=setup(t);const a=p.createAttempt(p.scopePlan('single',new Set(['design']),true)),before=JSON.stringify(a.graph),archive=JSON.stringify(p.archivedWorkflow);
  w.openNode('design');click('高级配置',sheet());input('节点参数（JSON）','{"maxCasesPerStory":99}');click('保存为新版本',sheet());
  d.getElementById('sheet-x').click();click('选择运行记录');click(a.id,d.querySelector('.record-list'));click('运行详情');click('冻结配置');
  assert.equal(d.querySelector('.run-detail-content pre').textContent,JSON.stringify(JSON.parse(before),null,2));assert.equal(JSON.stringify(a.graph),before);assert.equal(JSON.stringify(p.archivedWorkflow),archive);
  click('节点记录');click('design',d.querySelector('.run-detail-content'));assert.match(sheet().textContent,/执行版本 v3/);assert.doesNotMatch(sheet().textContent,/99/);d.getElementById('sheet-x').click();
  click('返回记录列表');click(p.archivedWorkflow.id,d.querySelector('.record-list'));click('运行详情');click('产出物料');click('查看归档用例');assert.equal(sheet().querySelectorAll('tbody tr').length,40);
  d.getElementById('sheet-x').click();click('冻结配置');assert.match(d.querySelector('.run-detail-content pre').textContent,/"version": 2/);
});

test('workflow record search and project identity cannot leak another project run', t => {
  const {p,w,d,click}=setup(t);p.createAttempt(p.scopePlan('selected',new Set(['design','gate']),true));click('选择运行记录');
  const search=d.querySelector('[aria-label="搜索工作流记录"]');search.value='preview-001';search.dispatchEvent(new w.Event('input'));assert.equal(d.querySelectorAll('.record-list tbody tr').length,1);
  click('preview-001',d.querySelector('.record-list'));assert.equal(p.benchRun().mode,'selected');click('选择运行记录');assert.equal(d.querySelector('[aria-label="搜索工作流记录"]').value,'preview-001');
  const select=d.getElementById('proj');select.selectedIndex=1;select.dispatchEvent(new w.Event('change'));click('选择运行记录');assert.match(d.getElementById('sheet').textContent,/尚无匹配的运行记录/);assert.doesNotMatch(d.getElementById('view').textContent,/preview-001|wf-mt0xaw2g/);assert.equal(p.workflowRecords().length,0);
});

test('workflow details deep-link to an archive tab; missing session records stay visibly missing', t => {
  const archive=setup(t,'#view=hi&project=selftest&section=workflow-detail&run=wf-mt0xaw2g&runTab=snapshot');
  assert.equal(archive.p.state.runTab,'snapshot');assert.match(archive.d.querySelector('.run-detail-content').textContent,/19da4de9/);
  const missing=setup(t,'#view=hi&project=selftest&section=workflow&run=preview-001');assert.match(missing.d.getElementById('view').textContent,/这条工作流记录不可用/);assert.equal(missing.d.querySelector('.run-detail-content'),null);
  const wrong=setup(t,'#view=hi&project=acme&section=workflow&run=wf-mt0xaw2g');assert.match(wrong.d.getElementById('view').textContent,/这条工作流记录不可用/);assert.equal(wrong.d.querySelector('.run-detail-content'),null);
});

test('bench runs pause before each breakpoint, resume the same run and never repeat completed nodes', t => {
  const {d,p,click,sheet}=setup(t);
  assert.equal(d.querySelectorAll('.bench-node.pending').length,7);assert.equal(d.querySelectorAll('.bench-artifact').length,0);
  click('断点 design');click('断点 codegen');click('开始执行');assert.match(sheet().textContent,/断点：design、codegen/);click('创建模拟运行',sheet());
  const run=p.benchRun(),id=run.id,snapshot=JSON.stringify(run.graph);assert.equal(run.status,'paused');assert.equal(run.pauseNode,'design');
  assert.equal(d.querySelectorAll('.bench-node.done').length,2);assert.equal(d.querySelector('[data-node="design"].bench-node').dataset.state,'paused');assert.equal(run.nodeStates.design.attempted,false);assert.equal(run.artifacts.length,2);
  assert.equal(d.querySelector('[aria-label="断点 spec"]').disabled,true);assert.equal(p.toggleBenchBreakpoint('spec'),false);assert.equal(run.breakpoints.includes('spec'),false);
  click('继续此 run');assert.equal(p.benchRun().id,id);assert.equal(run.pauseNode,'codegen');assert.equal(run.nodeStates.design.status,'done');assert.equal(run.artifacts.length,4);assert.equal(run.nodeStates.spec.attempts,1);
  click('继续此 run');assert.equal(run.status,'completed');assert.equal(run.artifacts.length,7);assert.equal(new Set(run.artifacts.map(a=>a.id)).size,7);assert.equal(run.nodeStates.spec.attempts,1);assert.equal(JSON.stringify(run.graph),snapshot);
  assert.equal(d.querySelectorAll('.bench-node.done').length,7);assert.equal(d.querySelectorAll('.bench-node .bp:disabled').length,7);assert.equal(p.executeBenchRun(id),false);
  assert.equal([...d.querySelectorAll('button')].find(b=>b.textContent==='继续此 run').disabled,true);assert.equal(run.calls,0);assert.ok(run.artifacts.every(a=>a.payload.simulation===true));
});

test('switching runs restores their own states and artifacts, and a new run starts empty', t => {
  const {d,p,w,click,sheet}=setup(t);
  click('断点 design');click('开始执行');click('创建模拟运行',sheet());const first=p.benchRun(),saved=JSON.stringify(first);
  click('新建 run');assert.equal(p.benchRun(),null);assert.equal(d.querySelectorAll('.bench-artifact').length,0);assert.equal(d.querySelectorAll('.bench-node.pending').length,7);assert.equal(p.ui.bp.size,0);
  click('断点 stories');click('开始执行');click('创建模拟运行',sheet());const second=p.benchRun();assert.notEqual(second.id,first.id);assert.equal(second.artifacts.length,1);assert.equal(JSON.stringify(first),saved);
  const select=d.getElementById('bench-run-selector');select.value=first.id;select.dispatchEvent(new w.Event('change'));
  assert.equal(p.benchRun().id,first.id);assert.equal(d.querySelectorAll('.bench-artifact').length,2);assert.ok([...d.querySelectorAll('.bench-artifact')].every(a=>a.dataset.run===first.id));assert.equal(d.querySelector('.bench-node.paused').dataset.node,'design');
  const original=JSON.stringify(p.archivedWorkflow);p.selectBenchRun(p.archivedWorkflow.id);assert.equal(d.querySelectorAll('.bench-node.done').length,7);assert.ok([...d.querySelectorAll('.bench-artifact')].every(a=>a.dataset.run===p.archivedWorkflow.id));assert.equal(p.executeBenchRun(p.archivedWorkflow.id),false);assert.equal(JSON.stringify(p.archivedWorkflow),original);
  d.querySelector('[data-artifact="wf-mt0xaw2g/a-cases"]').click();assert.equal(sheet().querySelectorAll('tbody tr').length,40);assert.match(sheet().textContent,/只读归档物料/);
});

test('resuming a paused run uses its frozen parameters even after the working graph changes', t => {
  const {d,p,w,click,input,sheet}=setup(t);
  click('断点 design');click('开始执行');click('创建模拟运行',sheet());const run=p.benchRun(),snapshot=JSON.stringify(run.graph);
  click('新建 run');w.openNode('design');click('高级配置',sheet());input('节点参数（JSON）','{"maxCasesPerStory":99}');click('保存为新版本',sheet());d.getElementById('sheet-x').click();
  assert.equal(p.state.graphVersion,4);p.selectBenchRun(run.id);click('继续此 run');assert.equal(run.status,'completed');assert.equal(JSON.stringify(run.graph),snapshot);
  assert.equal(run.artifacts.find(a=>a.nodeId==='design').payload.params.maxCasesPerStory,5);assert.equal(run.graph.version,3);assert.match(d.querySelector('.bench-identity').textContent,/v3/);
});

test('breakpoint eligibility respects run scope and an unstarted paused node can remove its breakpoint', t => {
  const {p,d,click}=setup(t);const run=p.createAttempt(p.scopePlan('single',new Set(['design']),true));p.selectBenchRun(run.id);
  assert.equal(p.canSetBenchBreakpoint(run,'spec'),false);assert.equal(p.canSetBenchBreakpoint(run,'design'),true);assert.equal(d.querySelector('[aria-label="断点 spec"]').disabled,true);
  click('断点 design');click('启动此 run');assert.equal(run.pauseNode,'design');assert.equal(run.artifacts.length,0);assert.equal(run.nodeStates.design.attempted,false);
  click('断点 design');assert.equal(run.breakpoints.length,0);click('继续此 run');assert.equal(run.status,'completed');assert.equal(run.artifacts.length,1);assert.equal(run.nodeStates.spec.status,'skipped');assert.equal(p.toggleBenchBreakpoint('design'),false);
});

test('a failed node is red and cannot accept a breakpoint; resume retries it without replaying prior nodes', t => {
  const {p,w,d}=setup(t),original=w.simulateNodeArtifact,run=p.createAttempt(p.scopePlan('full',new Set(),true));
  w.simulateNodeArtifact=(r,n)=>{if(n.id==='stories')throw Error('test-only simulated failure');original(r,n);};p.executeBenchRun(run.id);
  assert.equal(run.status,'failed');assert.equal(run.pauseNode,'stories');assert.equal(d.querySelector('.bench-node.failed').dataset.node,'stories');assert.equal(run.nodeStates.stories.attempted,true);assert.equal(p.canSetBenchBreakpoint(run,'stories'),false);assert.equal(run.artifacts.length,1);
  w.simulateNodeArtifact=original;p.executeBenchRun(run.id);assert.equal(run.status,'completed');assert.equal(run.nodeStates.stories.attempts,2);assert.equal(run.nodeStates.spec.attempts,1);assert.equal(run.nodeStates.stories.error,undefined);assert.equal(run.artifacts.length,7);assert.ok(run.events.some(e=>e.type==='node.failed'&&e.error.includes('test-only')));
});

test('run selection is deep-linkable and cannot resume another project’s record', t => {
  const {d,p,w}=setup(t);const run=p.createAttempt(p.scopePlan('full',new Set(),true));p.selectBenchRun(run.id);assert.match(w.location.hash,/work=workflow/);assert.match(w.location.hash,/run=preview-001/);
  const missing=setup(t,w.location.hash);assert.match(missing.d.getElementById('view').textContent,/这条工作流记录不可用/);assert.equal(missing.d.querySelector('.bench-artifact'),null);
  const archived=setup(t,'#view=hi&project=selftest&section=workflow&run=wf-mt0xaw2g');assert.equal(archived.p.ui.view,'ws');assert.equal(archived.p.benchRun().id,'wf-mt0xaw2g');assert.equal(archived.d.querySelectorAll('.bench-node.done').length,7);
  const before=JSON.stringify(run);w.selectProject('acme');assert.equal(p.executeBenchRun(run.id),false);p.selectBenchRun(run.id);assert.equal(p.state.benchRunId,null);assert.equal(JSON.stringify(run),before);assert.equal(d.querySelector('.bench-artifact'),null);
});

test('during execution only future untouched nodes remain eligible for new breakpoints', t => {
  const {p}=setup(t),run=p.createAttempt(p.scopePlan('full',new Set(),true));run.status='running';run.nodeStates.spec={status:'running',attempted:true};
  assert.equal(p.canSetBenchBreakpoint(run,'spec'),false);assert.equal(p.canSetBenchBreakpoint(run,'stories'),true);
  run.nodeStates.spec.status='done';assert.equal(p.canSetBenchBreakpoint(run,'spec'),false);
});

test('archive materials expose readable specifications, reconstructed product bundle and original evidence viewers', t => {
  const {d,p,click,sheet}=setup(t,'#view=ws&project=selftest&work=workflow&run=wf-mt0xaw2g');
  const run=p.benchRun(),before=JSON.stringify(run);
  click('本次全部物料');assert.equal(sheet().querySelectorAll('tbody tr').length,9);
  p.openBenchArtifact(run,run.artifacts.find(a=>a.table==='spec'));assert.equal(sheet().querySelectorAll('.source-excerpt').length,2);assert.match(sheet().textContent,/US-01/);
  p.openBenchArtifact(run,run.artifacts.find(a=>a.table==='stories'));assert.match(sheet().textContent,/20 个故事/);click('查看产品结构 + 用户故事',sheet());
  assert.equal(sheet().querySelectorAll('.product-hierarchy-node').length,6);assert.equal(sheet().querySelectorAll('tbody tr').length,22);assert.match(sheet().textContent,/非历史 run/);
  p.openBenchArtifact(run,run.artifacts.find(a=>a.table==='findings'));click('展开归档详情',sheet());assert.match(sheet().textContent,/finding|门禁|检查/);
  p.openBenchArtifact(run,run.artifacts.find(a=>a.table==='code'));assert.equal(sheet().querySelectorAll('.source-excerpt').length,Object.keys(run.code).length);
  assert.equal(JSON.stringify(run),before);
});

test('Spec file upload reads safe text, validates input, and freezes inputs and artifacts per run', async t => {
  const {w,d,p,click,sheet}=setup(t);click('开始执行');
  const use=d.querySelector('[aria-label="使用内置规格样例"]');use.click();assert.equal([...sheet().querySelectorAll('button')].find(b=>b.textContent==='创建模拟运行').disabled,true);
  const upload=sheet().querySelector('[aria-label="上传规格材料"]'),file=new w.File(['# 订单\n用户可以查看订单。<script>window.bad=true</script>'],'orders.md',{type:'text/markdown'});
  Object.defineProperty(upload,'files',{value:[file]});await upload.onchange();assert.equal(p.productWorkspace().input.documents.length,1);assert.equal(p.inputErrors().length,0);assert.equal(w.bad,undefined);
  click('创建模拟运行',sheet());const run=p.benchRun();assert.equal(run.sourceKind,'spec');assert.equal(run.entry,'Web UI');assert.equal(run.input.useReference,false);assert.match(run.input.documents[0].text,/订单/);
  const frozen=JSON.stringify(run.input);p.productWorkspace().input.documents[0].text='changed';assert.equal(JSON.stringify(run.input),frozen);
  p.openBenchArtifact(run,run.artifacts.find(a=>a.nodeId==='spec'));assert.match(sheet().textContent,/用户可以查看订单/);assert.equal(sheet().querySelector('script'),null);
  await assert.rejects(p.readLocalText(new w.File(['pdf'],'requirements.pdf')),/PDF/);
  await assert.rejects(p.readLocalText(new w.File(['a'.repeat(2*1024*1024+1)],'large.md')),/2 MB/);
});

test('Explore entry is independent of host and preserves previous run snapshots; Code stays disabled', t => {
  const {d,p,w,click,input,sheet}=setup(t);const first=p.createAttempt(p.scopePlan('full',new Set(),true)),before=JSON.stringify(first);
  click('开始执行');click('Explore · 探索产品',sheet());input('探索地址','javascript:alert(1)');assert.match(sheet().querySelector('.scope-preview').textContent,/HTTP/);
  const code=[...sheet().querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Code · 实际代码');assert.equal(code.disabled,true);
  input('探索地址','https://sut.example/orders');input('探索范围与限制','只查看订单，不提交交易');p.state.mode='claude';click('创建模拟运行',sheet());
  const run=p.benchRun();assert.equal(run.sourceKind,'explore');assert.equal(run.entry,'Claude Code');assert.equal(run.graph.nodes[0].type,'source.explore');assert.equal(run.nodes[0],'explore');assert.equal(run.input.exploreScope,'只查看订单，不提交交易');assert.equal(JSON.stringify(first),before);
  p.openBenchArtifact(run,run.artifacts[0]);assert.match(sheet().textContent,/尚无实际观察证据/);assert.equal(run.calls,0);
});

test('knowledge and Skill bindings are role-scoped, versioned, project-isolated and frozen on run creation', t => {
  const {d,w,p,click,input,sheet}=setup(t);click('开始执行');click('添加知识 / Skill');
  input('知识名称','finance');input('来源 / 路径 / Skill 标识','.claude/skills/finance/SKILL.md');input('知识内容 / SKILL.md','---\nname: finance\ndescription: Domain reference\n---\nPrecision rules');
  const kind=sheet().querySelector('[aria-label="前置知识类型"]');kind.value='skill';kind.dispatchEvent(new w.Event('change'));
  click('保存前置知识',sheet());assert.match(sheet().textContent,/执行预览/);click('创建模拟运行',sheet());const run=p.benchRun();
  const design=run.graph.nodes.find(n=>n.type==='design.cases'),gate=run.graph.nodes.find(n=>n.type==='gate.textcase');assert.equal(design.context.knowledge[0].name,'finance');assert.equal(design.context.skillExecution,'disabled-in-prototype');assert.equal(gate.context.knowledge.length,0);
  const frozen=JSON.stringify(design.context);p.productWorkspace().input.knowledge[0].content='changed';assert.equal(JSON.stringify(design.context),frozen);
  assert.equal(p.graphSnapshot().nodes.find(n=>n.type==='source.spec').skill,'内置文档解析');
  w.selectProject('acme');assert.equal(p.productWorkspace().input.knowledge.length,0);assert.equal(p.productWorkspace().input.documents.length,0);
  w.selectProject('selftest');assert.equal(p.productWorkspace().input.knowledge[0].name,'finance');
});

test('product hierarchy drills main module to submodule and feature; a cross-module story remains one entity', t => {
  const {d,p,click}=setup(t,'#view=ws&work=structure&module=project');
  d.querySelector('[data-product-node="project/configuration"]').click();assert.equal(d.querySelectorAll('#module-content tbody tr').length,2);
  d.querySelector('[data-product-node="feature/US-01"]').click();assert.equal(d.querySelectorAll('#module-content tbody tr').length,1);assert.match(d.getElementById('module-content').textContent,/US-01/);
  const model=p.projectProductModel();assert.equal(model.stories.filter(s=>s.id==='US-16').length,1);
  for(const id of ['workflow','requirements','execution','harness'])assert.ok(p.productNodeStoryIds(model,id).includes('US-16'));
  click('用例复核',d.querySelector('.workflow-toolbar'));assert.equal(p.reviewItems().length,2);assert.ok(p.reviewItems().every(c=>c.id.startsWith('US-01')));
});

test('case approval uses product hierarchy inline, retains feature filter on deep link and can clear it', t => {
  const {w,d,p,click}=setup(t);click('复核',d.getElementById('nav'));click('按产品结构筛选');
  const graph=()=>d.querySelector('.product-graph-filter');graph().querySelector('[data-product-node="project"]').click();graph().querySelector('[data-product-node="project/configuration"]').click();graph().querySelector('[data-product-node="feature/US-01"]').click();
  assert.equal(p.reviewItems().length,2);assert.match(w.location.hash,/reviewNode=feature%2FUS-01/);
  const restored=setup(t,w.location.hash);assert.equal(restored.p.reviewItems().length,2);
  click('清除结构筛选',graph());assert.equal(p.reviewItems().length,40);assert.equal(p.state.reviewScope.productNode,undefined);
});

test('stories node produces a readable product bundle and merge preserves immutable source runs', t => {
  const {d,w,p,click,sheet}=setup(t);const first=p.createAttempt(p.scopePlan('full',new Set(),true));p.executeBenchRun(first.id);
  const product=first.artifacts.find(a=>a.nodeId==='stories');assert.equal(product.name,'产品结构 + 用户故事');assert.ok(product.payload.productModel);d.querySelector('[data-artifact="'+product.id+'"]').click();assert.equal(sheet().querySelectorAll('tbody tr').length,22);assert.match(sheet().textContent,/未从本次上传材料/);
  p.prepareBenchRun();w.setWorkflowSource('explore',false);p.productWorkspace().input.targetUrl='https://sut.example';const second=p.createAttempt(p.scopePlan('full',new Set(),true));p.executeBenchRun(second.id);const before=JSON.stringify(p.state.attempts);
  p.openProductMerge();sheet().querySelector('[aria-label="融合 '+first.id+'"]').click();sheet().querySelector('[aria-label="融合 '+second.id+'"]').click();click('保存融合版本',sheet());
  const merged=p.projectProductModel();assert.equal(merged.revision,2);assert.equal(merged.stories.length,22);assert.ok(merged.provenance.some(p=>p.kind==='spec'));assert.ok(merged.provenance.some(p=>p.kind==='explore'));assert.equal(JSON.stringify(p.state.attempts),before);
});

test('product merge exposes conflicts, supports explicit resolution and rejects invalid or foreign graphs', t => {
  const {p}=setup(t),base=p.buildReferenceProductModel(),candidate=JSON.parse(JSON.stringify(base));candidate.id='candidate';candidate.stories[0].text='候选冲突';
  const before=JSON.stringify(base),plan=p.productMergePlan(base,[candidate]);assert.equal(plan.unresolved,1);assert.equal(plan.result.stories[0].text,base.stories[0].text);const key=plan.conflicts[0].key;
  const resolved=p.productMergePlan(base,[candidate],{[key]:'incoming'});assert.equal(resolved.unresolved,0);assert.equal(resolved.result.stories[0].text,'候选冲突');assert.equal(JSON.stringify(base),before);
  candidate.project='foreign';assert.throws(()=>p.productMergePlan(base,[candidate]),/其他项目/);candidate.project=base.project;candidate.nodes.push({id:'broken',parentId:'missing',kind:'feature',name:'bad'});assert.throws(()=>p.productMergePlan(base,[candidate]),/父节点/);
});

test('exported product functional document has a linked hierarchy, deduplicated stories and source provenance', t => {
  const {p}=setup(t),model=p.projectProductModel();model.stories[0].text+=' <script>bad()</script>';
  const dom=new JSDOM(p.productModelDocument(model));t.after(()=>dom.window.close());const d=dom.window.document;
  assert.equal(d.querySelectorAll('section[id^="story-"]').length,22);assert.equal(d.querySelectorAll('script').length,0);assert.equal(d.querySelectorAll('section[id^="node-"]').length,40);
  for(const a of d.querySelectorAll('a[href^="#"]'))assert.ok(d.getElementById(a.getAttribute('href').slice(1)));
  assert.match(d.body.textContent,/主模块|项目与环境/);assert.match(d.body.textContent,/来源/);assert.equal(d.querySelectorAll('#story-US-16').length,1);
});

test('product reports and baselines have separate navigation and stable main-menu ownership', t => {
  const {d,w,click}=setup(t,'#view=hi&project=selftest&section=runs');
  const sections=()=>[...d.querySelectorAll('.subnav button')].map(b=>b.textContent);
  const active=()=>d.querySelector('#nav [aria-current="true"]').textContent;
  assert.deepEqual(sections(),['执行记录','套件批次','趋势']);
  for(const tab of ['套件批次','趋势','执行记录']){click(tab,d.querySelector('.subnav'));assert.equal(active(),'运行报告');assert.ok(!sections().includes('待审批'));}
  click('基线',d.getElementById('nav'));
  assert.deepEqual(sections(),['待审批','当前基线','审批记录']);
  for(const tab of ['当前基线','审批记录','待审批']){click(tab,d.querySelector('.subnav'));assert.equal(active(),'基线');assert.ok(!sections().includes('执行记录'));}
  w.history.replaceState(null,'','#view=hi&project=selftest&section=base-current');w.readRoute();w.render();
  assert.equal(active(),'基线');assert.equal(d.querySelector('.surface-heading h2').textContent,'当前基线');
  click('运行报告',d.getElementById('nav'));assert.equal(active(),'运行报告');assert.equal(d.querySelector('.surface-heading h2').textContent,'执行记录');
});

test('baseline decisions resolve pending items and retain a session audit without rewriting source evidence', t => {
  const {d,w,p,click,sheet}=setup(t,'#view=hi&project=selftest&section=base');
  const source=w.eval('JSON.stringify({PERF,RUNS,CFG})');
  assert.equal(d.querySelectorAll('[data-baseline]').length,2);
  click('模拟批准并更新',d.querySelector('[data-baseline="perf"]'));
  click('保留原基线',d.querySelector('[data-baseline="visual"]'));
  assert.match(d.getElementById('view').textContent,/没有待审批项/);
  assert.equal(w.baselineDecision('perf','accepted'),false,'duplicate approval is ignored');
  assert.equal(p.state.baselineProjects.get('selftest').history.length,2);
  click('当前基线',d.querySelector('.subnav'));click('查看 性能');
  assert.match(sheet().textContent,/104 ms/);assert.doesNotMatch(sheet().textContent,/93 ms/);w.closeSheet(false);
  click('审批记录',d.querySelector('.subnav'));assert.equal(d.querySelectorAll('.surface-content tbody tr').length,2);
  assert.equal(w.eval('JSON.stringify({PERF,RUNS,CFG})'),source);
  p.state.project='acme';w.render();assert.doesNotMatch(d.getElementById('view').textContent,/Send 0.01 ETH|104 ms/);
  assert.equal(w.baselineDecision('visual','accepted'),false);
});

test('materials show one section heading and direct actions while explanatory text is on demand', t => {
  const {d,w,p,click,sheet}=setup(t,'#view=as&project=selftest&section=stories');
  assert.equal(d.querySelectorAll('#view h2').length,1);
  assert.equal(d.querySelector('#view h2').textContent,'用户故事');
  assert.doesNotMatch(d.getElementById('view').textContent,/资产 · 产品材料与代码|整理故事节点的联合产物|先选择一次运行/);
  assert.equal(d.querySelectorAll('.story-materials tbody tr').length,22);
  click('页面说明');assert.match(sheet().textContent,/按运行与产品结构查看产物/);w.closeSheet(false);
  click('查看产品文档');assert.match(sheet().textContent,/产品结构/);w.closeSheet(false);
  click('选择运行记录');assert.match(sheet().textContent,/wf-mt0xaw2g/);w.closeSheet(false);
  click('物料',d.getElementById('nav'));click('US-01 项目与目标端');assert.equal(p.state.story,'US-01');assert.ok(d.querySelector('.product-module-map'));
  click('设置',d.getElementById('nav'));assert.equal(d.querySelectorAll('#view h2').length,1);
  click('页面说明');assert.match(sheet().textContent,/配置项目、连接模型/);
});

test('scoreboard shows sourced experiment summaries and explains the actual Penguin extension scope', t => {
  const {d,w,p,click,sheet}=setup(t,'#view=ev&project=selftest&section=current');
  assert.equal(d.querySelectorAll('.evaluation-results tbody tr').length,3);
  assert.ok(d.querySelector('.evaluation-page > details:not([open])'));
  assert.equal([...d.querySelectorAll('button')].find(b=>b.textContent==='正式版本比较').disabled,true);
  const cap=d.querySelector('[aria-label="评测能力"]');cap.value='受控进化';cap.dispatchEvent(new w.Event('change'));
  assert.equal(d.querySelectorAll('.evaluation-results tbody tr').length,1);click('N-21 · 受控进化');
  assert.match(sheet().textContent,/六个计划全部无效/);assert.match(sheet().querySelector('a').href,/evidence\/n-21\/README.md$/);w.closeSheet(false);
  click('PenguinHarness');assert.match(sheet().textContent,/memory：scoped \/ off/);assert.match(sheet().textContent,/通用 Skill 自动改写尚未接入/);
  assert.match(sheet().textContent,/原型未连接服务/);assert.match(sheet().textContent,/跨宿主回归和人工审核/);
  click('查看评测流程',sheet());assert.match(sheet().textContent,/领域知识用于帮助生成/);
  click('1 · Gold 基准',sheet());assert.equal(p.state.evalView,'gold');assert.equal(d.querySelectorAll('.evaluation-page tbody tr').length,16);
  const split=d.querySelector('[aria-label="Gold 数据划分"]');split.value='heldout';split.dispatchEvent(new w.Event('change'));
  assert.equal(d.querySelectorAll('.evaluation-page tbody tr').length,4);
  const search=d.querySelector('[aria-label="搜索 Gold 条目"]');search.value='S-06';search.dispatchEvent(new w.Event('input'));
  assert.equal(d.querySelectorAll('.evaluation-page tbody tr').length,1);
  assert.equal(d.querySelectorAll('.evaluation-page input:not([type="search"]),.evaluation-page textarea').length,0);
  click('如何使用');click('3 · 记分板',sheet());assert.equal(p.state.evalView,'current');
  p.state.project='acme';w.render();assert.match(d.getElementById('view').textContent,/未嵌入评测数据/);
});

test('new report and evaluation controls retain language and theme navigation', t => {
  const {d,w,click}=setup(t,'#view=hi&project=selftest&section=base-current');
  click('EN',d.querySelector('.sidebar-language'));assert.equal(d.querySelector('#view h2').textContent,'Current baselines');
  click('Review history',d.querySelector('.subnav'));assert.equal(d.querySelector('#nav [aria-current="true"]').textContent,'Baselines');
  click('Dark theme');click('Scoreboard',d.getElementById('nav'));
  const cap=d.querySelector('[aria-label="Evaluation capability"]');cap.value='运行记忆';cap.dispatchEvent(new w.Event('change'));
  assert.equal(d.querySelector('.evaluation-results th').textContent,'Experiment');assert.equal(d.documentElement.dataset.theme,'dark');
  click('Gold',d.getElementById('nav'));assert.equal(d.querySelector('#view h2').textContent,'Gold benchmark');
  const split=d.querySelector('[aria-label="Gold data split"]');split.value='heldout';split.dispatchEvent(new w.Event('change'));
  assert.equal(d.querySelector('.evaluation-page th').textContent,'Item');assert.equal(d.querySelectorAll('.evaluation-page tbody tr').length,4);
  click('日',d.querySelector('.sidebar-language'));assert.equal(d.querySelector('#view h2').textContent,'Gold ベンチマーク');
});
