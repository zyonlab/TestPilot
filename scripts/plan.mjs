#!/usr/bin/env node
/**
 * 读 docs/spec/17 的任务块，报进度、报「下一批能做的」、改状态。
 *
 * 这个脚本刻意不建自己的状态文件：`- 状态：` 那一行就是唯一的真相源。
 * 理由写在那份文档的 §0——两个真相源会长出两份互相矛盾的历史，
 * 而这正是它自己的红线之一（事件是事实，投影不是）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(ROOT, "docs/spec/17-整体UI重构-任务与进度.md");
const STATES = ["todo", "doing", "done", "blocked", "dropped"];

/** 一个任务块从 `#### U-xx · 标题` 起，到下一个 `####` 或 `##` 为止。 */
function parse(text) {
  const lines = text.split("\n");
  const tasks = [];
  let phase = "";
  let cur = null;
  lines.forEach((line, i) => {
    const ph = /^## \d+\. (P\d) · (.+)$/.exec(line);
    if (ph) phase = `${ph[1]} ${ph[2]}`;
    const head = /^#### (U-\d+) · (.+)$/.exec(line);
    if (head) {
      cur = { id: head[1], title: head[2], phase, line: i, status: "todo", deps: [], gives: "" };
      tasks.push(cur);
      return;
    }
    if (!cur) return;
    if (/^#{2,4} /.test(line)) { cur = null; return; }
    const st = /^- 状态：(\S+)/.exec(line);
    if (st) { cur.status = st[1]; cur.statusLine = i; cur.note = line.slice(line.indexOf(st[1]) + st[1].length).trim(); }
    const dep = /^- 依赖：(.*)$/.exec(line);
    if (dep) cur.deps = (dep[1].match(/U-\d+/g) ?? []);
    const gv = /^- 兑现：(.*)$/.exec(line);
    if (gv) cur.gives = gv[1];
  });
  return tasks;
}

const raw = readFileSync(DOC, "utf8");
const tasks = parse(raw);
const by = new Map(tasks.map((t) => [t.id, t]));
const arg = process.argv.slice(2);

/* ---- 改状态 ---- */
if (arg[0] === "--set") {
  const [, id, next, ...note] = arg;
  const t = by.get(id);
  if (!t) { console.error(`没有这个任务：${id}`); process.exit(1); }
  if (!STATES.includes(next)) { console.error(`状态只能是 ${STATES.join(" / ")}`); process.exit(1); }
  if (next === "done") {
    const open = t.deps.filter((d) => by.get(d) && by.get(d).status !== "done" && by.get(d).status !== "dropped");
    // 拦不住，但要说出来——依赖没完就标 done 通常意味着验收判据没真的过。
    if (open.length) console.error(`⚠ ${id} 的依赖还没完成：${open.join(" ")}——确认验收判据真的过了再标 done`);
  }
  const lines = raw.split("\n");
  lines[t.statusLine] = `- 状态：${next}${note.length ? " · " + note.join(" ") : ""}`;
  writeFileSync(DOC, lines.join("\n"));
  console.log(`${id}  ${t.status} → ${next}`);
  process.exit(0);
}

/* ---- 统计 ---- */
const count = (list, s) => list.filter((t) => t.status === s).length;
const bar = (d, n, w = 22) => {
  const k = n ? Math.round((d / n) * w) : 0;
  return "█".repeat(k) + "·".repeat(w - k);
};
const phases = [...new Set(tasks.map((t) => t.phase))];

/* 依赖全部 done/dropped 且自己是 todo → 现在就能动手 */
const ready = tasks.filter(
  (t) => t.status === "todo" && t.deps.every((d) => !by.get(d) || ["done", "dropped"].includes(by.get(d).status)),
);

if (arg[0] === "--next") {
  const n = Number(arg[1]) || 12;
  console.log(`\n可以动手的任务（依赖已满足）· 共 ${ready.length} 条，列前 ${Math.min(n, ready.length)} 条\n`);
  ready.slice(0, n).forEach((t) => {
    console.log(`  ${t.id}  [${t.phase.split(" ")[0]}]  ${t.title}`);
    if (t.gives) console.log(`         兑现 ${t.gives}`);
  });
  const doing = tasks.filter((t) => t.status === "doing");
  if (doing.length) {
    console.log(`\n有人在做：`);
    doing.forEach((t) => console.log(`  ${t.id}  ${t.title}${t.note ? "  " + t.note : ""}`));
  }
  const blocked = tasks.filter((t) => t.status === "blocked");
  if (blocked.length) {
    console.log(`\n卡住的：`);
    blocked.forEach((t) => console.log(`  ${t.id}  ${t.title}  ${t.note || "（没写原因——补上）"}`));
  }
  console.log("");
  process.exit(0);
}

console.log(`\n整体 UI 重构 · ${DOC.replace(ROOT + "/", "")}\n`);
for (const p of phases) {
  const list = tasks.filter((t) => t.phase === p);
  const d = count(list, "done") + count(list, "dropped");
  console.log(`  ${bar(d, list.length)}  ${String(d).padStart(2)}/${String(list.length).padEnd(2)}  ${p}`);
}
const done = count(tasks, "done");
console.log(`\n  合计 ${done}/${tasks.length} done · ${count(tasks, "doing")} doing · ` +
            `${count(tasks, "blocked")} blocked · ${count(tasks, "dropped")} dropped · ${ready.length} 条现在就能动手`);
console.log(`\n  下一步：node scripts/plan.mjs --next\n`);
