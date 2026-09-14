# Codex 宿主 · Hyperliquid 实测

2026-09-10。原生 Codex 规划、独立复核、原生 MCP 提交执行、Midscene 浏览器执行、Web 查看物料和报告的链路通过。最终 **10 / 10 通过，0 环境错误**。本轮没有修改生成用例、expected 或 oracle 后重跑。

## 运行身份与来源

| 项目 | 实测值 |
| --- | --- |
| TestPilot 项目 | Hyperliquid Testnet · prj-mtveukwc-1001 |
| 新 run | run-ca300440-422b-4b54-b86f-9f6da5fb8424 |
| 宿主 | Codex CLI 0.153.4，使用已有 ChatGPT 登录与原生规划配置 |
| 规划模型名称 | 原生 exec 事件未报告，记录 unknown；没有替换成 Web planner |
| 执行模型 | 现有项目配置 qwen3-8-27b |
| 执行环境 | Desktop 1440，1440 × 1000，未连接钱包 |
| 输入 | 复用上轮冻结的 exploration.md，源与新材料 SHA256 完全一致 |
| 新探索 | 本轮没有重新 Explore；浏览器测试执行是新运行 |
| 产出 | 8 模块、6 故事、10 用例，均为公开页面导航/展示冒烟用例 |
| 执行 | exec-54fa4afb-89d6-43fb-888d-65207d02f0e4 |
| 结果版本 | rev-1c64f3bc-5e44-4fe9-a51f-8606610141b0 |

[打开 Codex 工作台](http://localhost:5300/#/?open=canvas&project=prj-mtveukwc-1001&run=run-ca300440-422b-4b54-b86f-9f6da5fb8424) · [打开执行报告](http://localhost:5300/#/?open=runs&project=prj-mtveukwc-1001&run=run-ca300440-422b-4b54-b86f-9f6da5fb8424&artifact=rev-1c64f3bc-5e44-4fe9-a51f-8606610141b0)

原 Web run 和其全部失败/重跑历史保留，未替换或融合。当前同一项目下有两个独立 workflow run。

## 实际调用路径

1. 原生适配器注册新 run 并冻结同一探索材料；提供此 run 的 MCP 凭证文件，凭证不交给规划模型。
2. Codex 通过 MCP 调用 begin_stage、load_run_instructions、retrieve_spec、write_stories、write_cases、gate_run、finalize_run；19 次阶段工具调用，内部 run_pipeline 调用 **0 次**。
3. Codex 停在 waiting_review。随后本地验收操作者通过真实 Web UI 复核并批准 10 个版本，备注明确“自动化工程验收，不是真人 Gold”。宿主没有批准自己的用例。
4. 第二个原生 Codex 会话沿用同一 TestPilot runId，调用 get_project_run、generate_execution、execute_approved。两阶段使用不同原生会话 ID；不把它描述成原生 Codex thread resume 已验收。
5. Midscene 执行 10 个批准版本，20 次转发模型请求，耗时 197.25 秒。报告、每条判据与截图在 Web 的同一 run 下可读。

本轮测试的是 `server/src/codex.ts` 原生适配器、项目级 Skill 与真实 stdio MCP，不是公共插件市场发布或所有安装场景的复验。生成会话与执行提交会话的工具名、使用量、会话 ID 分别保存在证据中。

## 发现与修复

- **宿主规划状态停留在 registered**：原生宿主从冻结材料直接进入 instructions，没有经过 Web 的 source 开始事件。beginStage 现在为所有生成节点同步 running；断点仍先判断，已完成节点保持原版本。17 项控制/路由/Codex 回归通过。首次新增测试因缺少假执行模型配置失败，补齐隔离测试配置后复验通过。
- **运行列表无法直接区分宿主**：工作台、复核、物料、运行报告的 run 选择器增加 Codex / Claude Code / PenguinHarness / Web 标识，节点详情继续展示规划来源与真实加载 Skill 摘要。
- **覆盖不足仍保留**：门禁有 negative-ratio 警告，10 条全部是正常路径，负例比例 0。当前门禁的全局警告不计入被警告用例占比，规则评分仍为 100%。没有因此声称覆盖完整，也没有伪造负例去满足比例。

## 结果如何解释

| 对比项 | 上轮 Web | 本轮 Codex |
| --- | --- | --- |
| 冻结探索材料 | 同一来源 | 相同内容哈希 |
| 模块 / 故事 / 用例 | 6 / 6 / 22 | 8 / 6 / 10 |
| 已批准 / 拒绝 | 16 / 6 | 10 / 0 |
| 最终批准用例执行 | 15 通过 / 1 失败 | 10 通过 / 0 失败 |
| 判据范围 | 包含多字段模型判定 | 10 条明确文本存在判据 |
| 性质 | 工程调试验收 | 宿主接入与公开页面冒烟验收 |

不能用 10/10 对 15/16 得出 Codex 更专业或自进化改善：两次生成的用例数、断言复杂度、提示和调试历史不同。本轮未覆盖下单、保证金、清算、精度等核心金融规则，也没有加入独立领域知识或新增真人 Gold。

Codex 规划与执行提交的原生使用量合计：input 1,494,022（其中 cached input 1,394,560）、output 4,882。宿主没有提供可核实的单次规划调用数或价格，因此费用和规划调用数保持 unknown；缓存 token 是 input 的子集。执行层 20 次真实请求单独记账，不能把二者混成“20 次大模型调用”。

## 验证与复现

- [汇总](evidence/codex-hyperliquid-2026-09-10/summary.json)、[生成调用](evidence/codex-hyperliquid-2026-09-10/generation.json)、[原生执行提交](evidence/codex-hyperliquid-2026-09-10/native-execution-dispatch.json)。
- [执行结果](evidence/codex-hyperliquid-2026-09-10/execution.json)、[门禁警告](evidence/codex-hyperliquid-2026-09-10/gate.json)、[按角色记账](evidence/codex-hyperliquid-2026-09-10/spend.json)。
- [UI 检查](evidence/codex-hyperliquid-2026-09-10/ui-checks.json)：区分两种来源、原生模型/Skill 身份、跨模块故事、范围带入复核、门禁警告和执行报告。
- [验证索引](evidence/codex-hyperliquid-2026-09-10/README.md)：17 项定向回归、服务/前端类型检查、生产构建通过。

在服务和原生 Codex 登录就绪后，从 TestPilot checkout 运行下列显式真实验收命令，会创建新 run；读取 stdout 的新 runId，不覆盖本轮原始证据：

```sh
TP_EVIDENCE_DIR=/absolute/path/to/new-evidence \
pnpm --filter testpilot-server exec tsx scripts/verify-codex-project.ts --real \
  --project prj-mtveukwc-1001 \
  --source-run run-38041ca0-630b-44d5-bca4-9f47623400a4 \
  --source-revision rev-6ca35f69-cb59-4923-a61f-39ea870937d0
```

在 Web 独立完成该 run 的复核后，用其新 ID 运行 `scripts/execute-codex-project.ts --real --project <projectId> --run <newRunId> --env <environmentId>`。该脚本只让 Codex 编译/提交执行，不自动审批。执行是异步的，是否通过以 API / Web 最终结果为准。
