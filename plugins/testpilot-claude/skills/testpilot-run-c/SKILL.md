---
name: testpilot-run-c
description: Runs TestPilot generation with this host as planner, immutable project inputs, validated stories and cases, a deterministic server gate, and finalization for human review. Use for normal project test generation in Claude Code, Codex or PenguinHarness.
---

# TestPilot 宿主规划工作流

宿主模型负责理解、故事拆解和用例设计。Midscene 的执行模型另由项目配置提供。
服务端保存阶段事实与门禁凭证，Web 展示同一批产物并交给用户复核。

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
