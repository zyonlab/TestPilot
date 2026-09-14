#!/usr/bin/env python3
"""Refine the full archived prototype without mutating its historical source."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'docs/archive/spec/09-prototype-workspace.html'
SOURCE = ROOT / 'docs/reports/prototype-src'
OUT = ROOT / 'docs/reports/testpilot-review-prototype.html'


def build():
    original = BASE.read_text()
    spec = (ROOT / 'docs/archive/spec/02-业务规格与用户故事.md').read_text()
    stories = {}
    lines = spec.splitlines()
    for i, line in enumerate(lines):
        match = re.match(r'- \*\*(US-\d+)\*\* (.*)', line)
        if not match:
            continue
        excerpt = [line]
        for following in lines[i + 1:]:
            if following.startswith(('- **US-', '##')):
                break
            excerpt.append(following)
        stories[match[1]] = {'id': match[1], 'text': match[2],
                             'excerpt': '\n'.join(excerpt).strip(), 'line': i + 1}
    # Reuse the application's three-language labels without a runtime dependency.
    text_string = r'"(?:\\.|[^"\\])*"'
    entries = re.findall(r'\{\s*"?zh"?\s*:\s*(' + text_string +
                         r')\s*,\s*"?en"?\s*:\s*(' + text_string +
                         r')\s*,\s*"?ja"?\s*:\s*(' + text_string + r')\s*,?\s*\}',
                         (ROOT / 'src/lib/i18n.ts').read_text())
    translations = {}
    for zh, en, ja in entries:
        translations[json.loads(zh)] = {'en': json.loads(en), 'ja': json.loads(ja)}
    translations.update(json.loads((SOURCE / 'shell-translations.json').read_text()))
    map_css = (SOURCE / 'module-map.css').read_text()
    bench_css = (SOURCE / 'run-bench.css').read_text()
    source_documents = [{'id': name[:2], 'name': name, 'text': (ROOT / 'docs/archive/spec' / name).read_text()} for name in ['02-业务规格与用户故事.md', '03-UI交互规格.md']]
    data = {'stories': stories, 'sourceDocuments': source_documents, 'translations': translations, 'moduleMapCss': map_css, 'baseSha256': hashlib.sha256(BASE.read_bytes()).hexdigest(),
            'base': '../archive/spec/09-prototype-workspace.html', 'revision': '2026-09-10'}
    data_json = json.dumps(data, ensure_ascii=False).replace('<', '\\u003c')
    # Preserve the full original UI, including code, run, baseline and graph inspectors.
    body_start = original.index('<div class="app">')
    head, body = original[:body_start], original[body_start:]
    head = head.replace('<title>TestPilot 工作台</title>', '<title>TestPilot 工作台 · 原版修缮</title>')
    page = ('<!doctype html>\n<html lang="zh-CN"><head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width,initial-scale=1">\n' + head +
            '\n<style id="refinement-style">\n' + (SOURCE / 'refinement.css').read_text() + '\n' + map_css + '\n' + bench_css + '\n' + (SOURCE / 'product-context.css').read_text() + '\n' + (SOURCE / 'surface-review.css').read_text() +
            '\n</style>\n</head><body>\n' + body + '\n<script>\nconst REFINEMENT_DATA = ' +
            data_json + ';\n</script>\n<script id="shell-script">\n' +
            (SOURCE / 'shell.js').read_text() + '\n</script>\n<script id="run-bench-script">\n' +
            (SOURCE / 'run-bench.js').read_text() + '\n</script>\n<script id="product-context-script">\n' +
            (SOURCE / 'product-context.js').read_text() + '\n</script>\n<script id="surface-review-script">\n' +
            (SOURCE / 'surface-review.js').read_text() + '\n</script>\n<script id="refinement-script">\n' +
            (SOURCE / 'refinement.js').read_text() + '\n</script>\n</body></html>\n')
    OUT.write_text(page)
    print(f'Built {OUT.relative_to(ROOT)} ({len(page.encode()):,} bytes; {len(stories)} source stories)')


if __name__ == '__main__':
    build()
