# Claude Code 与 Codex 接入实操

2026-09-09，针对当前源码安装器。依赖：已取得 TestPilot checkout、Node 22+ 和 pnpm；服务的 better-sqlite3 安装与启动使用相同 Node 主版本。Penguin/Web 当前规划适配需要独立 Node 24+ 与 Penguin CLI，doctor 会提示路径问题。尚未公开发布插件市场。

## 1. 两个目录、两个模型职责

TestPilot checkout 是服务/插件源码；workspace 是你要测试的应用仓库。安装命令在前者运行，--workspace 指向后者。当前安装把绝对 Node、MCP 和 env 文件路径写入配置，移动源码目录或换机器后应重新安装，不是可任意搬动的单文件包。

宿主 Claude/Codex/Penguin 使用自己的原生规划模型和登录态，不要求再填写规划模型。Midscene 使用 TestPilot 服务项目配置或 server/.env 中的执行配置。Web 用户则配置两个角色，当前可使用相同模型；以后单独修改 TP_PLANNER_*。

## 2. 服务准备

本机已有依赖与 server/.env，可直接 doctor。新机器在 TestPilot checkout：

```sh
pnpm install --frozen-lockfile
pnpm setup --entry web
pnpm doctor --entry web
```

setup 仅在 env 文件不存在时创建样例，不覆盖已有配置。编辑私有 server/.env，使用实际端点与密钥；以下仅示意字段，不要将占位值覆盖本机已有文件：

```dotenv
MIDSCENE_MODEL_NAME=your-execution-model
MIDSCENE_MODEL_BASE_URL=https://your-provider.example/v1
MIDSCENE_MODEL_API_KEY=your-private-key
TP_PLANNER_MODEL_NAME=your-planning-model
TP_PLANNER_BASE_URL=https://your-provider.example/v1
TP_PLANNER_API_KEY=your-private-key
TP_PLANNER_THINK=0
TP_PLANNER_TIMEOUT_MS=900000
```

执行层也兼容旧 OPENAI_BASE_URL/OPENAI_API_KEY；具体优先级看 server/.env.example 与 connections-env.ts。同名环境变量可能覆盖文件值。项目设置保存后优先于 env，已有运行继续使用冻结快照。仅修改 env 须重启服务；当前没有完整的 UI 恢复环境默认路径，切换前确认覆盖来源。

仅宿主管理时启动 API 即可；Web review 需要 Web：

```sh
# 终端 A：在 TestPilot checkout
pnpm server:dev
# 终端 B：在 TestPilot checkout
pnpm dev
```

也可使用 node scripts/testpilot-setup.mjs start --entry web 同时启动。Web 默认 http://localhost:5300，API 默认 http://127.0.0.1:5301。在 Web 设置→项目，新建或选择项目，记住项目 ID（不是标题）；项目可对应独立目标应用 URL。需要真实执行时启动目标应用。

停止时在启动终端 Ctrl+C，再检查下面命令没有残留监听；只关闭自己启动的进程，不按进程名批量杀掉用户服务：

```sh
lsof -nP -iTCP:5300 -iTCP:5301 -sTCP:LISTEN
```

## 3. 安装 Codex

先安装并登录 Codex 原生客户端。本机已有，doctor 已识别 codex-cli 0.153.4；这是本机验证版本，不是全平台最低版本承诺。在 TestPilot checkout 执行，替换 workspace 为实际被测仓库：

```sh
node scripts/testpilot-setup.mjs install --entry codex \
  --workspace "/absolute/path/to/application" \
  --model-env "/Users/admin/Midscene/testpilot/server/.env" \
  --server http://127.0.0.1:5301
node scripts/testpilot-setup.mjs doctor --entry codex \
  --workspace "/absolute/path/to/application"
```

其他机器把 --model-env 改为自己的 TestPilot 路径。可选 --project-id 实际项目ID；未提供时，运行注册需要显式给出项目。不要使用 --env-file 代替 --model-env。

