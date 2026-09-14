#!/usr/bin/env bash
#
# 把这个 plugin 装到一个 Penguin agent 上。
#
# 为什么需要它：PenguinHarness 的 plugin 库只认**宿主 package.json 的 dependencies 里
# `@penguinharness/` 开头的包**（`pluginRoots()` 用 require.resolve 从 core 自己的位置解析）。
# `plugins/testpilot/` 是本仓库的一个目录，不是装在 penguin 的 node_modules 里的 npm 包，
# 所以 `penguin plugin install` 根本看不见它。
#
# 这个脚本做的事和官方安装器（`agent-state.ts` 的 `installSkill` / `installHook`）一样：
#   skills/<name>/  → agent_state/skills/<name>/       （frontmatter 重新生成）
#   hooks/*         → agent_state/hooks/testpilot/     （外加生成 hooks.json）
#   icon.svg        → 两边各一份
#   tp-config.json  → hook 找仓库和阈值用的，**由这里生成，不进仓库**（含绝对路径）
#
# 用法：
#   ./install.sh --agent-id testpilot-c [--repo <仓库根>] [--penguin-home ~/.penguin]
#                [--project default_project] [--min-gate-score 0.6] [--min-negative-ratio 0.3]
#                [--skills a,b,c]        只装这几条（消融实验用）
#                [--dry-run]
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="$(basename "$PLUGIN_DIR")"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"
PENGUIN_HOME="${PENGUIN_HOME:-$HOME/.penguin}"
PROJECT="default_project"
AGENT_ID=""
MIN_GATE_SCORE="0.6"
MIN_NEGATIVE_RATIO="0.3"
ONLY_SKILLS=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --agent-id)           AGENT_ID="$2"; shift 2 ;;
    --repo)               REPO_ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    --penguin-home)       PENGUIN_HOME="$2"; shift 2 ;;
    --project)            PROJECT="$2"; shift 2 ;;
    --min-gate-score)     MIN_GATE_SCORE="$2"; shift 2 ;;
    --min-negative-ratio) MIN_NEGATIVE_RATIO="$2"; shift 2 ;;
    --skills)             ONLY_SKILLS="$2"; shift 2 ;;
    --dry-run)            DRY_RUN=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[ -n "$AGENT_ID" ] || { echo "要 --agent-id。" >&2; exit 2; }

STATE="$PENGUIN_HOME/data/$PROJECT/agents/$AGENT_ID/agent_state"
if [ ! -d "$STATE" ]; then
  echo "找不到 $STATE" >&2
  echo "先建 agent：penguin agent create --agent-id $AGENT_ID --name … --description …" >&2
  exit 1
fi

SKILLS_DST="$STATE/skills"
HOOKS_DST="$STATE/hooks/$PLUGIN_NAME"

echo "plugin : $PLUGIN_DIR"
echo "repo   : $REPO_ROOT"
echo "agent  : $AGENT_ID  ($STATE)"
[ "$DRY_RUN" = 1 ] && echo "（dry-run，不写任何东西）"

# ---------------------------------------------------------------- skills
# frontmatter 由安装器**生成**，和官方 `stampSkill` 同一个做法：
# 库里的 SKILL.md 只带 name + description，装出去的那份带完整的、规范字段序的 frontmatter。
# 这样装好的副本是自描述的——更新检查读它的 version，UI 读它的短描述。
python3 - "$PLUGIN_DIR" "$SKILLS_DST" "$ONLY_SKILLS" "$DRY_RUN" <<'PYEOF'
import json, os, re, shutil, sys

plugin_dir, skills_dst, only, dry = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
manifest = json.load(open(os.path.join(plugin_dir, "plugin.json")))
versions = manifest.get("skillVersions", {})
icon_path = os.path.join(plugin_dir, "icon.svg")
icon = open(icon_path).read() if os.path.exists(icon_path) else None
wanted = set(s.strip() for s in only.split(",") if s.strip()) if only else None

