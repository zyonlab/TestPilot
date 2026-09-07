/**
 * 把手册里漂掉的 `file:line` 按**内容**重新对准。
 *
 * 行号会漂，这不可避免——代码每天在改。可漂掉的行号比没有行号更糟：
 * 它让读的人以为是自己找错了。此前唯一的办法是人逐条打开，而那件事撞过一次配额上限，
 * 九章的行号从没被第二双眼睛看过。
 *
 * 对准的依据是**标识符**，不是 diff：手册在一处引用旁边提到 `budgeted`，
 * 那么这处引用就该指向 `budgeted` 的定义行。按 diff 移位是不行的——
 * 它要求知道「上次对准时是哪一版」，而那个信息没有留下来，猜错就会越移越远。
 *
 * 三条保守规则，宁可少改：
 * ① 文件必须唯一确定；
 * ② 那个标识符在该文件里必须**只有一处定义**；
 * ③ 已经指在定义前后 3 行内的，不动——手册常常故意指向定义上方的那段注释。
 *
 *   node scripts/fix-doc-refs.mjs            # 只报告
 *   node scripts/fix-doc-refs.mjs --apply    # 改
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const ROOT = process.cwd();
const apply = process.argv.includes("--apply");
const SKIP = new Set(["node_modules", ".git", "dist", "midscene_run", "coverage"]);

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".data")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx|mjs)$/.test(name)) files.push(relative(ROOT, full));
  }
})(ROOT);

const candidates = (rel) => {
  const want = rel.split("/");
  return files.filter((f) => {
    const segs = f.split("/");
    let i = 0;
    for (const s of segs) if (s === want[i]) i++;
    return i === want.length && segs[segs.length - 1] === want[want.length - 1];
  });
};

/**
 * `name` 在这个文件里的**声明行**（1 起）。不止一处就返回 null。
 *
 * 只认真正的声明（function / const / class / interface / type / enum），
 * 不认「某一行冒号后面出现了这个词」——后者会把一个叫 `screenshots` 的对象字段
 * 当成定义，把引用挪到两百行以外。含糊的对准比不对准更坏：
 * 它把一个「有点旧」的行号变成一个**理直气壮指错地方**的行号。
 */
function defLine(srcLines, name) {
  /*
   * 太短或太泛的词不作数。
   *
   * 它们在一个文件里要么撞车（于是返回 null，安全），要么**恰好只撞上一处**——
   * 而那一处多半跟手册说的不是一回事。`total` 在 index.ts 里只有一处 const 声明，
   * 但手册那句话说的显然不是它。
   */
  const TOO_GENERIC = new Set([
    "total", "result", "status", "output", "params", "config", "detail", "record",
    "screenshots", "message", "target", "source", "value", "index", "options",
  ]);
  if (name.length < 6 || TOO_GENERIC.has(name)) return null;
  const pat = new RegExp(
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum)\\s+${name}\\b` +
      `|^\\s*(?:export\\s+)?(?:const|let)\\s+${name}\\s*[:=]`,
  );
  const hits = [];
  srcLines.forEach((l, i) => pat.test(l) && hits.push(i + 1));
  return hits.length === 1 ? hits[0] : null;
}

const REF = /`([a-zA-Z0-9_./@-]+\.(?:ts|tsx|mjs)):(\d+)(?:([-–:])(\d+))?`/g;
const targets = readdirSync(resolve(ROOT, "docs/refactor"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => `docs/refactor/${f}`);

let fixed = 0;
const unsure = [];
for (const ch of targets) {
  const text = readFileSync(resolve(ROOT, ch), "utf8");
  const lines = text.split("\n");
  const out = lines.map((line, i) => {
    const ctx = [lines[i - 1] ?? "", line, lines[i + 1] ?? ""].join(" ");
    const idents = [...ctx.matchAll(/`([A-Za-z_$][A-Za-z0-9_$.]{3,})(?:\(\))?`/g)]
      .map((m) => m[1].split(".").pop())
      .filter((s) => s && !/^(ts|tsx|mjs|json|md)$/.test(s));
    if (!idents.length) return line;
    return line.replace(REF, (whole, rel, fromS, sep, toS) => {
      const hits = candidates(rel);
      if (hits.length !== 1) return whole;
      const src = readFileSync(resolve(ROOT, hits[0]), "utf8").split("\n");
      for (const id of idents) {
        const def = defLine(src, id);
        if (!def) continue;
        if (Math.abs(def - Number(fromS)) <= 3) return whole; // 已经对准了
        // 区间引用：起点对准定义，长度保持不变。
        const span = toS === undefined ? 0 : Number(toS) - Number(fromS);
        fixed++;
        console.log(`  ${ch}:${i + 1}  ${rel}:${fromS} → :${def}   (${id})`);
        return `\`${rel}:${def}${toS === undefined ? "" : sep + (def + span)}\``;
      }
      unsure.push(`${ch}:${i + 1} · ${rel}:${fromS} — 附近的 ${idents.slice(0, 2).join("/")} 在这个文件里找不到唯一定义`);
      return whole;
    });
  }).join("\n");
  if (apply && out !== text) writeFileSync(resolve(ROOT, ch), out);
}

console.log(`\n${apply ? "对准了" : "可以对准"} ${fixed} 处；${unsure.length} 处机器判断不了，得人看`);
if (process.argv.includes("--list-unsure")) for (const u of unsure) console.log(`  ${u}`);
