#!/usr/bin/env node
/**
 * 宿主入口对 Web UI 操作的覆盖检查。见 `scripts/host-parity.mjs` 顶部的注释。
 *
 * 它管两件事，都是「悄悄退化」这一类：
 *   ① **新加的 UI 路由必须被分类**——分不了类就红。忘了同步宿主，这里当场拦住。
 *   ② **覆盖率只能涨不能跌**——基线记在清单里；掉下去就红，而且会说清楚掉在哪条上。
 *
 * 用法：
 *   node scripts/check-host-parity.mjs            # 检查
 *   node scripts/check-host-parity.mjs --write    # 把新路由并进清单（默认 todo）并刷新基线
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeInventory, routeKey } from "./host-parity.mjs";
import { actionIndex } from "../packages/testpilot-mcp/src/host/registry.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "server/host-parity.json");
const WRITE = process.argv.includes("--write");

function main() {
  const manifest = JSON.parse(readFileSync(FILE, "utf8"));
  const declared = new Map(manifest.routes.map((r) => [routeKey(r), r]));
  const actual = routeInventory();
  const problems = [];

  const missing = actual.filter((r) => !declared.has(routeKey(r)));
  const stale = [...declared.keys()].filter((k) => !actual.some((r) => routeKey(r) === k));

  if (WRITE) {
    for (const r of missing) declared.set(routeKey(r), { ...r, status: "todo" });
    for (const k of stale) declared.delete(k);
    /**
     * **归属由 registry 算，不靠人手工维护。**
     *
     * 第一版 `--write` 只刷新基线，于是新加了五个域、`check` 仍然报 33.3%——
     * 因为 `host:` 字段还得有人一条条去填。一张需要手工同步的表，
     * 和它要防的那种漂移是同一件事。现在：registry 里有这条路由就是 host，
     * 没有就退回 todo（除非人显式标了 uiOnly）。
     */
    const byRoute = new Map();
    for (const [name, { spec }] of actionIndex()) byRoute.set(`${spec.method} ${spec.path}`, { name, operatorOnly: spec.operatorOnly });
    for (const [key, row] of declared) {
      const action = byRoute.get(key);
      if (action?.operatorOnly) {
        row.uiOnly = "人工审核与基线决定仅通过 Web 操作，规划器工具不注册此动作";
        delete row.host; delete row.status; continue;
      }
      if (row.uiOnly) continue;
      const host = action?.name;
      if (host) { row.host = host; delete row.status; }
      else { delete row.host; row.status = "todo"; }
    }
  } else {
    for (const r of missing)
      problems.push(`${routeKey(r)}（${r.source}）是新路由，清单里没有它。宿主能不能做这件事？` +
        `做了就写 host:"<tool>.<action>"，还没做写 status:"todo"，故意不给写 uiOnly:"<理由>"。跑 --write 先并进来。`);
    for (const k of stale) problems.push(`${k} 在清单里但源码里已经没有了——跑 --write 清掉。`);
  }

  /**
   * **registry 里每一行都必须对应一条真实路由。**
   *
   * 2026-09-14 第一版我照着记忆写了十条路径，真实存在的只有两条——参数叫 `:id` 不是
   * `:projectId`，材料是全局 `/api/materials` 不是项目下的。路径写错不会有任何一层报错，
   * 只会在 agent 真调的时候 404，而那时候人已经在等结果了。
   *
   * 反过来也查：`host:` 指向一个 registry 里不存在的动作，同样是红。
   */
  const known = new Set(actual.map(routeKey));
  for (const [name, { spec }] of actionIndex())
    if (!known.has(`${spec.method} ${spec.path}`))
      problems.push(`registry 的 ${name} 指向 ${spec.method} ${spec.path}，而服务端没有这条路由。`);
  const actions = new Set(actionIndex().keys());
  for (const r of [...declared.values()])
    if (r.host && !actions.has(r.host))
      problems.push(`${routeKey(r)} 标了 host:"${r.host}"，而 registry 里没有这个动作。`);

  for (const r of declared.values())
    if (r.host && actionIndex().get(r.host)?.spec.operatorOnly)
      problems.push(`${routeKey(r)} 是人工专属动作，不能计入宿主可调用覆盖。`);

  const rows = [...declared.values()];
  for (const r of rows) {
    const kinds = [r.host && "host", r.status === "todo" && "todo", r.uiOnly && "uiOnly"].filter(Boolean);
    if (kinds.length !== 1) problems.push(`${routeKey(r)} 的分类不明确（${kinds.join("+") || "什么都没写"}）——三选一。`);
    if (r.uiOnly && String(r.uiOnly).trim().length < 8)
      problems.push(`${routeKey(r)} 标了 uiOnly 但没写理由。故意不给宿主的操作，理由要留下来。`);
  }

  const covered = rows.filter((r) => r.host).length;
  const uiOnly = rows.filter((r) => r.uiOnly).length;
  const todo = rows.filter((r) => r.status === "todo").length;
  /**
   * 分母把 `uiOnly` 去掉：故意不给的那些不该拉低分数，否则要么没人敢标 uiOnly，
   * 要么大家靠标 uiOnly 把数字做上去。理由写在清单里，人看得见。
   */
  const reachable = covered + todo;
  const rate = reachable ? covered / reachable : 1;
  const baseline = manifest.baseline ?? { covered: 0, reachable, rate: 0 };

  /**
   * 比的是**覆盖条数**，不是比率。
   *
   * 第一版比 `rate`，而基线里存的是 `toFixed(4)` 的四舍五入值：新加一条路由、
   * 同时把它覆盖了，真实比率会比存下来的四舍五入值低一丁点，于是报
   * 「从 91.3% 掉到 91.3%」——一句自相矛盾的话。条数是整数，没有这个问题：
   * 它要表达的本来就是「宿主能做的事只能变多」。
   */
  if (!WRITE && covered < (baseline.covered ?? 0))
    problems.push(`宿主覆盖从 ${baseline.covered} 条掉到 ${covered} 条（${(baseline.rate * 100).toFixed(1)}% → ${(rate * 100).toFixed(1)}%）。` +
      `宿主入口只能越来越全——要么补上，要么说清楚为什么这条退回 todo。`);

  if (WRITE) {
    writeFileSync(FILE, JSON.stringify({ ...manifest, baseline: { covered, reachable, rate: Number(rate.toFixed(4)) },
      routes: rows.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method)) }, null, 1) + "\n");
    console.log(`host-parity 基线已写入：${covered}/${reachable}（${(rate * 100).toFixed(1)}%），另有 ${uiOnly} 条声明为 UI 专属`);
    return 0;
  }
  if (problems.length) {
    console.error(`check-host-parity: ${problems.length} 处问题\n`);
    for (const p of problems) console.error("  - " + p + "\n");
    return 1;
  }
  console.log(`check-host-parity: 宿主覆盖 ${covered}/${reachable}（${(rate * 100).toFixed(1)}%）· 待做 ${todo} · UI 专属 ${uiOnly}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
