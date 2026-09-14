# 完成凭证与来源

`finalize_run` 返回服务端保存的 summary 与不可变 revisionId，包括：

- runId、projectId、waiting_review、stories/cases 数量、gateScore。
- storiesRevision、casesRevision、gateRevision。
- binding：双模型来源、skillVersion、assetDigest、loadedDigest、materialsHash、inputHash、materialRevisions。
- plannerExecution（host / managed）、stageServiceModelCalls、hostUsage 与 finalizedAt。

宿主不手写 meta、不计算摘要、不报告人的批准。`get_project_run` 可以查共享状态；Web 可读取同一 revision。

hostUsage 的 calls/tokens/usd 为 null 表示缺乏运行时证据。模型身份 unknown 与 host-reported / provider-response 分开记录。
loadedDigest 只证明服务端下发了那些内容；遵守程度要靠运行产物、门禁和独立评测验证。
