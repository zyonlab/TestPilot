#!/usr/bin/env node
/**
 * 给 cases.json 里每条接口判据做一次「反向校验」：不跑浏览器，直接用测试地址调一次接口，
 * 按判据的 path 一段一段往下取，打印取到的值与类型——或者停在哪一段、为什么。
 *
 *   npx tsx fixtures/hyperliquid-testnet/oracle-probe.mjs [--address 0x…]
 *   （要 tsx：它复用 exec/apiOracle.ts 里同一个 `pick`，判据在运行时怎么取值这里就怎么取）
 *
 * 为什么值得一个脚本：接口判据不看屏幕，所以它验不出自己写错了路径——一条永远
 * `unobservable` 的判据和一条永远 pass 的判据一样没用（07 T-02）。区分两种落空：
 *   路径错  ：对象上没有这个键（列出可用的键）
 *   absent  ：列表为空或过滤没命中（列出过滤键的现有取值）——账户平的时候这是正常的
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pick } from "../../packages/harness-testing/src/exec/apiOracle.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argAddr = args[args.indexOf("--address") + 1];
const spec = JSON.parse(readFileSync(resolve(here, "cases.json"), "utf8"));
const address = args.includes("--address") ? argAddr : readFileSync(resolve(here, "../../server/.wallets/account.txt"), "utf8").trim();
const env = { ...spec.environment.vars, HL_ADDRESS: address };
const sub = (t) => String(t).replace(/\$\{env\.([A-Z_]+)\}/g, (_, k) => env[k] ?? "");

const splitPath = (path) => { const out = []; let buf = "", depth = 0; for (const ch of path) { if (ch === "[") depth++; else if (ch === "]") depth = Math.max(0, depth - 1); if (ch === "." && depth === 0) { out.push(buf); buf = ""; } else buf += ch; } out.push(buf); return out; };
const describe = (v) => Array.isArray(v) ? `array(${v.length})` : v === null ? "null" : typeof v === "object" ? `object{${Object.keys(v).slice(0, 8).join(",")}}` : `${typeof v} ${JSON.stringify(v)}`;

let bad = 0;
for (const c of spec.cases) {
  const o = c.oracle;
  if (!o || o.kind !== "api") { console.log(`· ${c.title}\n    （非接口判据，跳过）`); continue; }
  const res = await fetch(sub(o.url), { method: o.method ?? "GET", headers: { "content-type": "application/json" }, body: o.method === "POST" ? sub(o.body ?? "{}") : undefined });
  const json = await res.json();
  const value = pick(json, o.path);
  let verdict;
  if (value !== undefined) verdict = `值 = ${describe(value)}`;
  else {
    // 找停在哪一段
    const segs = splitPath(o.path).filter(Boolean);
    let good = json, goodPath = "(root)", stop = null;
    for (let i = 0; i < segs.length; i++) {
      const prefix = segs.slice(0, i + 1).join(".");
      const v = pick(json, prefix);
      if (v === undefined) { stop = segs[i]; break; }
      good = v; goodPath = prefix;
    }
    const sel = stop?.match(/^([^[]*)\[([^=\]]+)=([^\]]*)\]$/);
    if (sel) {
      const [, key, fk, want] = sel;
      const arr = key ? pick(good, key) : good;
      if (Array.isArray(arr)) verdict = arr.length === 0 ? `absent：${goodPath}${key ? "." + key : ""} 是空列表（账户平时正常）` : `absent：过滤 [${fk}=${want}] 无命中，现有 ${fk} 取值：${[...new Set(arr.map((e) => String(pick(e, fk))))].join(", ")}`;
      else { verdict = `路径错：${goodPath} 下没有 ${key}（是 ${describe(good)}）`; bad++; }
    } else if (stop) {
      verdict = `路径错：${goodPath} 下没有 ${stop}（是 ${describe(good)}）`; bad++;
    } else verdict = "路径错：根就取不到"; 
  }
  const expect = `${o.op}${o.value !== undefined ? " " + JSON.stringify(o.value) : ""}`;
  console.log(`· ${c.title}\n    HTTP ${res.status} · ${o.path}\n    ${verdict} · 判据 ${expect}`);
}
console.log(bad ? `\n${bad} 条判据路径写错` : `\n全部 ${spec.cases.length} 条：取到值或明确 absent，没有写错的路径`);
process.exit(bad ? 1 : 0);
