/**
 * 《重构手册》里的每一处 `file:line`，打开一次看它还在不在。
 *
 * 手册的撰写流程本来是「起草 → 逐条核对并重写」两步，而核对那一步撞上过配额上限，
 * 九章的行号从没被第二双眼睛打开过。这个脚本是那双眼睛，而且它每次都能再看一遍——
 * 一个指错地方的行号比没有行号更糟：它让读的人以为是自己找错了。
 *
 * 判据只有两条，都刻意保守：
 * ① 文件还在不在（按路径片段有序匹配，因为手册写的是短名）；
 * ② 行号在不在文件长度之内。
 *
 * 不判「这一行是不是还在说手册说的那件事」——那需要读懂两边，机器给不出可信的答案，
 * 而一个会误报的检查最后会被人关掉。
 *
 *   node scripts/check-doc-refs.mjs [docs/archive/refactor/*.md]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const ROOT = process.cwd();
const SKIP = new Set(["node_modules", ".git", "dist", "midscene_run", "coverage"]);

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".data")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx|mjs|json|md)$/.test(name)) files.push(relative(ROOT, full));
  }
})(ROOT);

/** `agent/main.ts` 认得出 `apps/agent/src/main.ts`：片段有序包含，且文件名一致。 */
const candidates = (rel) => {
  const want = rel.split("/");
  return files.filter((f) => {
    const segs = f.split("/");
    let i = 0;
    for (const s of segs) if (s === want[i]) i++;
    return i === want.length && segs[segs.length - 1] === want[want.length - 1];
  });
};

const REF = /`([a-zA-Z0-9_./@-]+\.(?:ts|tsx|mjs|json|md)):(\d+)(?:[-–:](\d+))?`/g;
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(resolve(ROOT, "docs/archive/refactor"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => `docs/archive/refactor/${f}`);

let total = 0;
const bad = [];
for (const ch of targets) {
  for (const m of readFileSync(resolve(ROOT, ch), "utf8").matchAll(REF)) {
    const [, rel, fromS, toS] = m;
    total++;
    const hits = candidates(rel);
    if (!hits.length) {
      bad.push(`${ch} · ${rel} — 这个文件不在了`);
      continue;
    }
    const to = Number(toS ?? fromS);
    // 同名文件不止一个时，只要有一个装得下这个行号就算过：这个检查回答的是
    // 「行号还指得到东西吗」，而「是哪一个文件」读的人看上下文就知道。
    const sizes = hits.map((h) => readFileSync(resolve(ROOT, h), "utf8").split("\n").length);
    if (!sizes.some((n) => n >= to))
      bad.push(`${ch} · ${rel}:${to} — 最长的那个也只有 ${Math.max(...sizes)} 行`);
  }
}

if (bad.length) {
  console.error(`[doc-refs] ${total} 处引用，${bad.length} 处指不到了：`);
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}
console.log(`[doc-refs] ${total} 处引用，全部指得到`);
