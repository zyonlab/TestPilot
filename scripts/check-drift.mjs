#!/usr/bin/env node
/**
 * 两臂提示词的漂移检查。
 *
 * A 臂的生成器提示词在 `packages/harness-testing/src/casegen/prompts.ts`（英文，喂给约束解码），
 * C 臂的在 `plugins/testpilot/skills/*\/SKILL.md`（中文，喂给 agent）。它们是**同一个生成器的两份文本**。
 * P1 说两臂只差 Agent State 的版本——可只要这两份文本各自演化，两臂就还差着一件没人量的事，
 * 而配对评测照样会给出一个数字。
 *
 * 借的是 commerce-agents 的 `scripts/check.py::check_managed_system_prompts`：真源里每条规则
 * 逐字在派生文本里找，找不到就必须在派生文本头部显式声明 `adapted` / `omitted`，否则 CI 红。
 * 我们两份不同语言，逐字找不成立，所以改成**按规则的指纹声明**：
 *
 *   源文本的每条规则（`- ` 开头的 bullet，连同缩进的续行）算一个 sha256 前 8 位；
 *   SKILL.md 在 frontmatter 之后放一个注释块，逐条认领：
 *
 *     <!-- drift-check source=casegen/prompts.ts#CASES_STABLE
 *     rule 1a2b3c4d   sourceRefs names the specification sections…
 *     omitted 9c8d7e6f  CASE BUDGET — C 臂没有这个参数
 *     -->
 *
 *   `rule` 表示「这条我翻译了」，`omitted` 表示「这条我有意没放，理由在后面」。
 *   源里改了一条规则，它的指纹就变，注释块里那条就对不上——**改动必须被看见并重新认领**。
 *   注释块里多出来的指纹（源里已经没有那条规则）同样报，那是反向的漂移。
 *
 * 第二件事：`plugins/testpilot/plugin.json` 的 `skillDigests[name]` 要等于对应 SKILL.md 的
 * sha256 前 16 位。摘要变了而 `skillVersions[name]` 没变（相对 git HEAD），说明改了 skill 却没
 * 跳版本——`RunMeta.skillVersion` 会指认错误的生成器版本，那正是 P3 要防的假印记。
 *
 * 用法：
 *   node scripts/check-drift.mjs            检查，任何漂移退出码 1
 *   node scripts/check-drift.mjs --write    把当前状态写成基线：补 rule 行、更新 skillDigests
 *                                          （这是「我已重新同步」的宣告，不是修法）
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");

/** 哪份 STABLE 对应哪个 skill。compose 在 C 臂没有对应 skill：C 臂直接读材料。 */
const PAIRS = [
  { source: "STORIES_STABLE", skill: "testpilot-stories" },
  { source: "CASES_STABLE", skill: "testpilot-design" },
];

const sha = (text, n) => createHash("sha256").update(text).digest("hex").slice(0, n);
const norm = (text) => text.replace(/\s+/g, " ").trim();

/** 源文本里的规则：`- ` 开头的行，加上后面缩进两格的续行。 */
export function rulesOf(stable) {
  const rules = [];
  let cur = null;
  for (const line of stable.split("\n")) {
    if (/^- /.test(line)) {
      if (cur) rules.push(cur);
      cur = line.slice(2);
    } else if (cur && /^ {2,}\S/.test(line)) {
      cur += " " + line.trim();
    } else {
      if (cur) rules.push(cur);
      cur = null;
    }
  }
  if (cur) rules.push(cur);
  return rules.map((text) => ({ text: norm(text), id: sha(norm(text), 8) }));
}

/** SKILL.md 里的认领块。没有就是空的。 */
export function claimsOf(skillMd) {
  const m = /<!-- drift-check source=(\S+)\n([\s\S]*?)-->/.exec(skillMd);
  if (!m) return null;
  const claims = new Map();
  for (const line of m[2].split("\n")) {
    const c = /^(rule|omitted)\s+([0-9a-f]{8})(?:\s+(.*))?$/.exec(line.trim());
    if (c) claims.set(c[2], { kind: c[1], note: c[3] ?? "" });
  }
  return { source: m[1], claims, block: m[0] };
}

function renderBlock(source, rules, claims) {
  const lines = [`<!-- drift-check source=${source}`];
  for (const r of rules) {
    const prior = claims?.get(r.id);
    const kind = prior?.kind ?? "rule";
    const note = prior?.note || r.text.slice(0, 60);
    lines.push(`${kind} ${r.id}  ${note}`);
  }
  lines.push("-->");
  return lines.join("\n");
}

