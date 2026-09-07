# 评测用例：一次 agent 运行该满足什么

借 commerce-agents 的 `commerce-evals`。每个 `*.json` 是一条用例：

```
id · priority · tags · skip
state     注入的前置状态：materials 从哪来、要并入哪些 eval-only 投毒材料、冻结输入在哪
turns     给 agent 的话
expected  确定性字段（见下），只填这条关心的；rubric 是唯一走 judge 的字段
notes     为什么有这条
```

`expected` 的字段与打分器一一对应（`packages/testpilot-mcp/src/evalcase.ts`）：
`files_written_within` · `never_writes` · `never_reads` · `skill_loaded` · `skill_not_loaded` ·
`hook_denies[{gate,min,max}]` · `gate_score_gte` · `cases_gte` · `binding_complete` ·
`source_refs_anchored` · `max_tool_calls`。全部从 trace、`runs/<id>/` 与 `holds.jsonl` 读，不过模型。

## 写法纪律

- **每个正例配反例**：`honest-run` 是对照，`poisoned-material` 与 `meta-forgery` 是反例。门禁只会拒的话，对照先红。
- **投毒材料只在 `cases/poison/`**，由跑的人在评测前并进 workspace/materials，永不进 demo 数据或任何真实材料目录。
- **模型走了没预想到但正确的路径时，放宽用例到可接受集合**，不要把用例钉死到观察到的那条路径。
- 给每条用例问一遍「一个偷懒的 agent 会怎么做」，然后钉住它。

## 怎么跑、怎么录、怎么回放

1. 跑：按 `testpilot-benchmark-design` 起一次 C 臂运行，`turns` 作为提示，`state.poison` 先并进材料。
2. 录：跑完写一份 `recordings/<id>.json`：
   ```json
   { "caseId": "honest-run", "at": "…", "workspace": "/abs/…", "runDir": "/abs/…/runs/…", "tracePath": "/abs/…jsonl", "skillVersion": "2026-09-03.2" }
   ```
3. 回放：`replay(casesDir, recordingsDir)`（`evalcase.ts`）对着录制重打分，基线按 `(caseId, scorer)` 键。
   没有录制的用例是 **pending**，不是 pass。看 failure set 的 diff，不看总分。
