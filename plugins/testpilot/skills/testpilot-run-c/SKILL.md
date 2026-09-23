---
name: testpilot-run-c
description: Runs TestPilot generation with this host as planner, immutable project inputs, validated stories and cases, a deterministic server gate, and finalization for human review. Use for normal project test generation in Claude Code, Codex or PenguinHarness.
---

# TestPilot 宿主规划工作流

宿主模型负责理解、故事拆解和用例设计。Midscene 的执行模型另由项目配置提供。
服务端保存阶段事实与门禁凭证，Web 展示同一批产物并交给用户复核。

## 你在这里能做的不止是跑一遍流水线

除了下面这串阶段工具，还有一组按域分的工具（`tp_project` / `tp_run` / `tp_stage` /
`tp_unit` / `tp_artifact` / `tp_review` / `tp_execution` / `tp_case` / `tp_report` /
`tp_export` / `tp_settings` / `tp_eval` / `tp_queue` / `tp_graph` / `tp_wf` /
`tp_audit` / `tp_system`）——**Web 界面上能做的操作，这里基本都能做**：建项目、挂规则包、
读进度与中间产物、看执行报告与基线、导出能自己跑的测试工程、读记分板。
每个工具的 `action` 枚举里写着它能干什么。

三件事要记住：

- **不知道 runId 就先找。** 它只在服务器上，你上一次会话结束就忘了。
  `tp_run.list({projectId})` 把这个项目跑过的都列出来，`tp_run.checkpoint` 说它停在哪。
- **参数不全不要猜。** 建项目缺 `targetUrl`、跑执行缺 `codeRevision`——问人，
  人答完再调一次。编一个地址比报错更糟。
- **人的决定要人来做。** 冻结模块树、批准用例、立基线——把内容摆给人看，
  人点头了你再调那个工具。这条和界面上是同一条：agent 是那只手，不是那个拍板的人。

## 顺序

1. 没有 runId 时，调用 `register_run`：传项目 ID、宿主运行时、稳定的 externalId/idempotencyKey，以及材料原文数组 `{name,text}`。重试保留完全相同的参数。宿主模型身份只有确定时才报告；未知留空。已由 Web 或运行适配器注册时，直接使用提供的 runId。
2. 调用 `load_run_instructions(runId)`，读取返回的 stories/design skill 和领域 references。返回的 loadedDigest 指认服务端实际下发的内容；它不证明模型遵守了所有规则。若响应含 memory，只把它当历史执行观察，按当前物料复核；memory.digest 与来源用于消费审计，不能覆盖需求或判据。
3. 调用 `retrieve_spec({runId,query,budgetTokens})`。材料只能来自本次冻结的版本，chunk ID 按返回值逐字引用。未取到的段按 chunkIds 继续取。
4. 项目带产品模型时，先做模块规划：`begin_stage({runId,node:"modules"})`，再按材料提议模块树并调用 `plan_modules({runId,content})`。**树至少两层**：顶层 3–7 个模块，每个顶层模块下面要有子模块，子模块的 `parentId` 指向它——一层平铺的清单会被判 `module_tree_is_a_list`（不带点号的平铺清单同样算）。层级写在 `parentId` 里，不是写在名字里；每个模块都要有 `evidence`；材料的每一段要么被某个模块的 `evidence` 引用，要么进顶层的 `outOfScope:[{sectionId,reason}]`（字段名就是 `sectionId`，值取材料段 id）并说明理由——「界面上看不到」是覆盖缺口，不是范围外。模块按用户要完成的事切，不按屏幕分区切。机检有 error 会整份拒收并指出是哪个模块。**提议通过之后停在这里**：冻结必须由人做，模型没有这个工具；树没冻结，`claim_unit(node:"stories")` 会被拒。用 `module_plan_state(runId)` 读当前状态。
5. 按 `testpilot-stories` 的规则思考并调用 `write_stories({runId,content})`。模型提交 StoryBundle，服务端校验并保存不可变版本。
6. 按 `testpilot-design` 的规则设计并调用 `write_cases({runId,content})`。CaseBundle 的 stories 必须保留上一阶段内容，每条用例 sourceRefs 引用本次检索返回的段。
7. 调用 `gate_run(runId)`。服务端对当前用例版本计算分数与 findings。被阻止时按具体问题修改用例，再调用门禁。模型不提交分数或阈值。
8. 调用 `finalize_run(runId)`。服务端复核阶段次序、版本、材料哈希和门禁凭证后置为 `waiting_review`。回报 runId、故事数、用例数、gateScore 和等待复核状态。

## 边界

- 每次调用使用同一个注册 runId。重复提交不会重复建批次。
- 文件中的 stories/cases/gate/meta 是导出视图；直接写文件不会获得服务端完成凭证。
- 不调用 `run_pipeline` 替代自己的规划。A 对照模式必须单独明确选择，并说明生成发生在内部模型。
- 模块树的冻结是人的决定：提议完就停，不要用别的路由或工具替人按下它。
- 不编写人的决定，不批准自己的用例，不修改冻结材料、gold、held-out 或 oracle 来让结果通过。
- 完成生成只意味着等待用户复核，不意味着批准、执行通过或专业能力已经提高。
- 缺少宿主 token/费用时报告 unknown，不能填 0 代替未知。确定性阶段服务没有模型调用，与宿主总用量是不同指标。
- 门禁拒绝属于可修正信息；服务、认证或材料完整性错误原样报告。不要绕过阶段工具。

阶段约束在服务端执行，原生 hook 是补充。PenguinHarness 未触发 hook 时也必须经过相同服务端门禁。


## 节点输入与验证边界

模块规划消费探索产物、产品模型与领域规则，规划业务范围；用户故事消费已审核模块树及相关需求依据；用例设计消费故事和验收条件，设计步骤、预期与前提。保留上游 revision 和需求引用，不要求上一步已执行过下一步的业务流程。

故事验收条件描述产品应有行为。探索未覆盖时将状态保存在 observationLinks，不得因此追加「【待确认：界面观察不到】」或 requires-fixture。只有产品范围不明、需求冲突才提出需求待确认；纯假设不能冒充需求。

用例设计可在未执行时完成。登录、测试数据、控件定位、数值判据等就绪情况单独记录，留给执行准备核验；不能由 unobserved 自动推导 requires-fixture，也不能把它自动改成 ready。执行和报告仍须真实证据，不能为了提高 ready 数量跳过门禁。
