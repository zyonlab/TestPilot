#!/usr/bin/env node
/**
 * gold 过时检测（07 T-20）：条目挂到路由 / 组件 / 接口路径（`anchors`），代码一动就标出该复核的。
 *
 * 谱系哈希防偷改，防不了过时。产品改了、gold 里的条目过时，覆盖率还是好看的——
 * 人的时间只该花在被标出来的条目上。所以这个脚本做两件事，**都不改 gold.json**（改了就是新谱系）：
 *
 *   ① anchors 命中改动文件 → `stale`（原因 anchor）
 *   ② 同一条用例连续 N 次 `unobservable` → 进待审（原因 unobservable；N 默认 3，`--n`）
 *
 * 结果写到 gold 旁边的 `gold.stale.json`（`--write`），T-19 的屏（`server/src/gold.ts::readGoldState`）把它合进条目显示。
 * **不自动删任何条目**——这里只产生「该看一眼」的标记，删不删由人在屏上决定。
 *
 * 用法：
 *   node scripts/gold-stale.mjs --capability casegen --git ../sut-repo [--since HEAD~5] [--write]
 *   node scripts/gold-stale.mjs --gold benchmark/casegen/gold.json --changed src/app.ts,src/api.ts [--write]
 *   node scripts/gold-stale.mjs --gold … --runs runs.json [--n 3]      # runs.json = GET /api/runs?projectId= 的 { runs: [...] }
 *   node scripts/gold-stale.mjs --gold … --gateway http://127.0.0.1:5301 --project prj-xxx
 *
 * anchor 的两种来源：SUT 是自家仓库时用文件路径（`public/index.html`、`src/pages/Order.tsx`、`/api/order`）；
 * SUT 是外部站时用产品地图 diff 里消失的屏幕 / 转移名（`--changed` 直接喂）。匹配是子串、不分大小写：
 * anchor `OrderPanel` 命中 `src/components/OrderPanel.tsx`，anchor `/api/order` 命中 `server/routes/api/order.ts`。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const goldPath = opt("gold") ? resolve(opt("gold")) : opt("capability") ? join(ROOT, "benchmark", opt("capability"), "gold.json") : null;
if (!goldPath || !existsSync(goldPath)) {
  console.error("用法：node scripts/gold-stale.mjs (--capability <cap> | --gold <gold.json>) [--changed a,b | --git <dir> [--since <ref>]] [--runs <json> | --gateway <url> --project <id>] [--n 3] [--write]");
  process.exit(2);
}
const goldRaw = readFileSync(goldPath);
const gold = JSON.parse(goldRaw.toString("utf8"));
const N = Number(opt("n", "3")) || 3;

/* ---------- ① 改动文件 ---------- */
let changed = [];
if (opt("changed")) changed = opt("changed").split(",").map((s) => s.trim()).filter(Boolean);
else if (opt("git")) {
  const dir = resolve(opt("git"));
  const since = opt("since");
  const out = execFileSync("git", since ? ["diff", "--name-only", since] : ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
  changed = out.split("\n").map((l) => (since ? l : l.slice(3)).trim()).filter(Boolean);
}
const norm = (s) => String(s).toLowerCase().replace(/\\/g, "/");
const hits = (anchor, file) => {
  const a = norm(anchor);
  const f = norm(file);
  if (f.includes(a) || a.includes(f)) return true;
  // 组件名 / 路由名：去掉目录与后缀再比（`OrderPanel` ↔ `src/x/OrderPanel.tsx`；`/order` ↔ `pages/order.tsx`）
  const base = f.split("/").pop().replace(/\.[a-z0-9]+$/, "");
  const aBase = a.split("/").filter(Boolean).pop() ?? a;
  return !!base && !!aBase && (base === aBase || base.includes(aBase) || aBase.includes(base));
};

/* ---------- ② 连续 unobservable ---------- */
let runs = [];
if (opt("runs")) runs = JSON.parse(readFileSync(resolve(opt("runs")), "utf8")).runs ?? [];
else if (opt("gateway") && opt("project")) {
  const r = await fetch(`${opt("gateway")}/api/runs?projectId=${encodeURIComponent(opt("project"))}&limit=500`);
  if (!r.ok) throw new Error(`gateway ${r.status}`);
  runs = (await r.json()).runs ?? [];
}
const byCase = new Map();
for (const r of runs) {
  const key = r.caseId ?? r.caseTitle;
  if (!key) continue;
  byCase.set(key, [...(byCase.get(key) ?? []), r]);
}
/** 每条用例最近的 N 次是不是全 unobservable。 */
const streaks = new Map();
for (const [key, list] of byCase) {
  list.sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")));
  const tail = list.slice(-N);
  if (tail.length >= N && tail.every((r) => r.status === "unobservable")) streaks.set(key, { title: list[0].caseTitle ?? key, n: tail.length });
}
/** gold 条目 ↔ 用例：条目可带 `cases: [caseId|caseTitle]`；没有就按标题子串。 */
const itemMatchesCase = (item, key, title) => {
  if (Array.isArray(item.cases) && (item.cases.includes(key) || item.cases.includes(title))) return true;
  const t = norm(title);
  const it = norm(item.title);
  return !!t && !!it && (t.includes(it) || it.includes(t));
};

/* ---------- 汇总 ---------- */
const marks = [];
for (const item of gold.items ?? []) {
  const hitFiles = (item.anchors ?? []).flatMap((a) => changed.filter((f) => hits(a, f)).map((f) => `${a} ← ${f}`));
  if (hitFiles.length) marks.push({ id: item.id, reason: "anchor", detail: hitFiles.join("; ") });
  for (const [key, s] of streaks)
    if (itemMatchesCase(item, key, s.title)) marks.push({ id: item.id, reason: "unobservable", detail: `「${s.title}」连续 ${s.n} 次 unobservable` });
}
const result = { at: new Date().toISOString(), gold: goldPath.startsWith(ROOT) ? goldPath.slice(ROOT.length + 1) : goldPath, n: N, changed, items: marks };

if (flag("write")) {
  const out = join(dirname(goldPath), "gold.stale.json");
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.error(`[gold-stale] ${marks.length} 条标记 → ${out}`);
} else {
  console.log(JSON.stringify(result, null, 2));
}
// 自证：gold.json 一个字节没动。
if (Buffer.compare(readFileSync(goldPath), goldRaw) !== 0) {
  console.error("[gold-stale] gold.json 被改了——这不该发生");
  process.exit(3);
}
process.exit(0);
