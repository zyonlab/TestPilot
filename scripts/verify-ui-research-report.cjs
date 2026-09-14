// Static and DOM verification only. No browser, requests, services, or models.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { JSDOM, VirtualConsole } = require(process.env.TP_DOM_MODULE || 'jsdom');
const root = path.resolve(__dirname, '..');
const reportPath = path.join(root, 'docs/reports/testpilot-ui-research-review-2026-09-09.html');
const prototypePath = path.join(root, 'docs/reports/testpilot-review-prototype.html');
const out = process.env.TP_REPORT_EVIDENCE_DIR || path.join(root, 'docs/v3/evidence/ui-implementation-plan-2026-09-10');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const errors = [], checks = [];
const vc = new VirtualConsole();vc.on('jsdomError', e => errors.push(String(e)));
const dom = new JSDOM(fs.readFileSync(reportPath, 'utf8'), {url:'https://prototype.test/docs/reports/testpilot-ui-research-review-2026-09-09.html',runScripts:'dangerously',virtualConsole:vc});
const w = dom.window, d = w.document;
function check(name, fn) {fn();checks.push(name);}
function event(node, name) {node.dispatchEvent(new w.Event(name,{bubbles:true}));}
async function verify() {
  const cards = [...d.querySelectorAll('details.task')];
  const source = fs.readFileSync(path.join(root,'docs/v3/13-UI与论文路线任务台账.md'),'utf8');
  const blocks = source.split(/(?=^#### P-\d+ · )/m).slice(1);
  const ids = blocks.map(b=>b.match(/^#### (P-\d+)/)[1]);
  check('28 unique task IDs and required implementation fields',()=>{
    assert.equal(cards.length,28);assert.equal(new Set(ids).size,28);
    assert.deepEqual(cards.map(c=>c.id),ids);
    for(const b of blocks)for(const f of ['状态','依赖','已有基础','兑现','落点','验收','验证'])assert.match(b,new RegExp('^- '+f+'：','m'));
    for (const block of blocks) { const id=block.match(/^#### (P-\d+)/)[1]; const status=block.match(/^- 状态：(\w+)/m)[1]; assert.equal(d.getElementById(id).dataset.status,status,id); }
  });
  check('all task dependencies exist and form a DAG',()=>{
    const dependencies=new Map(blocks.map(b=>[b.match(/^#### (P-\d+)/)[1],b.match(/^- 依赖：(.*)$/m)[1].match(/P-\d+/g)||[]]));
    const visiting=new Set(),seen=new Set();function visit(id){assert.ok(dependencies.has(id),id);assert.ok(!visiting.has(id),'cycle '+id);if(seen.has(id))return;visiting.add(id);dependencies.get(id).forEach(visit);visiting.delete(id);seen.add(id);}ids.forEach(visit);
    assert.ok(!dependencies.get('P-20').includes('P-19'));assert.ok(dependencies.get('P-23').includes('P-26'));
  });
  let hrefCount=0;
  check('local links, image files, and internal anchors resolve',()=>{
    const allIds=[...d.querySelectorAll('[id]')].map(n=>n.id);assert.equal(new Set(allIds).size,allIds.length);
    for(const a of d.querySelectorAll('a[href],img[src]')){
      const href=a.getAttribute('href')||a.getAttribute('src');hrefCount++;
      if(/^https?:\/\//.test(href))continue;
      if(href.startsWith('#'))assert.ok(d.getElementById(decodeURIComponent(href.slice(1))),href);
      else assert.ok(fs.existsSync(path.resolve(path.dirname(reportPath),decodeURIComponent(href.split('#')[0]))),href);
    }
  });
  check('offline report script parses without external resources',()=>{
    for(const s of d.querySelectorAll('script:not([src])'))new vm.Script(s.textContent);
    assert.equal(d.querySelectorAll('script[src],link[rel=stylesheet],iframe').length,0);
    assert.doesNotMatch(d.body.textContent,/\{\{\w+\}\}|查看 24 项实施任务|02 订单模块/);
  });
  const search=d.getElementById('task-search'),state=d.getElementById('task-state');
  check('task text search and no-match count',()=>{
    search.value='workflowOps';event(search,'input');const visible=cards.filter(c=>!c.hidden);assert.ok(visible.length>0&&visible.length<28);assert.ok(visible.every(c=>c.textContent.includes('workflowOps')));
    search.value='does-not-exist-8675309';event(search,'input');assert.equal(d.getElementById('task-count').textContent,'0 / 28 项');
  });
  check('status filter and scoped expand/collapse',()=>{
    search.value='';event(search,'input');state.value='blocked';event(state,'change');assert.deepEqual(cards.filter(c=>!c.hidden).map(c=>c.id),['P-22']);
    d.getElementById('task-expand').click();assert.deepEqual(cards.filter(c=>c.open).map(c=>c.id),['P-22']);d.getElementById('task-collapse').click();assert.equal(cards.filter(c=>c.open).length,0);
  });
  w.history.replaceState(null,'','#P-10');w.dispatchEvent(new w.HashChangeEvent('hashchange'));
  check('task deep link reveals a previously filtered task',()=>{
    assert.equal(state.value,'all');assert.equal(search.value,'');assert.equal(d.getElementById('P-10').open,true);assert.equal(d.activeElement,d.querySelector('#P-10 summary'));assert.equal(cards.filter(c=>c.hidden).length,0);
  });
  check('print expands all task details and restores state',()=>{
    w.dispatchEvent(new w.Event('beforeprint'));assert.equal(cards.every(c=>c.open),true);w.dispatchEvent(new w.Event('afterprint'));assert.deepEqual(cards.filter(c=>c.open).map(c=>c.id),['P-10']);
  });
  let prototypeRoutes=0;
  const links=[...d.querySelectorAll('#walkthrough .flow a,#overview a')].map(a=>a.getAttribute('href')).filter(h=>h.startsWith('testpilot-review-prototype.html#'));
  for(const link of links){
    const pv=new VirtualConsole();pv.on('jsdomError',e=>errors.push(String(e)));
    const pd=new JSDOM(fs.readFileSync(prototypePath,'utf8'),{url:'https://prototype.test/docs/reports/'+link,runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:pv,beforeParse(p){p.alert=()=>{};p.confirm=()=>false;p.URL.createObjectURL=()=> 'blob:test';p.URL.revokeObjectURL=()=>{};}});
    assert.ok(pd.window.TestPilotPrototype);assert.ok(pd.window.document.querySelector('#view').textContent.trim());
    const route=new URLSearchParams(link.split('#')[1]);assert.equal(pd.window.TestPilotPrototype.ui.view,route.get('view'));
    if(route.get('section'))assert.equal(pd.window.TestPilotPrototype.ui[route.get('view')],route.get('section'));
    pd.window.close();prototypeRoutes++;
  }
  checks.push('all linked prototype entry points load their requested surface');
  check('prototype remains identical to prior verified artifact',()=>assert.equal(sha(prototypePath),JSON.parse(fs.readFileSync(path.join(root,'docs/v3/evidence/prototype-surface-review-2026-09-10/checks.json'),'utf8')).artifacts[0].sha256));
  assert.deepEqual(errors,[]);
  const result={validatedAt:new Date().toISOString(),checks,taskCounts:{total:cards.length,...Object.fromEntries(['todo','doing','done','blocked'].map(s=>[s,cards.filter(c=>c.dataset.status===s).length]))},linksChecked:hrefCount,prototypeRoutes,report:{path:path.relative(root,reportPath),bytes:fs.statSync(reportPath).size,sha256:sha(reportPath)},prototype:{unchanged:true,sha256:sha(prototypePath)},scope:{productionBehaviorChanged:false,servicesStarted:false,modelCalls:false,browserVisualValidation:false},errors};
  fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}
verify().then(()=>dom.window.close()).catch(e=>{dom.window.close();console.error(e);process.exitCode=1;});
