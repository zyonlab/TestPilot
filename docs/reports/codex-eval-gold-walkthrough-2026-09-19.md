# Codex 插件与评测 / Gold 实走记录

## 结论

未跑通「准备 Gold → 生成 A/B → 评分 → 选版」。当前两张实验定义都不能启动；Gold 可以读取与编辑已有草稿，但缺少新建基准和新增条目入口。上一轮通过的是工作台交互与有效性保护，不是完整评测业务验收。

## 实际走了哪些步骤

| 步骤 | 真实入口 | 观察 |
|---|---|---|
| 检查服务 | 会话已安装的 Codex TestPilot 工具 `tp_system.health` | 连到 main 实例，非页面预览实例 |
| 列实验 | `tp_eval.specs` | 主实例尚无新版 preflight 字段 |
| 启动领域实验 | `tp_eval.run_spec(domain-perp)` | 旧主实例返回 ok/running，无运行 ID |
| 查询记录 | `tp_eval.evals` | 空列表；旧版本的成功响应不证明已启动 |
| 打开 Gold | 浏览器真实页面 | 默认 casegen 已冻结；编辑与保存禁用符合状态 |
| 切换领域数据 | 浏览器 + `tp_eval.gold` | 12 条草稿，正式 gold 缺失，留出项 0，仍是 legacy reviewPolicy |
| 重跑最新版插件 | MCP SDK 连接 Codex 插件的真实 stdio 入口，TP_RUNTIME=codex，指向与页面相同的 5311 | tools/list、specs、两个 run_spec、evals 均为实际协议调用，无模拟传输 |
| 启动领域实验 | 最新版插件 `tp_eval.run_spec` | 400 eval_gold_unavailable |
| 启动运行时实验 | 最新版插件 `tp_eval.run_spec` | 400 eval_runtime_unsupported；预检查还报告流程缺失 |
| 验证 Gold 权限 | 最新版 tools/list、手造 set_gold、实际 HTTP 请求 | set_gold 不注册；协议参数拒绝；HTTP agent 来源冻结返回 403 operator_action_required |
| 检查产品导航 | 浏览器点击「查看并人工复核对应 Gold」 | 自动定位到领域草稿，明确显示没有正式 gold、没有留出项、冻结禁用 |

会话里已经启动的 MCP 插件不会因为浏览器 URL 的 api 参数变化而切换网关。本次保留原主实例；最新版验证另外启动同一个插件入口并显式绑定预览网关，没有声称已安装插件已热更新。

## 本轮修复

- Gold 页面增加基准范围说明、冻结只读说明、保存与留出项前置条件、错误与重试；不再把请求失败吞成空页。
- 切换基准时立即清空上一份内容并忽略过期请求，避免旧数据覆盖新选择；保存时禁止切换，未保存改动禁止冻结。
- 从评测定义直接跳到对应 Gold，增加插件网关一致性提示。
- 修复旧 README 裸指纹格式下「开新谱系」仍被当作已冻结的问题；用临时基准测试覆盖，没有改真实 benchmark。
- 补上 Gold 冻结的服务端来源判定，并将 set_gold 从 agent 可调用动作中移除；宿主覆盖口径为 182/182、UI 专属 11。

## 尚未解决的实际条件

1. 领域草稿仍使用旧接口判据，不能直接充当当前 UI 测试生成任务的可信 Gold。需要人按屏幕可见结果复核、准备留出划分并冻结；本轮没有代签或改金标。
2. native runtime 对照仍无评测执行适配器，不能通过改标签或回落 graph 算作跑通。
3. 缺可视化实验创建 / 编辑，以及 Gold 新建 / 添加条目流程。
4. 常用主实例及已安装插件仍需在适当时机重启到当前代码，并与产品页面绑定同一网关。

## 验证

全量 Vitest 1430 项通过（含新增旧格式谱系回归），类型检查、生产构建、drift、host parity、domain neutrality 通过。MCP Node 4 项通过。浏览器观察、真实插件与实际 HTTP 结果见同名 JSON。

没有真实模型生成、没有 A/B 分数、没有最佳版本结论；没有修改 benchmark 金标 / 草稿 / 留出答案，没有提交或推送。