安装产物：workspace/.codex/config.toml 中的 TestPilot MCP 段、.agents/skills 下的十个技能、.testpilot/bin shim 与安装收据。宿主原有模型和其他 MCP 保留。官方说明项目级 MCP 仅在受信任项目加载；Codex 从仓库 .agents/skills 发现技能。[MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[技能发现](https://learn.chatgpt.com/docs/build-skills)。

在 Codex 中打开对应 workspace 的本地任务，按原生项目提示启用自己的项目配置；若未出现新技能/MCP，重启客户端或新开该项目会话。在该项目终端执行 codex mcp list；交互界面的 /mcp 可检查连接。也可用自然语言明确要求使用 testpilot-run-c，避免依赖不同客户端的选择器样式。

若 PATH 中旧 Codex 无法调用宿主当前模型，用 TP_CODEX_BIN 指向已安装的新版本；不要换掉用户的模型来掩盖版本错误。诊断程序识别哪个可执行文件，不代表另一个终端的 PATH 已同步。

## 4. 安装 Claude Code

先安装并登录 Claude Code。然后在 TestPilot checkout 执行：

```sh
node scripts/testpilot-setup.mjs install --entry claude-code \
  --workspace "/absolute/path/to/application" \
  --model-env "/Users/admin/Midscene/testpilot/server/.env" \
  --server http://127.0.0.1:5301
node scripts/testpilot-setup.mjs doctor --entry claude-code \
  --workspace "/absolute/path/to/application"
```

安装写 workspace/.mcp.json 和 .claude/skills，不复制规划密钥。在目标 workspace 启动 claude，在项目 MCP 提示中启用 testpilot，然后用 /mcp 或 claude mcp list 查看连接。项目 .mcp.json 第一次需要 Claude 自身的启用确认，这是宿主的加载机制。技能可用 /testpilot-run-c 或自然语言触发。[Claude MCP](https://code.claude.com/docs/en/mcp)、[Claude skills](https://code.claude.com/docs/en/skills)。

目前两宿主共用一个安装收据：同一个 workspace 连续安装 Claude 和 Codex 会覆盖收据，影响后续升级/卸载。P-12 将修复；目前每个 workspace 安装一个宿主，或使用各自独立 checkout。不要把两次独立干净目录测试声称为共存已验收。

## 5. 首次使用与成功检查

可粘贴给宿主的提示（替换项目 ID、材料路径和目标 URL）：

```text
使用 TestPilot 的 testpilot-run-c 技能。
TestPilot 项目 ID 是 <实际项目ID>，目标是 <测试环境URL>。
读取 <需求材料路径>，先确认需求和领域规则的出处，再注册本次运行。
由你自己的规划模型完成故事与用例设计；通过 TestPilot MCP 写入并执行阶段门禁。
将结果停在 waiting_review，给出 runId 和 Web 中的对应入口；不要代替人批准。
```

正常工具链是 register_run→load_run_instructions→retrieve_spec→write_stories→write_cases→gate_run→finalize_run。具体输入 schema 以当前 MCP tools/list 为准，不手工拼过时 payload。检索返回的 chunk ID 和阶段 revision 必须保留。注册重试沿用同一幂等参数；宿主不知道准确模型身份时标为未知。

检查：宿主能看到 register_run/finalize_run；注册后的 run 在 Web 同项目出现；故事与用例有不可变 revision；finalize 后是 waiting_review。人类在 Web 核对来源/expected，直接作出审批决定（无需身份验证），再 generate_execution / execute_approved。单纯 doctor ready、MCP 在线或出现目录不是这些结果的替代。

2026-09-10 用户决定取消本地审核身份验证。Web 不再显示身份或解锁控件；无需 TP_REVIEW_TOKEN，服务不再生成 reviewer-token。审批记录使用 local-operator，表示本地操作来源，不能当作已验证的真人身份。显式带 agent Authorization 的请求仍不能审批；无凭证的本地 API 已不构成客户端身份隔离。宿主 MCP 的 run 能力和版本检查保留，宿主仍须等待操作方的审批决定。

## 6. Penguin 与升级卸载

Penguin 先创建 agent，然后在 TestPilot checkout 使用 pnpm setup --entry penguin --agent-id 实际ID --project 实际项目ID。宿主保留原生 planner；配套评估 UI 当前单独运行，见 [扩展安装和门禁](../../extensions/penguin-evaluation/README.md)。不要把仅装技能等同于评估扩展已经启动。

同宿主重复 install 更新托管内容；升级前保留自己修改过的技能，因为 install 的复制更新不同于 uninstall 的哈希保留策略。卸载在 TestPilot checkout：

```sh
node scripts/testpilot-setup.mjs uninstall --workspace "/absolute/path/to/application"
```

卸载删除收据追踪且哈希未变的文件，保留改过技能和用户材料。数据/env 不删除，宿主模型与账号保留。当前 plugins/testpilot-codex 是有效插件目录，公共市场安装未发布；项目级安装是本指南已验证路径。

## 7. 排障与已验证范围

| 表现 | 检查 |
|---|---|
| 菜单打开但项目空、Failed to fetch | 服务是否是当前 checkout；5301 旧进程会导致新版前端 API / CORS 不匹配。只读 health 200 不足以证明版本一致 |
| MCP 未出现 | workspace 是否正确、项目配置是否启用、CLI 路径是否可执行、checkout/env 引用是否仍存在 |
| doctor ready 但运行失败 | doctor 当前只作 CLI/依赖/配置预检，不测试真实 provider、MCP 会话、API 作用域或 SUT |
| 收到 installed_skills_changed / stale revision | 新注册/明确续跑并重新绑定版本；不删除旧证据或伪造 gate |
| Web 失败 session 不在了 | 查看最后阶段/输入/预算与日志；先判断是否可续，可直接恢复，无需审核登录，不盲目再次创建 |
| 配置改了仍用旧模型 | 当前项目是否覆盖 env；服务是否重启；查看运行被冻结的模型快照 |

本轮 node --test scripts/test/setup.test.mjs 四项通过，含 Claude/Codex 独立干净目录与含空格路径、重复安装、真实 stdio 握手 tools/list、修改后卸载保留；Web env 保留与 Penguin 配置合并。模型 API 使用合成配置，没有收费模型请求；本轮没有重新执行三宿主端到端生成。日志在 evidence/ui-review-2026-09-09/install-tests.tap。

## 8. 2026-09-10 · 新增原生 Codex 实测

已对 Hyperliquid 项目的冻结 Explore 材料做原生 Codex → MCP → Web 独立复核 → 原生 MCP 提交执行 → Midscene 报告的真实验证：8 模块、6 故事、10 用例，10/10 通过。不是重新 Explore、公共市场安装或完整金融领域测试。原生适配器使用 0.153.4 与既有登录态，不配置独立 planner；过程、命令与证据见 [19](19-Codex宿主Hyperliquid实测.md)。前述 §7 的“未重新执行”仅描述 09-09 安装检查。
