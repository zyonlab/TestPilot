# Codex 插件与 Web Explore 实测（2026-09-24）

结论：插件安装、MCP 握手和 Web 调用本机 Codex 通过；Explore 已实际启动并重试，但因目标页面导航超时失败，不能标为端到端通过。

- 项目：prj-mu96i5c2-1001
- 运行：run-1286d127-0163-4e82-9d6a-76c8f648fece
- Web：http://localhost:5300/#/?open=canvas&project=prj-mu96i5c2-1001&run=run-1286d127-0163-4e82-9d6a-76c8f648fece
- 安装：codex plugin add testpilot-codex@personal --json，版本 2026.9.23+skill.1；生成插件一致性检查通过（22 文件）。
- 补齐 ~/.local/bin/testpilot-mcp 启动器，stdio 握手及 listTools 成功，共 47 工具。
- 本机 PATH 中 Codex 0.144.5 调用默认模型返回需要升级。桌面内置版本 0.154.0-alpha.6.2 可发起请求；server/.env 的 TP_CODEX_BIN 指向 /Applications/ChatGPT.app/Contents/Resources/codex，重启后生效。未修改默认模型。
- 从 Web 聊着填实际发送连接测试，收到“Codex 连接验证成功”；未保存测试草稿。
- 从 Web 新建运行：Codex，领域知识和规则包均选 Hyperliquid Testnet 内置示例，8 屏、带钱包、禁止状态变更；运行参数已冻结两份示例 ID 与 plannerRuntime=codex。
- Explore 首次与原运行重试均报 Navigation timeout of 45000 ms exceeded；独立浏览器访问目标也返回 net::ERR_CONNECTION_CLOSED。HTTP HEAD 200 不能证明浏览器页面可用。
- 仅有注册、知识、上下文与尝试记录；没有页面观察输出。modules 及后续节点未执行，已设置断点。
- 额外 CLI 插件调用 tp_project/planner_host 被自动审批策略拒绝（工具要求审批，CLI 为 never），不能将握手通过表述为所有插件调用通过。

待目标浏览器访问恢复后，在同一运行点击“续完当前节点”，仍在 modules 前暂停。Explore 使用 Midscene 执行器；本次没有测试后续 Codex 模块/故事规划质量。
