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
