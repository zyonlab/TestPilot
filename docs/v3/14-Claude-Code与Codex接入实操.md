# Claude Code 与 Codex 接入实操

本文讲宿主接入：怎么把 TestPilot 接进 Claude Code（主路径），以及实验性的 Codex / Penguin。依赖安装、`server/.env`、doctor、守卫与卸载细节见 [安装与诊断](10-安装与诊断.md)。

## 1. 两个目录、两种模型

- **TestPilot checkout**：服务、MCP 与插件源码。所有安装命令都在这里运行。
- **workspace**：你要接入的工作目录，用 `--workspace` 指过去。安装会把绝对的 Node、MCP 入口和 env 文件路径写进配置，移动 checkout 或换机器后要重新安装。

规划由宿主自己的模型和登录态负责，不需要再填规划模型。执行层是 Midscene，模型取自 TestPilot 项目设置或 `server/.env`（通过 `--model-env` 引用，配置里只存路径、不复制密钥）。

接入前先把服务跑起来（默认 API `http://127.0.0.1:5301`，Web `http://localhost:5300`），在 Web 的项目页建好项目，记下**项目 ID**（不是标题）。

## 2. Claude Code（主路径）

先安装并登录 Claude Code。有三种用法，产物都写到同一个服务里，Web 上看到的是同一份。

### 2.1 从 Web 发起

什么都不用装：新建运行时规划运行时默认就是 Claude Code（`TP_AGENT_RUNTIME` 不设即 `claude-code`）。服务会为每次运行建一个独立工作区（数据目录下的 `host-workspaces/<runId>`），写入带本次运行凭证的 `.mcp.json`，再以非交互方式起 `claude`（`TP_CLAUDE_BIN` 可覆盖）。若 `plugins/testpilot-claude/` 已由 `pnpm build:claude-plugin` 生成，会话会带上 `--plugin-dir`，门禁 hook 随之生效；没生成就只有服务端门禁。

### 2.2 装成插件（推荐）或只在本次会话加载

```sh
pnpm build:claude-plugin
# 装成插件：仓库根的 .claude-plugin/marketplace.json 把本 checkout 声明为本地插件市场
claude plugin marketplace add "<checkout 的绝对路径>"
claude plugin install testpilot@testpilot
# 或者只在本次会话加载
claude --plugin-dir plugins/testpilot-claude
```

插件目录由真源 `plugins/testpilot/` 生成，内容有三样：
- 十个 skill；
- `hooks/hooks.json`：写 stories/cases/memory 前做校验，停止前要求门禁；
- `.mcp.json`：以 stdio 方式启动 `packages/testpilot-mcp`。

MCP 默认连 `http://127.0.0.1:5301`，可用 `TP_SERVER_URL` 改。

**只能从本地 checkout 安装**：`.mcp.json` 用 `${CLAUDE_PLUGIN_ROOT}/../../packages/…` 引用仓库里的 MCP 入口，hook 用 `${CLAUDE_PLUGIN_ROOT}/../testpilot/hooks/…` 引用 hook 脚本，`tp-config.json` 里还有本机绝对路径（这个文件由 build 生成，不入库）。2026-09-17 在隔离的 `CLAUDE_CONFIG_DIR` 里实测过以下几点：
- 从本地市场安装后，`CLAUDE_PLUGIN_ROOT` 指向 checkout 里的原目录，`claude mcp list` 显示 `plugin:testpilot:testpilot … ✔ Connected`；
- `claude plugin details` 列出 10 个 skill、PreToolUse 与 Stop 两个 hook；
- 已安装插件时再加 `--plugin-dir`，MCP 仍然只有一份。

更新时先重跑 build，再执行 `claude plugin marketplace update testpilot` 和 `claude plugin update testpilot@testpilot`。卸载用 `claude plugin uninstall testpilot@testpilot`，再执行 `claude plugin marketplace remove testpilot`。

### 2.3 装进自己的工作目录

