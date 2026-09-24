# 用户故事候选验收条件冲突修复

运行：`run-a32ef71b-d7b8-4295-9c7e-75dc5d1f6cd2`。

## 原因
宿主启动/续跑使用 `unitGenerationMessage`，仍包含旧限制：假设只能成为开放问题，不能成为验收条件。单元合同与服务端校验已改为生命周期候选故事：允许未批准的候选验收条件，但必须带 `requirementDraft` 并进入人工复核。两种指令冲突，宿主提交空验收条件后遭拒，随后主动请求例外，导致没有节点完成回执。

这不是需要用户放宽业务要求的例外。候选验收条件属于 `story.acceptance`；`requirementDraft` 仅保存理由和待确认问题。候选不等于已批准需求、已验证事实或失败判据。

## 修复
- 启动话术复用服务端的 `STORY_PLANNING_CONTRACT`，移除绝对禁止候选条件的旧句。
- 首次启动、按单元运行、整份生成及断点续跑使用相同规则。
- 明确 `requiresHumanReview` 时停止；未取得该故事版本的人工批准，不能进入 cases。
- 未修改业务转换覆盖、验收条件完整性和人工审核校验器。

提交：`3e45c54`，分支 `codex/fix-story-draft-launch-contract`。

## 验证
服务端故事审核/节点控制/宿主预算 12 项测试通过，业务转换与规划合同 6 项通过，服务端 TypeScript 检查通过。

重启后通过 `resume`、`mode=next-node` 续跑原故事节点，未重跑 Explore 或重写冻结模块。原失败的准备单元通过，订单和持仓/保证金单元均通过，继续处理跨模块旅程。

最终结果：4/4 个故事单元完成，合并为 17 条候选故事（均带 requirementDraft），修订 `rev-c98215fb-94bd-40c6-b6b3-08e086219f4a`。节点为 `stories=waiting_review`，运行 error=null。cases/gate/finalize 未启动。等待人工确认这些候选业务预期，未自动批准。
