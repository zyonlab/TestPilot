#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build an offline review report from the current versioned implementation documents.
No network, external fonts, Markdown dependency, model calls or project-data writes.
The small renderer supports the subset used in these documents (headings, lists,
tables, fences, inline code/bold/links). Content is escaped before rendering.
"""
from pathlib import Path
import re
import html
import os

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs/reports/testpilot-ui-research-review-2026-09-09.html'
DOCS = [
    ('codex-acceptance', 'Codex 宿主真实验收', '19-Codex宿主Hyperliquid实测.md'),
    ('implementation', '本地实施与真实验收', '18-本地UI重构与Hyperliquid验收.md'),
    ('tasks', '本地实施任务与验收', '13-UI与论文路线任务台账.md'),
    ('design', '当前 UI 与用户故事', '11-WebUI全流程评审与产品设计.md'),
    ('product-model', '产品结构、来源与知识', '16-产品结构与多入口知识契约.md'),
    ('evaluation-guide', '报告、基线与评测使用', '17-报告基线与评测职责.md'),
    ('research', '论文与受控自进化', '12-论文级研究与受控自进化.md'),
    ('install', 'Claude / Codex 安装', '14-Claude-Code与Codex接入实操.md'),
]
doc_anchors = {name: '#' + ident for ident, _, name in DOCS}

def link_target(url, source):
    if re.match(r'^(https?://|#)', url):
        return url
    if url in doc_anchors:
        return doc_anchors[url]
    return os.path.relpath((source.parent / url).resolve(), OUT.parent)

def inline(text, source):
    tokens = []
    def hold(value):
        tokens.append(value)
        return '\x00' + str(len(tokens) - 1) + '\x00'
    text = re.sub(r'`([^`]+)`', lambda m: hold('<code>' + html.escape(m[1]) + '</code>'), text)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', lambda m: hold('<a href="' + html.escape(link_target(m[2], source), quote=True) + '">' + html.escape(m[1]) + '</a>'), text)
    text = html.escape(text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    return re.sub('\x00(\d+)\x00', lambda m: tokens[int(m[1])], text)

def render(source, ident):
    lines = source.read_text().splitlines()
    out, toc = [], []
    i = 0
    task_open = False
    while i < len(lines):
        s = lines[i]
        if task_open and re.match(r'^#{1,4} ', s):
            out.append('</div></details>'); task_open = False
        if not s.strip():
            i += 1
            continue
        if s.startswith('```'):
            lang = s[3:].strip()
            code = []
            i += 1
            while i < len(lines) and not lines[i].startswith('```'):
                code.append(lines[i]); i += 1
            out.append('<pre aria-label="' + html.escape(lang) + '"><code>' + html.escape('\n'.join(code)) + '</code></pre>')
        elif s.startswith('# '):
            pass  # Section title is supplied by the report shell.
        elif ident == 'tasks' and re.match(r'^#### P-\d+ · ', s):
            task_id, title = s[5:].split(' · ', 1)
            task = task_by_id[task_id]
            status = task['status']
            label = STATUS_LABELS.get(status, status)
            out.append('<details class="task" id="' + task_id + '" data-status="' + status + '"><summary><code>' + task_id + '</code><span>' + html.escape(title) + '</span><b class="task-status">' + label + '</b></summary><div class="task-body">')
            task_open = True
        elif re.match(r'^#{2,4} ', s):
            hashes, title = s.split(' ', 1)
            anchor = ident + '-' + str(len(toc) + 1)
            level = min(len(hashes) + 1, 5)
            toc.append((anchor, title, len(hashes)))
            out.append(f'<h{level} id="{anchor}">' + inline(title, source) + f'</h{level}>')
        elif s.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                row = lines[i]
                if not re.fullmatch(r'[| :\-]+', row):
                    rows.append([v.strip() for v in row.strip('|').split('|')])
                i += 1
            i -= 1
            out.append('<div class="tablewrap"><table>')
            for n, row in enumerate(rows):
                tag = 'th' if n == 0 else 'td'
                if n == 0: out.append('<thead>')
                elif n == 1: out.append('<tbody>')
                out.append('<tr>' + ''.join(f'<{tag}>' + inline(v, source) + f'</{tag}>' for v in row) + '</tr>')
                if n == 0: out.append('</thead>')
            if len(rows) > 1: out.append('</tbody>')
            out.append('</table></div>')
        elif s.startswith('- '):
            out.append('<ul>')
            while i < len(lines) and lines[i].startswith('- '):
                out.append('<li>' + inline(lines[i][2:], source) + '</li>'); i += 1
            i -= 1
            out.append('</ul>')
        else:
            para = [s]; i += 1
            while i < len(lines) and lines[i].strip() and not re.match(r'^(#|\||```|- )', lines[i]):
                para.append(lines[i]); i += 1
            i -= 1
            out.append('<p>' + inline(' '.join(para), source) + '</p>')
        i += 1
    if task_open: out.append('</div></details>')
    links = ''.join('<a href="#' + a + '">' + html.escape(t) + '</a>' for a,t,l in toc if l == 2)
    return '<div class="chapter-toc">' + links + '</div>' + '\n'.join(out)

css = '''
:root{--bg:#f7f6f1;--white:#fff;--ink:#233e38;--muted:#68736b;--green:#176559;--line:#d8ded5;--amber:#93611e}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:25px}body{margin:0;color:var(--ink);background:var(--bg);font:15px/1.85 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}a{color:var(--green);text-underline-offset:4px}a:focus-visible,button:focus-visible{outline:3px solid #c59345;outline-offset:5px}.layout{display:grid;grid-template-columns:235px minmax(0,1fr)}.rail{padding:34px 24px;position:sticky;top:0;height:100vh;border-right:1px solid var(--line);background:#eef1e9;display:flex;flex-direction:column}.wordmark{font-size:24px;letter-spacing:-1px;font-weight:750}.small{font-size:12px;color:var(--muted)}.rail nav{margin-top:36px;display:grid;gap:6px}.rail nav a{padding:10px 6px;text-decoration:none;color:var(--ink)}.rail nav a:hover{background:#e0e9dd}.rail footer{margin-top:auto;font-size:12px;color:var(--muted)}main{min-width:0;padding:48px 5vw 80px;max-width:1480px}.eyebrow{font-size:12px;letter-spacing:2px;color:var(--green);text-transform:uppercase}h1{font-size:clamp(34px,4.2vw,57px);font-weight:630;letter-spacing:-2px;line-height:1.18;margin:20px 0 23px;max-width:1000px}h2{font-size:29px;letter-spacing:-.8px;line-height:1.4;margin:0 0 12px}h3{font-size:22px;margin:38px 0 13px;line-height:1.45}h4,h5{font-size:17px;margin:28px 0 12px}.intro{font-size:18px;color:var(--muted);max-width:960px;line-height:1.8}.label{border:1px solid #cdd9cd;background:#eaf1e5;color:var(--green);padding:4px 9px;font-size:12px;border-radius:4px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.button{display:inline-block;text-decoration:none;border:1px solid var(--green);border-radius:5px;padding:11px 17px;font-size:14px;background:var(--green);color:white}.button.secondary{background:transparent;color:var(--green)}.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:23px;margin:34px 0}.fact{border-top:2px solid var(--green);padding-top:18px}.fact strong{display:block;font-size:21px;margin-bottom:7px}.fact p{font-size:14px;color:var(--muted);margin:0}.callout{border-left:4px solid #c18a37;background:#f7eddc;padding:20px 24px;margin:26px 0}.callout p{margin:5px 0}.chapter{padding-top:45px;margin-top:45px;border-top:1px solid var(--line)}.chapter-toc{display:flex;flex-wrap:wrap;gap:8px 18px;padding:18px 0;font-size:12px;border-bottom:1px solid var(--line)}.chapter-toc a{text-decoration:none}.chapter p,.chapter li{max-width:1120px}li{margin:7px 0}.tablewrap{overflow-x:auto;margin:20px 0;border:1px solid var(--line);background:white;border-radius:5px}table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.75}th,td{padding:14px 16px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;min-width:115px}th{background:#edf1e8;font-weight:600}tr:last-child td{border-bottom:0}code{font:12px/1.65 ui-monospace,SFMono-Regular,monospace;background:#e9eee5;padding:2px 5px;border-radius:3px;overflow-wrap:anywhere}pre{background:#1f3933;color:#e9eee6;padding:21px;overflow:auto;font-size:12px;border-radius:6px}pre code{background:transparent;color:inherit;padding:0}.screens{display:grid;grid-template-columns:repeat(3,1fr);gap:17px;margin:24px 0}.screens figure{margin:0}.screens img{width:100%;aspect-ratio:1/1;object-fit:cover;object-position:top;border:1px solid var(--line);border-radius:5px}.screens figcaption{font-size:12px;color:var(--muted);line-height:1.7;margin-top:9px}.flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:24px 0}.flow a{display:block;border:1px solid var(--line);padding:17px 13px;background:white;text-decoration:none;border-radius:5px}.flow small{display:block;font-size:11px;margin-top:5px;color:var(--muted)}.layers{display:grid;gap:9px;margin-top:24px}.layers div{padding:17px 20px;background:white;border-left:4px solid var(--green)}.layers strong{display:inline-block;min-width:145px;font-size:14px}.layers span{font-size:13px;color:var(--muted)}.caption{font-size:12px;color:var(--muted)}.end{margin-top:60px;font-size:12px;color:var(--muted)}@media(max-width:1000px){.layout{grid-template-columns:1fr}.rail{position:static;height:auto;padding:18px 22px}.rail nav{display:flex;flex-wrap:wrap;margin-top:12px;gap:0 18px}.rail footer{display:none}main{padding:32px 22px}.screens{grid-template-columns:1fr 1fr}.flow{grid-template-columns:repeat(3,1fr)}}@media(max-width:620px){.facts,.screens{grid-template-columns:1fr}.flow{grid-template-columns:1fr 1fr}.intro{font-size:16px}h1{letter-spacing:-1px}.layers strong{display:block}th,td{padding:11px;min-width:140px}}@media print{.rail,.button,.chapter-toc{display:none}.layout{display:block}main{padding:0;max-width:none}body{background:white;color:#111;font-size:11px}.chapter{break-before:page}h1{font-size:35px}table{font-size:10px}.tablewrap{overflow:visible}.screens{grid-template-columns:repeat(3,1fr)}a{color:inherit}pre{white-space:pre-wrap}.callout,.fact,figure{break-inside:avoid}}
'''

STATUS_LABELS = {'todo':'待实施', 'doing':'进行中', 'done':'已验收', 'blocked':'待外部条件', 'dropped':'已取消'}
task_doc = ROOT / 'docs/v3/13-UI与论文路线任务台账.md'
task_text = task_doc.read_text()
tasks = []
for match in re.finditer(r'^#### (P-\d+) · ([^\n]+)\n(.*?)(?=^#{2,4} |\Z)', task_text, re.M | re.S):
    task_id, title, body = match.groups()
    state = re.search(r'^- 状态：(\S+)', body, re.M)
    dep = re.search(r'^- 依赖：(.+)', body, re.M)
    tasks.append({'id':task_id, 'title':title, 'status':state[1] if state else 'todo', 'deps':re.findall(r'P-\d+', dep[1]) if dep else []})
task_by_id = {task['id']:task for task in tasks}
if len(task_by_id) != len(tasks): raise ValueError('Duplicate task IDs')
visited, visiting = set(), set()
def validate_task(task_id):
    if task_id not in task_by_id: raise ValueError('Unknown dependency: ' + task_id)
    if task_id in visiting: raise ValueError('Cyclic task dependency: ' + task_id)
    if task_id in visited: return
    visiting.add(task_id)
    for dep in task_by_id[task_id]['deps']: validate_task(dep)
    visiting.remove(task_id); visited.add(task_id)
for task_id in task_by_id: validate_task(task_id)
hero = (ROOT / 'docs/reports/report-src/ui-research-overview.html').read_text()
for key, value in {'task_count':len(tasks), 'doing_count':sum(t['status']=='doing' for t in tasks), 'done_count':sum(t['status']=='done' for t in tasks), 'todo_count':sum(t['status']=='todo' for t in tasks), 'blocked_count':sum(t['status']=='blocked' for t in tasks)}.items():
    hero = hero.replace('{{' + key + '}}', str(value))
css += """
.rail{overflow-y:auto}.rail nav{margin-top:22px;gap:1px}.rail nav a{padding:7px 6px}.rail footer{padding-top:22px}.archive{margin-top:24px}.archive summary,.task summary{cursor:pointer}.task{margin:12px 0;border:1px solid var(--line);border-radius:6px;background:var(--white)}.task summary{display:flex;align-items:center;gap:12px;padding:16px}.task summary:before{content:'＋';color:var(--green)}.task[open] summary:before{content:'−'}.task summary span{flex:1;font-size:15px}.task summary code{font-size:13px}.task-status{font-size:11px;font-weight:500;color:var(--muted);white-space:nowrap}.task[data-status=blocked] .task-status{color:var(--amber)}.task-body{padding:0 20px 12px;border-top:1px solid var(--line)}.task-tools{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:22px}.task-tools input,.task-tools select{font:inherit;border:1px solid var(--line);border-radius:5px;padding:8px;background:white;color:var(--ink)}.task-tools input{min-width:200px;flex:1}.task-tools button{font:inherit;padding:7px 10px;background:transparent;border:1px solid var(--line);border-radius:5px;color:var(--green);cursor:pointer}#task-count{font-size:12px;color:var(--muted)}[hidden]{display:none!important}.task:target{border-color:var(--green)}.task summary:focus-visible,summary:focus-visible{outline:3px solid #c59345;outline-offset:2px}@media(max-width:620px){.task summary{flex-wrap:wrap;padding:12px}.task summary span{min-width:65%}.task-tools input{width:100%}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media print{.task-tools{display:none}.task-body{display:block!important}.task[hidden]{display:block!important}.task summary:before{display:none}}
"""
task_tools = '<div class="task-tools"><input type="search" id="task-search" aria-label="搜索实施任务" placeholder="搜索任务、代码文件或验收条件"><select id="task-state" aria-label="筛选任务状态"><option value="all">全部状态</option>' + ''.join('<option value="'+k+'">'+v+'</option>' for k,v in STATUS_LABELS.items()) + '</select><button id="task-expand" type="button">展开匹配任务</button><button id="task-collapse" type="button">收起任务</button><span id="task-count" role="status"></span></div>'
parts = []
for ident, title, name in DOCS:
    src = ROOT / 'docs/v3' / name
    parts.append('<section class="chapter" id="' + ident + '"><div class="eyebrow">' + ident.upper() + '</div><h2>' + title + '</h2><p class="caption">对应接手文档：<a href="../v3/' + name + '">' + name + '</a></p>' + (task_tools if ident=='tasks' else '') + render(src, ident) + '</section>')
nav = '<a href="#overview">实施概览</a><a href="#walkthrough">当前 UI 路径</a><a href="#architecture">代码分层</a>' + ''.join('<a href="#' + ident + '">' + title + '</a>' for ident,title,_ in DOCS)
script = """
const taskCards=[...document.querySelectorAll('details.task')], taskSearch=document.getElementById('task-search'), taskState=document.getElementById('task-state');
function filterTasks(){let count=0;for(const card of taskCards){card.hidden=!(card.textContent.toLowerCase().includes(taskSearch.value.trim().toLowerCase())&&(taskState.value==='all'||card.dataset.status===taskState.value));if(!card.hidden)count++;}document.getElementById('task-count').textContent=count+' / '+taskCards.length+' 项';}
taskSearch.addEventListener('input',filterTasks);taskState.addEventListener('change',filterTasks);
document.getElementById('task-expand').onclick=()=>taskCards.filter(t=>!t.hidden).forEach(t=>t.open=true);
document.getElementById('task-collapse').onclick=()=>taskCards.forEach(t=>t.open=false);
function revealTask(){const target=document.getElementById(decodeURIComponent(location.hash.slice(1)));if(target?.matches('details.task')){taskSearch.value='';taskState.value='all';filterTasks();target.open=true;target.querySelector('summary').focus({preventScroll:true});target.scrollIntoView?.({block:'start'});}}
window.addEventListener('hashchange',revealTask);document.addEventListener('click',e=>{if(e.target.closest('a[href^="#P-"]'))setTimeout(revealTask,0);});
let printState=[];window.addEventListener('beforeprint',()=>{printState=taskCards.map(t=>t.open);taskCards.forEach(t=>t.open=true);});window.addEventListener('afterprint',()=>taskCards.forEach((t,i)=>t.open=printState[i]||false));
filterTasks();revealTask();
"""
OUT.write_text('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TestPilot · 当前 UI 与本地实施计划</title><style>' + css + '</style></head><body><div class="layout"><aside class="rail"><div class="wordmark">TestPilot</div><div class="small">UI / LOCAL CODE / RESEARCH</div><nav aria-label="报告目录">' + nav + '</nav><footer>2026-09-10 当前实施基线<br>P 台账是新任务状态源<br><a href="history/testpilot-ui-research-review-2026-09-10-before-implementation-plan.html">修改前报告</a></footer></aside><main>' + hero + ''.join(parts) + '<p class="end">由 scripts/build-ui-research-report.py 从版本化文档构建，可离线阅读。生产代码增量实施按 P 台账推进；验证见 <a href="../v3/evidence/ui-implementation-plan-2026-09-10/README.md">本轮检查</a>。</p></main></div><script>' + script + '</script></body></html>')
print(str(OUT) + ' (' + str(len(tasks)) + ' tasks; dependencies validated)')