```sh
node scripts/testpilot-setup.mjs install --entry claude-code \
  --workspace "<工作目录的绝对路径>" \
  --model-env "<checkout>/server/.env" \
  --server http://127.0.0.1:5301 \
  [--project-id <项目ID>]
node scripts/testpilot-setup.mjs doctor --entry claude-code
```

- 写入 `<workspace>/.mcp.json` 的 `mcpServers.testpilot`（保留其他 MCP）、`.claude/skills/` 下十个 skill、`.testpilot/bin/testpilot-mcp` shim 与收据 `.testpilot/install.json`。
- 这种方式**不装 hook**，阶段约束靠服务端门禁；要 hook 用 2.2。
- 目录可以含空格。不要用 `--env-file` 代替 `--model-env`：部分 Node 版本会把它当成 Node 自己的启动参数。
- 给了 `--project-id` 会写进 MCP 的 `TP_PROJECT_ID`；没给时注册运行要显式带项目 ID。

在 workspace 里启动 `claude`，按提示启用项目级 MCP（`.mcp.json` 第一次需要宿主确认），再用 `/mcp` 或 `claude mcp list` 看连接。skill 用 `/testpilot-run-c` 或自然语言触发。参考：[Claude Code MCP](https://code.claude.com/docs/en/mcp)、[Claude Code skills](https://code.claude.com/docs/en/skills)。

## 3. 首次使用

可以直接粘贴给宿主（替换尖括号内容）：

```text
使用 TestPilot 的 testpilot-run-c 技能。
TestPilot 项目 ID 是 <项目ID>，被测地址是 <测试环境URL>。
读取 <需求材料路径>，注册本次运行，按阶段完成模块、故事和用例。
模块树提议完停下等我冻结；最后停在 waiting_review，给出 runId，不要替我批准。
```

`testpilot-run-c` 规定的工具顺序：

1. `register_run`（无 runId 时；重试保持参数完全一致）→ `load_run_instructions` → `retrieve_spec`（chunk ID 逐字引用）。
2. 项目带产品模型时：`begin_stage`（`node:"modules"`）→ `plan_modules` 提议至少两层的模块树 → **停下，由人冻结**（`module_plan_state` 读状态，未冻结时 `claim_unit` 会被拒）。注意：宿主工具里有 `tp_stage.freeze_modules`，调用时不带运行令牌，服务端会把它当作本地操作员，所以模型在技术上可以自己冻结。目前只靠工具说明约束，见 [02 §10-1](02-工作流-横向与纵向.md#10-已知缺口2026-09-17-核对)。
3. `write_stories` → `write_cases` → `gate_run`（分数由服务端算，被拦就改用例再跑）→ `finalize_run`，状态变为 `waiting_review`。

输入 schema 以 MCP `tools/list` 为准，不要手拼旧 payload。除阶段工具外还有 `tp_project` / `tp_run` / `tp_review` / `tp_execution` 等按域分组的工具，Web 上的大部分操作都能在宿主里做；不知道 runId 时用 `tp_run.list` 找。

**成功的标志：** 宿主能看到 `register_run` / `finalize_run`；运行出现在 Web 同一项目下；故事与用例有不可变版本；finalize 后是 `waiting_review`。之后由人在 Web 复核来源与预期并批准（本地免登录，记录为 `local-operator`），再 `generate_execution` / `execute_approved`。带 `Authorization` 头的代理请求不能做审批。doctor ready、MCP 在线都代替不了这几条。

## 4. 实验性：Codex

不在初步交付的验收范围内，Web 也不能用 Codex 发起规划（服务端拒绝为 `web_planner_runtime_unsupported:codex`），只能从宿主侧用。

```sh
node scripts/testpilot-setup.mjs install --entry codex \
  --workspace "<工作目录的绝对路径>" \
  --model-env "<checkout>/server/.env" \
  --server http://127.0.0.1:5301
node scripts/testpilot-setup.mjs doctor --entry codex
```

- 写入 `<workspace>/.codex/config.toml` 里 `# BEGIN TESTPILOT` … `# END TESTPILOT` 之间的 `[mcp_servers.testpilot]`（保留宿主模型与其他 MCP）、`.agents/skills/` 下十个 skill、shim 与收据。已有未托管的 `mcp_servers.testpilot` 时拒绝安装。
- 项目级 MCP 只在受信任项目里加载；装完没出现就重启客户端或新开会话，用 `codex mcp list` 或交互界面的 `/mcp` 检查。
- `codex` 版本过旧（doctor 会标出 0.140–0.144）时，用 `TP_CODEX_BIN` 指向新版，不要为绕过版本问题换掉宿主模型。doctor 认到的可执行文件不代表另一个终端的 PATH 也一样。
- 插件形态：`pnpm build:codex-plugin` 生成 `plugins/testpilot-codex/`，其 MCP 命令是裸的 `testpilot-mcp`，需要把安装输出里的 `bin`（`<workspace>/.testpilot/bin`）加进启动 Codex 的 PATH。安装器不改个人 marketplace 或全局配置。
- 服务端适配器（`server/src/codex.ts`）以 `codex exec` 起会话时会剔除 `TP_PLANNER_*` 与 `MIDSCENE_*`，不覆盖宿主规划模型。

实测记录见 [Codex 宿主 Hyperliquid 实测](history/19-Codex宿主Hyperliquid实测.md)。

## 5. 实验性：Penguin

需要 Node 24+、Penguin CLI 与正在运行的 Penguin 服务。先在 Penguin 里创建 agent，再：

```sh
node scripts/testpilot-setup.mjs install --entry penguin --agent-id <agent-id> \
  [--project <penguin项目ID，默认 default_project>] [--penguin-home <默认 ~/.penguin>]
node scripts/testpilot-setup.mjs doctor --entry penguin
```

安装器调用 `plugins/testpilot/install.sh` 装 skill 与 hook，并在 agent 的 `system_config.yaml` 的 `tools.mcpServers` 里加一段带标记的 TestPilot MCP；保留原生规划模型和其他工具。收据写在 agent_state 目录下，卸载时 `--workspace` 指向该目录。Node 查找顺序：`TP_PENGUIN_NODE` → nvm 里最高的 Node 24+ → 当前或系统 Node 24+；`TP_PENGUIN_BIN` 可覆盖 CLI。Web 发起 Penguin 规划时还需要规划模型（`TP_PLANNER_*` 或项目模型设置）。配套评估 UI 另行安装，见 [评估扩展说明](../../extensions/penguin-evaluation/README.md)。

## 6. 排障

| 表现 | 检查 |
|---|---|
| Web 项目为空、Failed to fetch | 5301 上是不是当前 checkout 的服务；旧进程会让新前端 API 对不上。health 200 不能证明版本一致 |
| 建运行报 `planner_runtime_unavailable:claude-code` | 服务进程能否执行 `claude --version`（PATH 或 `TP_CLAUDE_BIN`）；只查可执行，不查登录态 |
| Web 发起的 Claude Code 会话里 hook 报错 | 是否跑过 `pnpm build:claude-plugin`（`tp-config.json` 是本机生成的） |
| 宿主里看不到 MCP | workspace 是否正确、项目 MCP 是否已启用/受信任、shim 与 `--model-env` 指向的文件是否还在 |
| doctor ready 但运行失败 | doctor 不测真实模型、MCP 会话、登录态和被测应用，看运行日志 |
| `installed_skills_changed` / 版本过期 | skill 在运行中途变了；新注册或明确续跑并重新绑定版本，不删旧证据、不伪造门禁 |
| 改了配置还在用旧模型 | 项目设置是否覆盖了 env、服务是否重启；运行用的是登记时冻结的模型快照 |
| 同一目录装过两个宿主后卸载不干净 | 收据只有一份、被后装的覆盖了；一个工作目录只装一个宿主 |

卸载与升级见 [安装与诊断](10-安装与诊断.md#升级与卸载)。
