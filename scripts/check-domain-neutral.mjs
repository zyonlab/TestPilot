#!/usr/bin/env node
/**
 * 领域中立检查：发给每个产品的代码与 skill 里，不许有某一个领域写死的内容。
 *
 * 2026-09-15 用户决定：非通用的部分不能在代码里硬编码（也不能写成 if/else），只能是项目数据——
 * 用户用对话抽屉聊出来，或自己指定。和 check:host-parity 一样，是一条会红的不变量。
 *
 * 查什么：产品源码（server/src、packages/*\/src、apps/*\/src、src）非注释代码行里的领域词，
 *        以及 plugins/testpilot/skills 的全部文本。
 * 不查什么：测试、fixtures/、benchmark/（评测数据集）、docs/、server/scripts（一次性工具与迁移）、
 *        server/harness.config.ts（运营方的安全配置，禁止名单写的就是具体地址）。
 * 豁免：行内写 `domain-neutral-allow: <理由>`，理由必须写。
 *
 * 用法：node scripts/check-domain-neutral.mjs      有命中退出 1
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODE_ROOTS = ["server/src", "packages/harness-core/src", "packages/harness-testing/src", "packages/testpilot-mcp/src", "apps/runner/src", "apps/agent/src", "src"];
const TEXT_ROOTS = ["plugins/testpilot/skills"];

/**
 * 领域词。只收**换一个产品就没有意义**的词；「提现 / 转账 / 支付 / 下单」这类通用的交易与电商动作不在里面，
 * CSS 里的 margin / position 也不在（会误伤）。
 */
const TERMS = /hyperliquid|421614|arbitrum|\bperp(etual)?s?\b|funding rate|\bfunding\b|mark price|\bleverage\b|liquidation|order ?book|buy ?\/ ?long|sell ?\/ ?short|place order|market close|szdecimals|资金费率|永续|期货|杠杆|爆仓|保证金|订单簿|平仓|开仓|持仓|撤单|充值|划转|合约交易/i;

const walk = (dir, exts, out = []) => {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (!/^(test|tests|__tests__|fixtures)$/.test(name)) walk(full, exts, out); }
    else if (exts.some((e) => name.endsWith(e)) && !/\.test\.[tj]sx?$/.test(name)) out.push(full);
  }
  return out;
};

/** 把一行里的注释去掉：整行注释、块注释里的行、行尾 `//` 注释、JSX 注释。 */
function codeOf(line, state) {
  let s = line;
  if (state.inBlock) {
    const end = s.indexOf("*/");
    if (end < 0) return "";
    s = s.slice(end + 2); state.inBlock = false;
  }
  s = s.replace(/\{\/\*.*?\*\/\}/g, "").replace(/\/\*.*?\*\//g, "");
  const open = s.indexOf("/*");
  if (open >= 0) { state.inBlock = true; s = s.slice(0, open); }
  const trimmed = s.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) return "";
  return s.replace(/(^|[^:"'`\\])\/\/.*$/, "$1");
}

const problems = [];
for (const root of CODE_ROOTS) {
  for (const file of walk(path.join(ROOT, root), [".ts", ".tsx", ".mjs", ".js"])) {
    const state = { inBlock: false };
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      const code = codeOf(line, state);
      if (!code.trim() || !TERMS.test(code) || /domain-neutral-allow:\s*\S/.test(line)) return;
      problems.push(`${path.relative(ROOT, file)}:${i + 1}: ${code.trim().slice(0, 140)}`);
    });
  }
}
for (const root of TEXT_ROOTS) {
  for (const file of walk(path.join(ROOT, root), [".md"])) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (!TERMS.test(line) || /domain-neutral-allow:\s*\S/.test(line)) return;
      problems.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
}

if (problems.length) {
  console.log(`check-domain-neutral: ${problems.length} 处领域内容写死在发给每个产品的代码或 skill 里\n`);
  for (const p of problems) console.log(`  - ${p}`);
  console.log("\n领域内容是项目数据：规则包（actionVocabulary / sideEffectLabels / volatileReadings）、领域参考、环境画像。确有理由留在代码里的，行内写 domain-neutral-allow: <理由>。");
  process.exit(1);
}
console.log("check-domain-neutral: 产品源码与 skill 里没有写死的领域内容");
