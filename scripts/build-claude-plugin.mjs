#!/usr/bin/env node
/**
 * 生成 Claude Code 形态的 plugin（07 T-07）：`plugins/testpilot-claude/`。
 *
 * 真源只有一份：`plugins/testpilot/`（Penguin 的 manifest + skills + hooks）。这里**生成**：
 *   .claude-plugin/plugin.json   ← 由 plugins/testpilot/plugin.json 派生（name / description / version）
 *   skills/<name>/SKILL.md       ← 逐字复制（Agent Skills 格式两边一样）；`--check` 时 diff 为零才算过
 *   hooks/hooks.json             ← PreToolUse(Write|Edit|MultiEdit) 与 Stop 都指到 T-06 的适配器
 *   .mcp.json                    ← testpilot MCP（stdio）
 *   tp-config.json               ← hook 找仓库与阈值用；含绝对路径，不进仓库（.gitignore）
 *
 * 用法：node scripts/build-claude-plugin.mjs [--check]
 *   --check：不写，只比对 skills 与 manifest 是否与真源一致（CI 与 `pnpm check:drift` 用）。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "plugins", "testpilot");
const OUT = join(ROOT, "plugins", "testpilot-claude");
const check = process.argv.includes("--check");

const src = JSON.parse(readFileSync(join(SRC, "plugin.json"), "utf8"));
const skills = readdirSync(join(SRC, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

const manifest = {
  name: "testpilot",
  description: src.description,
  version: src.version,
  author: { name: "TestPilot" },
};
// 生成物的来源与各 skill 版本：审计时能对回 Penguin 那份 manifest。放旁边一份，`claude plugin validate` 不认额外字段。
const provenance = { generatedFrom: "plugins/testpilot/plugin.json", version: src.version, skillVersions: src.skillVersions ?? {}, skillDigests: src.skillDigests ?? {} };

// hooks.json：Claude Code 的 hook 事件 → T-06 适配器。命令里用 ${CLAUDE_PLUGIN_ROOT} 定位自己。
const adapter = "${CLAUDE_PLUGIN_ROOT}/../testpilot/hooks/adapters/claude-code.mjs";
const cmd = `TP_HOOK_CONFIG="\${CLAUDE_PLUGIN_ROOT}/tp-config.json" node "${adapter}"`;
const hooks = {
  description: "TestPilot 的门禁：写 stories/cases/memory 前校验形状与出处，停之前要求产物齐。规则在 plugins/testpilot/hooks/*.mjs，这里只是入口。",
  hooks: {
    PreToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command: cmd, timeout: 120 }] }],
    Stop: [{ hooks: [{ type: "command", command: cmd, timeout: 60 }] }],
  },
};

const mcp = {
  mcpServers: {
    testpilot: {
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/../../packages/testpilot-mcp/bin/testpilot-mcp.mjs"],
      env: { TP_RUNTIME: "claude-code" },
    },
  },
};

const tpConfig = { repoRoot: ROOT, minGateScore: 0.6, minNegativeRatio: 0.3, runtime: "claude-code" };

const files = new Map();
files.set(".claude-plugin/plugin.json", JSON.stringify(manifest, null, 2) + "\n");
files.set(".claude-plugin/testpilot.json", JSON.stringify(provenance, null, 2) + "\n");
files.set("hooks/hooks.json", JSON.stringify(hooks, null, 2) + "\n");
files.set(".mcp.json", JSON.stringify(mcp, null, 2) + "\n");
for (const name of skills) {
  const dir = join(SRC, "skills", name);
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isFile()) files.set(`skills/${name}/${f}`, readFileSync(p, "utf8"));
  }
}

let drift = [];
for (const [rel, content] of files) {
  const p = join(OUT, rel);
  if (check) {
    if (!existsSync(p) || readFileSync(p, "utf8") !== content) drift.push(rel);
    continue;
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
if (check) {
  // 多出来的 skill 目录也算漂移（真源删了、生成物还在）。
  const outSkills = existsSync(join(OUT, "skills")) ? readdirSync(join(OUT, "skills")) : [];
  for (const s of outSkills) if (!skills.includes(s)) drift.push(`skills/${s}（真源里没有）`);
  if (drift.length) {
    console.error(`plugins/testpilot-claude 与真源不一致（${drift.length} 处），跑 node scripts/build-claude-plugin.mjs 重新生成：\n  ${drift.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`plugins/testpilot-claude 与真源一致：${skills.length} 个 skill · manifest · hooks.json · .mcp.json`);
  process.exit(0);
}
// 真源删掉的 skill 也从生成物里删掉
if (existsSync(join(OUT, "skills")))
  for (const s of readdirSync(join(OUT, "skills"))) if (!skills.includes(s)) rmSync(join(OUT, "skills", s), { recursive: true, force: true });
// tp-config.json 含绝对路径，每次按本机重写，不进仓库
writeFileSync(join(OUT, "tp-config.json"), JSON.stringify(tpConfig, null, 2) + "\n");
console.log(`生成 plugins/testpilot-claude：${skills.length} 个 skill（${skills.join(", ")}）· version ${manifest.version}`);
