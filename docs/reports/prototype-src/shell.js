/* Sidebar preferences and prototype projects. This module uses no network API. */
const SHELL_KEYS={prefs:'testpilot.prototype.ui.v1',projects:'testpilot.prototype.projects.v1'};
function readShellStorage(key,fallback){try{const value=JSON.parse(localStorage.getItem(key)||'null');return value??fallback;}catch{return fallback;}}
function writeShellStorage(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}}
const SHELL_PREFS=readShellStorage(SHELL_KEYS.prefs,{});
const SHELL_LANGS=[['zh','中','中文'],['en','EN','English'],['ja','日','日本語']];
const SHELL_ICONS={
  home:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M10 6h7v8M6 10v7h8"/>',
  history:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  review:'<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2M8 12l3 3 5-6"/>',
  files:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5"/>',
  report:'<path d="M4 3v18h17M8 16v-4M13 16V7M18 16v-7"/>',
  baseline:'<path d="M3 18h18M5 13l4-5 5 3 5-7"/>',
  score:'<path d="M4 20h16M6 16V9M12 16V4M18 16v-5"/>',
  gold:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
  settings:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  collapse:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18m7-13-4 4 4 4"/>',
  expand:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18m4-13 4 4-4 4"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon:'<path d="M20.5 13a8.5 8.5 0 0 1-9.5-9.5A8.5 8.5 0 1 0 20.5 13z"/>',
  globe:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  project:'<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  chevron:'<path d="m8 14 4-4 4 4"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3v.1"/>',
};
function shellIcon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('class','shell-icon');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.7');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');svg.innerHTML=SHELL_ICONS[name]||SHELL_ICONS.files;return svg;}
function tShell(text){
  if(R.language==='zh')return text;const direct=REFINEMENT_DATA.translations[text]?.[R.language];if(direct)return direct;
  if(text.includes(' / '))return text.split(' / ').map(tShell).join(' / ');
  if(text.includes(' · '))return text.split(' · ').map(tShell).join(' · ');
  const version=text.match(/^(工作副本|执行版本) (v\d+)$/);if(version)return tShell(version[1])+' '+version[2];
  const count=text.match(/^(\d+) (个模块|个故事|个关联故事|条样例用例)$/);if(count){const nouns={'个模块':['modules','モジュール'],'个故事':['stories','ストーリー'],'个关联故事':['linked stories','関連ストーリー'],'条样例用例':['sample cases','サンプルケース']};return count[1]+' '+nouns[count[2]][R.language==='en'?0:1];}
  return text;
}
const SHELL_TEXT=new WeakMap(),SHELL_ATTRS=new WeakMap();
function localizeUI(root=document){
  const skip='script,style,pre,code,textarea,[data-material],.source-excerpt,.steps,.case-excerpt,.sample,.queue-case strong,.queue-id,.case-detail-heading h2,.case-detail-body .detail-section p,#proj option';
  const walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
  while(node=walk.nextNode()){
    if(!node.parentElement||node.parentElement.closest(skip)||!node.nodeValue.trim())continue;
    const old=SHELL_TEXT.get(node),source=old&&node.nodeValue===old.output?old.source:node.nodeValue;
    const trimmed=source.trim(),translated=tShell(trimmed),output=source.replace(trimmed,translated);SHELL_TEXT.set(node,{source,output});node.nodeValue=output;
  }
  for(const el of root.querySelectorAll?.('[title],[aria-label],[placeholder]')||[]){if(el.closest('[data-material]'))continue;const originals=SHELL_ATTRS.get(el)||{};for(const attr of ['title','aria-label','placeholder']){if(!el.hasAttribute(attr))continue;const now=el.getAttribute(attr),prior=originals[attr],source=prior&&now===prior.output?prior.source:now,output=tShell(source);originals[attr]={source,output};el.setAttribute(attr,output);}SHELL_ATTRS.set(el,originals);}
  document.documentElement.lang=R.language==='zh'?'zh-CN':R.language;
}
function persistShellPrefs(){writeShellStorage(SHELL_KEYS.prefs,{collapsed:R.sidebarCollapsed,language:R.language,theme:R.theme});}
function setUILanguage(lang){if(!SHELL_LANGS.some(x=>x[0]===lang))return;closeShellPopover();R.language=lang;CFG.lang=lang;persistShellPrefs();render();localizeUI(document);}
function toggleShellTheme(){R.theme=R.theme==='light'?'dark':'light';document.documentElement.dataset.theme=R.theme;persistShellPrefs();renderSidebarChrome();}
function initialProjects(){
  const defaults=[{id:'selftest',name:'TestPilot 自举',url:'http://localhost:5300',platform:'web',materials:[]},{id:'acme',name:'Acme Portal',url:'',platform:'web',materials:[]}];
  const saved=readShellStorage(SHELL_KEYS.projects,[]);if(!Array.isArray(saved))return defaults;
  for(const p of saved){if(!p||typeof p.id!=='string'||!p.id.startsWith('project-')||defaults.some(x=>x.id===p.id)||typeof p.name!=='string'||!p.name.trim()||typeof p.url!=='string'||!['web','ios','android'].includes(p.platform))continue;defaults.push({id:p.id,name:p.name.slice(0,80),url:p.url,platform:p.platform,materials:Array.isArray(p.materials)?p.materials.filter(x=>typeof x==='string'):[]});}return defaults;
}
function currentProject(){return R.projects.find(p=>p.id===R.project);}
function projectName(){return currentProject()?.name||R.project;}
function persistProjects(){return writeShellStorage(SHELL_KEYS.projects,R.projects.filter(p=>p.id.startsWith('project-')));}
function selectProject(id){
  if(!R.projects.some(p=>p.id===id))return;closeShellPopover();R.project=id;R.productNode=null;R.module=R.story=R.caseId=null;R.query='';R.filter='all';R.caseFilters={tier:'',method:''};R.picked.clear();R.selected.clear();R.runId=null;R.benchRunId=null;S.bp.clear();setWorkflowSource(productWorkspace().input.kind,false);R.runQuery='';R.runKind='all';R.reviewScope={module:null,story:null};R.reviewQuery='';R.reviewFilter='all';S.ctx=null;S.msgs=[];S.view='ws';R.workView='workflow';R.batchMode=false;R.assistantOpen=false;closeSheet(false);render();
}
function iconButton(label,icon,action,cls='sidebar-icon-button'){const b=button('',action,cls);b.append(shellIcon(icon));b.setAttribute('aria-label',tShell(label));b.title=tShell(label);return b;}
let shellPopoverAnchor=null;
function closeShellPopover(focus=false){document.querySelector('.shell-popover')?.remove();const anchor=shellPopoverAnchor;if(anchor)anchor.setAttribute('aria-expanded','false');shellPopoverAnchor=null;if(focus)anchor?.focus();}
function openShellPopover(anchor,kind){
  if(shellPopoverAnchor===anchor){closeShellPopover(true);return;}closeShellPopover();shellPopoverAnchor=anchor;anchor.setAttribute('aria-expanded','true');
  const pop=el('div','shell-popover');pop.setAttribute('role','menu');pop.setAttribute('aria-label',tShell(kind==='projects'?'切换项目':'切换语言'));pop.dataset.kind=kind;
  const entries=kind==='projects'?R.projects.map(p=>[p.id,p.name,()=>selectProject(p.id),p.id===R.project]):SHELL_LANGS.map(([id,,name])=>[id,name,()=>setUILanguage(id),id===R.language]);
  for(const [id,label,action,selected] of entries){const b=button(label,action,'popover-option');b.dataset.value=id;b.dataset.material='';b.setAttribute('role','menuitemradio');b.setAttribute('aria-checked',String(selected));pop.append(b);}
  if(kind==='projects'){const add=button(tShell('添加新项目'),()=>{closeShellPopover();openNewProject();},'popover-add');add.setAttribute('role','menuitem');add.prepend(shellIcon('plus'));pop.append(add);}
  $('.sidebar-controls').append(pop);pop.querySelector('[aria-checked="true"]')?.focus();
  pop.onkeydown=e=>{const buttons=[...pop.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();}if(e.key==='Escape'){e.preventDefault();closeShellPopover(true);}if(e.key==='Tab')closeShellPopover();};
}
function renderSidebarChrome(){
  const app=$('.app'),head=$('.sidebar-head'),controls=$('.sidebar-controls');if(!head||!controls)return;
  app.classList.toggle('sidebar-collapsed',R.sidebarCollapsed);head.replaceChildren();
  const brand=el('div','brand');brand.append(el('i'),el('span','brand-name','TestPilot'));head.append(brand);
  const toggle=iconButton(R.sidebarCollapsed?'展开侧栏':'收起侧栏',R.sidebarCollapsed?'expand':'collapse',()=>{closeShellPopover();R.sidebarCollapsed=!R.sidebarCollapsed;persistShellPrefs();renderSidebarChrome();$('#sidebar-toggle').focus();});toggle.id='sidebar-toggle';toggle.setAttribute('aria-expanded',String(!R.sidebarCollapsed));toggle.setAttribute('aria-controls','nav');head.append(toggle);
  closeShellPopover();controls.replaceChildren();const prefs=el('div','sidebar-preferences');
  const langs=el('div','sidebar-language');langs.setAttribute('aria-label',tShell('界面语言'));for(const [id,label,name] of SHELL_LANGS){const b=button(label,()=>setUILanguage(id),'');b.title=name;b.setAttribute('aria-label',name);b.dataset.lang=id;b.setAttribute('aria-pressed',String(R.language===id));langs.append(b);}prefs.append(langs);
  const langIcon=iconButton('切换语言','globe',()=>openShellPopover(langIcon,'language'),'sidebar-icon-button collapsed-language');langIcon.setAttribute('aria-haspopup','menu');langIcon.setAttribute('aria-expanded','false');prefs.append(langIcon,iconButton(R.theme==='light'?'深色':'浅色',R.theme==='light'?'moon':'sun',toggleShellTheme));
  const help=link('', 'testpilot-ui-research-review-2026-09-09.html');help.append(shellIcon('help'));help.className='sidebar-icon-button sidebar-help';help.title=tShell('评审文档');help.setAttribute('aria-label',tShell('评审文档'));prefs.append(help);controls.append(prefs);
  const project=el('div','sidebar-project'),label=el('label',null,tShell('当前项目'));label.htmlFor='proj';project.append(label);
  const select=el('select');select.id='proj';select.setAttribute('aria-label',tShell('当前项目'));for(const p of R.projects)select.append(new Option(p.name,p.id));const group=el('optgroup');group.label=tShell('项目管理');group.append(new Option('+ '+tShell('添加新项目'),'__new_project__'));select.append(group);select.value=R.project;
  select.onchange=()=>{if(select.value==='__new_project__'){select.value=R.project;openNewProject();}else selectProject(select.value);};project.append(select);
  const picker=iconButton('切换项目','project',()=>openShellPopover(picker,'projects'),'sidebar-icon-button collapsed-project');picker.id='project-picker';picker.title=tShell('切换项目')+' · '+projectName();picker.setAttribute('aria-label',tShell('切换项目')+' · '+projectName());picker.setAttribute('aria-haspopup','menu');picker.setAttribute('aria-expanded','false');project.append(picker);controls.append(project);
}
function validProjectValues(name,url,exceptId){
  if(!name.trim())return '请填写项目名称';if(R.projects.some(p=>p.id!==exceptId&&p.name.toLocaleLowerCase()===name.trim().toLocaleLowerCase()))return '项目名称已存在';
  try{const parsed=new URL(url.trim());if(!['http:','https:'].includes(parsed.protocol)||!parsed.hostname)throw Error();}catch{return '请填写有效的 HTTP 或 HTTPS 入口地址';}return '';
}
function projectForm(initial,onSave,submitLabel){
  const form=el('form','project-form');form.noValidate=true;
  const name=field('项目名称',initial.name,null,{placeholder:'例如：客户服务平台'}),url=field('入口地址',initial.url,null,{placeholder:'https://example.com'}),materials=field('规格材料（可选）',(initial.materials||[]).join('\n'),null,{multiline:true,placeholder:'文件路径或文档名称，每行一项'});
  const nameInput=name.querySelector('input'),urlInput=url.querySelector('input');nameInput.maxLength=80;nameInput.required=true;urlInput.type='url';urlInput.required=true;urlInput.autocomplete='url';
  const platform=el('div','field'),label=el('label',null,'目标端'),select=el('select');select.id='project-platform';label.htmlFor=select.id;[['web','Web'],['ios','iOS'],['android','Android']].forEach(([v,l])=>select.append(new Option(l,v)));select.value=initial.platform||'web';platform.append(label,select);
  const error=el('div','form-error');error.id='project-form-error';error.setAttribute('role','alert');const actions=el('div','detail-footer');const save=button(submitLabel,()=>{},'primary');save.type='submit';save.onclick=null;actions.append(save);form.append(name,url,platform,materials,error,actions);
  form.onsubmit=e=>{e.preventDefault();for(const field of [nameInput,urlInput]){field.removeAttribute('aria-invalid');field.removeAttribute('aria-describedby');}error.textContent='';const issue=validProjectValues(nameInput.value,urlInput.value,initial.id);if(issue){error.textContent=tShell(issue);const invalid=issue.includes('地址')?urlInput:nameInput;invalid.setAttribute('aria-invalid','true');invalid.setAttribute('aria-describedby',error.id);invalid.focus();return;}nameInput.removeAttribute('aria-invalid');urlInput.removeAttribute('aria-invalid');onSave({name:nameInput.value.trim(),url:new URL(urlInput.value.trim()).href,platform:select.value,materials:materials.querySelector('textarea').value.split('\n').map(s=>s.trim()).filter(Boolean)});};return form;
}
function openNewProject(){
  closeShellPopover();sheet('添加新项目',b=>{const form=projectForm({name:'',url:'',platform:'web',materials:[]},data=>{const id='project-'+Date.now().toString(36)+'-'+R.projects.length;R.projects.push({id,...data});const saved=persistProjects();selectProject(id);toast(tShell(saved?'项目已创建并保存到本地原型':'项目已创建；当前环境仅保留本次会话'));},'创建项目');form.querySelector('.detail-footer').append(button('取消',()=>closeSheet(),''));b.append(el('p','sub','填写项目入口，创建后可继续配置环境与导入材料。'),form,el('p','records-note','项目保存在此浏览器原型中。'));});$('#sheet .project-form input')?.focus();
}
function projectTargetForm(){const project=currentProject();const b=el('div','box');if(!project)return b;b.append(projectForm(project,values=>{Object.assign(project,values);persistProjects();render();toast(tShell('项目设置已保存'));},'保存项目设置'));return b;}
function renderProjectEmpty(){
  const p=currentProject(),box=el('div','project-empty');box.append(el('span','project-empty-label',tShell('项目工作台')),el('h1',null,projectName()),el('p',null,tShell('尚未导入材料')));box.querySelector('h1').dataset.material='';
  if(p?.url){const info=el('div','project-target');info.dataset.material='';info.append(el('span','chip',p.platform),el('span',null,p.url));box.append(info);}
  if(p?.materials.length){const list=el('ul','project-material-list');list.dataset.material='';p.materials.forEach(item=>list.append(el('li',null,item)));box.append(el('h3',null,tShell('已登记的规格材料')),list,el('p','records-note',tShell('材料清单已保存，尚未读取或生成用例。')));}
  const actions=el('div','toolbar-actions');actions.append(button('配置项目',()=>goTo('st','target'),'primary'),button('选择运行记录',openWorkflowRuns,''));box.append(actions);return box;
}
function initSidebar(){
  const sidebar=$('.app-sidebar');sidebar.replaceChildren();const head=el('div','sidebar-head'),nav=el('nav','nav'),controls=el('div','sidebar-controls');nav.id='nav';sidebar.append(head,nav,controls);renderSidebarChrome();
  document.addEventListener('pointerdown',e=>{if(shellPopoverAnchor&&!e.target.closest('.shell-popover')&&!shellPopoverAnchor.contains(e.target))closeShellPopover();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&shellPopoverAnchor){e.preventDefault();closeShellPopover(true);}});
}