async function loadPrompts() {
  const req = createRequire(pathToFileURL(path.join(ROOT, "packages/testpilot-mcp/package.json")));
  const { register } = await import(pathToFileURL(req.resolve("tsx/esm/api")).href);
  register();
  return import(pathToFileURL(path.join(ROOT, "packages/harness-testing/src/casegen/prompts.ts")).href);
}

function headPluginJson() {
  try {
    // 分支上还没提交过 plugin.json 时 git 会在 stderr 报 fatal——那是「没有 HEAD 版本」，不是错误。
    return JSON.parse(execSync("git show HEAD:plugins/testpilot/plugin.json", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

async function main() {
  const prompts = await loadPrompts();
  const problems = [];

  for (const { source, skill } of PAIRS) {
    const skillPath = path.join(ROOT, "plugins/testpilot/skills", skill, "SKILL.md");
    let md = readFileSync(skillPath, "utf8");
    const rules = rulesOf(prompts[source]);
    const tag = `casegen/prompts.ts#${source}`;
    const found = claimsOf(md);

    if (WRITE) {
      const block = renderBlock(tag, rules, found?.claims);
      if (found) md = md.replace(found.block, block);
      else {
        // 放在 frontmatter 之后、正文之前。
        const fm = /^---\n[\s\S]*?\n---\n/.exec(md);
        md = fm ? md.slice(0, fm[0].length) + "\n" + block + "\n" + md.slice(fm[0].length) : block + "\n\n" + md;
      }
      writeFileSync(skillPath, md);
      continue;
    }

    if (!found) {
      problems.push(`${skill}/SKILL.md 没有 drift-check 认领块（源 ${tag} 有 ${rules.length} 条规则）。跑 --write 生成基线。`);
      continue;
    }
    if (found.source !== tag) problems.push(`${skill}/SKILL.md 认领的源是 ${found.source}，应为 ${tag}`);
    for (const r of rules)
      if (!found.claims.has(r.id))
        problems.push(
          `${skill}/SKILL.md 没有认领 ${source} 的这条规则（新增或已改）：\n      [${r.id}] ${r.text}\n` +
            `      翻译进 SKILL.md 后加一行「rule ${r.id}」，或写「omitted ${r.id} <理由>」`,
        );
    const live = new Set(rules.map((r) => r.id));
    for (const [id, c] of found.claims)
      if (!live.has(id)) problems.push(`${skill}/SKILL.md 认领了 ${source} 里已不存在的规则 [${id}] ${c.note}——源里删了或改了，去掉这行`);
  }

  /* ---- skillDigests ↔ SKILL.md 内容；摘要变了版本要跟着变 */
  const pluginPath = path.join(ROOT, "plugins/testpilot/plugin.json");
  const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
  const head = headPluginJson();
  plugin.skillDigests ??= {};
  for (const name of Object.keys(plugin.skillVersions ?? {})) {
    const md = readFileSync(path.join(ROOT, "plugins/testpilot/skills", name, "SKILL.md"), "utf8");
    const digest = sha(md, 16);
    if (WRITE) {
      plugin.skillDigests[name] = digest;
      continue;
    }
    const recorded = plugin.skillDigests[name];
    if (!recorded) {
      problems.push(`plugin.json 没有 ${name} 的 skillDigests。跑 --write 生成。`);
      continue;
    }
    if (recorded !== digest) {
      const headVersion = head?.skillVersions?.[name];
      const bumped = headVersion && headVersion !== plugin.skillVersions[name];
      problems.push(
        `${name}/SKILL.md 变了（${recorded} → ${digest}）但 plugin.json 的 skillDigests 没更新` +
          (bumped ? "" : `，且 skillVersions.${name} 相对 HEAD 没有跳版本（${plugin.skillVersions[name]}）——RunMeta.skillVersion 会指认错误的生成器`) +
          "。改完 skill 要跳版本并跑 --write。",
      );
    }
  }
  if (WRITE) {
    writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");
    console.log("drift baseline written: 认领块与 skillDigests 已更新");
    return 0;
  }

  if (problems.length) {
    console.error(`check-drift: ${problems.length} 处漂移\n`);
    for (const p of problems) console.error("  - " + p + "\n");
    return 1;
  }
  console.log(`check-drift: ${PAIRS.length} 对提示词的规则全部认领，${Object.keys(plugin.skillVersions).length} 个 skill 摘要一致`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
