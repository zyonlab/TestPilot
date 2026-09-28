# 项目领域知识与规则包

新建测试运行时分别选择领域知识与规则包的固定版本。Hyperliquid Testnet 项目默认选中内置示例，其他项目默认不使用；每个下拉均可选择「本次不使用」。内置示例是未验证的规划起点，不能作为 Gold 或产品业务断言。

「聊着填」带入当前选中内容作为 previous 草稿。对话生成后点击「保存到项目并选用」才保存；保存成功后选中返回的版本。宿主写入后点击刷新即可选择。保存资料不会创建运行。

固定存储：服务数据目录 testpilot.db 的 domain_knowledge 表保存领域知识；rule_packs 表继续保存规则包。内容哈希标识版本，同内容去重，不覆盖旧版。领域知识（业务概念）与 domain_references（不变量参考）分开管理。既有领域参考仍按原逻辑绑定。

内置正本位于 examples/hyperliquid-testnet/domain-knowledge.md 和 rule-pack.json。它们不依赖用户的旧运行、Gold、钱包或清空后的项目物料，修改后另存为项目版本。内置版本 ID 含内容哈希；若部署更新示例内容，过期选择会被拒绝，须刷新重新选择。

宿主与 UI 共用接口：

- GET /api/projects/:projectId/knowledge-library/:kind：列出版本，含内置示例。
- GET /api/projects/:projectId/knowledge-library/:kind/:id：读取 value。
- POST /api/projects/:projectId/knowledge-library/:kind：提交 {title?, value}，返回 {id}。

kind 为 domainKnowledge（value 为文本）或 rulePack（value 为规则包对象）。MCP host project 动作对应 knowledge_library、knowledge_library_entry、save_knowledge_library。

创建 workflow-runs 时提交 knowledgeSelection、rulePackSelection 为对应版本 id；null 表示明确不使用。未提供 rulePackSelection 的旧调用仍默认使用项目当前规则包。服务端从项目范围读取，拒绝不存在或跨项目的版本，将所选正文冻结到运行产物，并记录选中 ID。后续另存新版本不改写已有运行。

## Web 的本机宿主

新建运行和聊着填显示项目选择的 Codex / Claude Code 及登录检查结果。两个宿主都已登录时由用户明确选择；选择保存在服务数据目录的 project_planner_hosts 表。一个可用宿主时可自动使用。状态每 30 秒更新，也可手动刷新；发送和创建时服务端重新检查。

GET /api/projects/:id/planner-host 读取状态；POST 同一路径提交 {runtime:"codex"|"claude-code"}。MCP 项目动作 planner_host / select_planner_host 共用这两个接口。

Web 创建运行提交 planner:"connected"，服务器解析项目当前选择并将实际 runtime 固定到运行。起草、诊断及用例问答提交 useHost:true，由该宿主启动独立 CLI 任务，继续沿用宿主自身模型与登录配置，不注入 TestPilot 的规划或执行模型密钥。不接管当前聊天会话；不声称读取到未回报的实际模型名称。宿主失效或选择缺失会拒绝，不自动回退 API 模型。

起草进程使用临时工作目录、文本 stdin、受限工具选项，最多运行 180 秒；输出大小受限，结束后清理临时目录。模型输出仍走既有字段校验，保存仍需用户点击。Codex 实际调用已通过最小起草验证；Claude 适配器通过受控进程测试，尚未执行真实模型起草验证。
