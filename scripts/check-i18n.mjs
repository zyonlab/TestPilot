#!/usr/bin/env node
/**
 * 界面里引用的每一个文案 key，字典里都得有。
 *
 * 为什么值得一个脚本：`translate()` 找不到 key 时回落到 key 本身，于是漏掉一条词条
 * 不会报错、不会崩溃，只会在界面上印出 `artifact.oracle.text` 这样一串东西——
 * 而它长得像一个正常的技术标签，评审时很容易被当成「本来就这样」滑过去。
 * 实测：这一轮加机器判据时就漏了九条，是截图上看出来的，不是编译器。
 *
 * 只检查**字面量** key。`t(\`gate.${rule}.msg\`)` 这种拼出来的检查不了，
 * 那种地方靠 `hasKey()` 在运行时兜底，是另一套办法。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const i18n = readFileSync(join(ROOT, "src/lib/i18n.ts"), "utf8");
const known = new Set([...i18n.matchAll(/^ {2}"([^"]+)":\s*\{/gm)].map((m) => m[1]));
if (known.size < 100) {
  console.error(`[i18n] 只解析出 ${known.size} 条词条——词条的写法多半变了，这个检查已经失效`);
  process.exit(2);
}

/** `t("key")` / `tr("key")` / `tOutsideReact("key")` / `translate("key"` 里的字面量。 */
const CALL = /\b(?:t|tr|tOutsideReact|translate)\(\s*(["'])([a-zA-Z][\w.]*)\1/g;
const missing = [];
for (const file of walk(join(ROOT, "src"))) {
  if (file.endsWith("src/lib/i18n.ts")) continue;
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(CALL)) {
    const key = m[2];
    // 一个不带点的字符串多半不是文案 key（`t("zh")` 之类），跳过。
    if (!key.includes(".")) continue;
    if (!known.has(key)) missing.push(`${file.slice(ROOT.length)}  ${key}`);
  }
}

if (missing.length) {
  console.error(`[i18n] ${missing.length} 个 key 在字典里找不到：`);
  for (const m of [...new Set(missing)].sort()) console.error("  " + m);
  console.error("\n界面上它们会原样印出 key 本身，看起来像个技术标签，评审时很容易滑过去。");
  process.exit(1);
}

/** 同一个 key 写了两遍：后一条静默覆盖前一条，改前一条永远没反应。 */
const counts = new Map();
for (const m of i18n.matchAll(/^ {2}"([^"]+)":\s*\{/gm))
  counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
const dupes = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
if (dupes.length) {
  console.error(`[i18n] 重复的 key：${dupes.join(", ")}`);
  process.exit(1);
}

console.log(`[i18n] ${known.size} 条词条，引用全部命中`);