src_root = os.path.join(plugin_dir, "skills")
for name in sorted(os.listdir(src_root)):
    src = os.path.join(src_root, name)
    if not os.path.isdir(src):
        continue
    if wanted is not None and name not in wanted:
        print(f"  skill  {name:28s} 跳过（--skills 没点它）")
        continue

    body_path = os.path.join(src, "SKILL.md")
    raw = open(body_path).read().lstrip("﻿")
    m = re.match(r"^---\r?\n(.*?)\r?\n---", raw, re.S)
    if not m:
        raise SystemExit(f"{body_path} 没有 frontmatter")
    fields = {}
    for line in m.group(1).splitlines():
        i = line.find(":")
        if i > 0:
            fields[line[:i].strip()] = line[i + 1:].strip()
    desc = fields.get("description", "")
    if len(desc) > 1024:
        raise SystemExit(f"{name}: description {len(desc)} 字符，超过 1024")
    if not re.fullmatch(r"[a-z0-9-]{1,64}", name):
        raise SystemExit(f"{name}: skill 名必须是 ≤64 的小写连字符")

    version = versions.get(name, manifest["version"])
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}\.\d+", version):
        raise SystemExit(f"{name}: version {version} 不是 YYYY-MM-DD.N")

    front = ["---", f"name: {name}", f"description: {desc}"]
    for k in ("short_description", "short_description_zh"):
        if manifest.get(k):
            front.append(f"{k}: {manifest[k]}")
    front += [f"version: {version}", "---"]
    stamped = "\n".join(front) + raw[m.end():]

    dst = os.path.join(skills_dst, name)
    extras = [f for f in sorted(os.listdir(src)) if f != "SKILL.md"]
    print(f"  skill  {name:28s} v{version}" + (f"  +{len(extras)} 个附件" if extras else ""))
    if dry:
        continue
    os.makedirs(dst, exist_ok=True)
    open(os.path.join(dst, "SKILL.md"), "w").write(stamped)
    for f in extras:
        s = os.path.join(src, f)
        d = os.path.join(dst, f)
        shutil.copytree(s, d, dirs_exist_ok=True) if os.path.isdir(s) else shutil.copy2(s, d)
    if icon:
        open(os.path.join(dst, "icon.svg"), "w").write(icon)
PYEOF

# ---------------------------------------------------------------- hooks
python3 - "$PLUGIN_DIR" "$HOOKS_DST" "$REPO_ROOT" "$MIN_GATE_SCORE" "$MIN_NEGATIVE_RATIO" "$DRY_RUN" <<'PYEOF'
import json, os, shutil, sys

plugin_dir, hooks_dst, repo, gate_s, neg_r, dry = sys.argv[1:7]
dry = dry == "1"
manifest = json.load(open(os.path.join(plugin_dir, "plugin.json")))
name = os.path.basename(plugin_dir)
h = manifest.get("hooks", {})

# 和官方 installHook 生成的 HookManifest 完全同形：三个点都必须在，缺的写空数组。
hooks_json = {
    "name": name,
    "description": manifest["description"],
    "version": manifest["version"],
    "stop": h.get("stop", []),
    "pre_tool_use": h.get("pre_tool_use", []),
    "user_prompt": h.get("user_prompt", []),
}
if manifest.get("description_zh"):
    hooks_json["description_zh"] = manifest["description_zh"]

src = os.path.join(plugin_dir, "hooks")
for point in ("stop", "pre_tool_use", "user_prompt"):
    for cmd in hooks_json[point]:
        if not os.path.exists(os.path.join(src, cmd["command"])):
            raise SystemExit(f"plugin.json 的 {point} 指着 {cmd['command']}，但 hooks/ 里没有这个文件")
        print(f"  hook   {point:14s} {cmd['command']}  (timeout {cmd.get('timeout', 60)}s)")

if dry:
    raise SystemExit(0)

os.makedirs(hooks_dst, exist_ok=True)
for root, dirs, files in os.walk(src):
    dirs[:] = [d for d in dirs if d not in (".state", "__pycache__")]
    for f in files:
        # tp-config.json 由这里生成（它含绝对路径），源码树里那份不拷过去。
        if f == "tp-config.json":
            continue
        s = os.path.join(root, f)
        rel = os.path.relpath(s, src)
        d = os.path.join(hooks_dst, rel)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copy2(s, d)

open(os.path.join(hooks_dst, "hooks.json"), "w").write(json.dumps(hooks_json, indent=2) + "\n")
open(os.path.join(hooks_dst, "tp-config.json"), "w").write(
    json.dumps({"repoRoot": repo, "minGateScore": float(gate_s), "minNegativeRatio": float(neg_r)}, indent=2) + "\n"
)
icon = os.path.join(plugin_dir, "icon.svg")
if os.path.exists(icon):
    shutil.copy2(icon, os.path.join(hooks_dst, "icon.svg"))
PYEOF

if [ "$DRY_RUN" = 0 ]; then
  echo
  echo "装好了。"
  echo "  skills : $SKILLS_DST"
  echo "  hooks  : $HOOKS_DST  (hooks.json + tp-config.json)"
  echo
  echo "hook 要能 import 仓库里的 TS（tsx 从 packages/testpilot-mcp 解析），确认这条能跑："
  echo "  node -e 'require(\"$REPO_ROOT/packages/testpilot-mcp/node_modules/.bin/..\")' 2>/dev/null || true"
  echo "  ls $REPO_ROOT/packages/harness-testing/src/casegen/gate.ts"
fi
