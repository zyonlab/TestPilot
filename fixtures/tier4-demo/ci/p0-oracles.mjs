#!/usr/bin/env node
/**
 * CI 的确定性臂（07 T-17）：**不打模型**。
 *
 * 平台内跑 P0 是模型看图点控件、接口判据下判决。CI 里模型那半边换成固定选择器（demo 页的 id），
 * 判据那半边**原样复用 `cases.json` 里的 `kind: api` 判据**——同一份路径、同一个 op、同一个值，用同一套 `pick` 语义核对。
 * 这样 CI 红/绿的含义和平台内一致：产品的接口状态不对，不是「脚本跟界面对不上」。
 *
 * 为什么不用导出的 Playwright 工程：导出的每一步是 `aiAction(文本)`，靠 Midscene 缓存才不打模型，
 * 而缓存 id 与网关那份不对齐——CI 里就会每步问模型。等缓存 id 对齐之后再换回导出工程。
 *
 *   node ci/p0-oracles.mjs [--base http://127.0.0.1:5390]
 * 退出码：0 全绿；1 有红（stdout 逐条打印判据读到了什么）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "..", "..", "packages", "harness-testing", "package.json"));
const puppeteer = require("puppeteer");
const args = process.argv.slice(2);
const base = args[args.indexOf("--base") + 1] || "http://127.0.0.1:5390";
const spec = JSON.parse(readFileSync(join(here, "..", "cases.json"), "utf8"));
const env = { ...spec.environment.vars, DEMO_API: `${base}/api/clearinghouse` };
const sub = (t) => String(t).replace(/\$\{env\.([A-Z_]+)\}/g, (_, k) => env[k] ?? "");

/** 与 `harness-testing/exec/apiOracle.ts` 的 `pick` 同一套：点分路径，`[k=v]` 按字段选。 */
function pick(obj, path) {
  let cur = obj;
  for (const seg of path.split(".")) {
    if (seg === "") continue;
    const sel = seg.match(/^([^[]*)\[([^=\]]+)=([^\]]*)\]$/);
    const key = sel ? sel[1] : seg;
    if (key !== "") { if (cur == null) return undefined; cur = Array.isArray(cur) ? cur[Number(key)] : cur[key]; }
    if (sel) { if (!Array.isArray(cur)) return undefined; cur = cur.find((el) => String(pick(el, sel[2])) === sel[3]); }
  }
  return cur;
}
const judge = (o, value) => {
  if (o.op === "absent") return value === undefined || value === null;
  if (o.op === "exists") return value !== undefined && value !== null;
  if (value === undefined) return null; // unobservable
  const num = Number(value), want = Number(o.value);
  if (o.op === "eq") return String(value) === String(o.value) || (Number.isFinite(num) && Number.isFinite(want) && Math.abs(num - want) < 1e-9);
  if (o.op === "neq") return String(value) !== String(o.value);
  if (o.op === "gte") return num >= want;
  if (o.op === "lte") return num <= want;
  return null;
};

/** 每条用例的动作：固定选择器。文本步骤只在这里翻译一次，判据不翻译。 */
const ACTIONS = {
  "Size 按步长截断": async (p) => { await p.click("#tab-market"); await p.$eval("#size", (e) => (e.value = "")); await p.type("#size", "0.0016"); await p.click("#place"); },
  "限价 10000": async (p) => { await p.click("#tab-limit"); await p.$eval("#price", (e) => (e.value = "")); await p.type("#price", "10000"); await p.$eval("#size", (e) => (e.value = "")); await p.type("#size", "0.001"); await p.click("#place"); },
  "杠杆设为 5x": async (p) => { await p.$eval("#lev", (e) => (e.value = "")); await p.type("#lev", "5"); await p.click("#setlev"); },
  "平仓后": async (p) => { await p.click("#tab-market"); await p.$eval("#size", (e) => (e.value = "")); await p.type("#size", "0.002"); await p.click("#place"); await new Promise((r) => setTimeout(r, 300)); await p.click("#close"); },
};

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
let red = 0;
try {
  for (const c of spec.cases) {
    const key = Object.keys(ACTIONS).find((k) => c.title.startsWith(k));
    if (!key) { console.log(`∅ ${c.title}：CI 臂没有这条的动作`); continue; }
    await fetch(`${base}/api/reset`, { method: "POST" });
    const page = await browser.newPage();
    await page.goto(base + "/", { waitUntil: "networkidle0" });
    await ACTIONS[key](page);
    await new Promise((r) => setTimeout(r, c.oracle.settleMs ?? 300));
    const res = await fetch(sub(c.oracle.url), { method: c.oracle.method ?? "GET" });
    const value = pick(await res.json(), c.oracle.path);
    const v = judge(c.oracle, value);
    const line = `${c.oracle.path} = ${JSON.stringify(value)}（要求 ${c.oracle.op}${c.oracle.value !== undefined ? " " + JSON.stringify(c.oracle.value) : ""}）`;
    if (v === true) console.log(`✓ ${c.title} — ${line}`);
    else if (v === null) console.log(`∅ ${c.title} — 没量到：${line}`);
    else { console.log(`✗ ${c.title} — ${line}`); red += 1; }
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(red ? `\n${red} 条 P0 红（模型调用 0 次：这条臂不问模型）` : `\n全部 ${spec.cases.length} 条 P0 绿（模型调用 0 次）`);
process.exit(red ? 1 : 0);
