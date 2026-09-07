---
name: testpilot-run-c
description: Orchestrates one complete TestPilot generation run in skill mode by calling testpilot-stories then testpilot-design, waiting for the gate hook to clear, writing runs/<runId>/meta.json, and reporting five numbers. Use it whenever the user asks for test cases and the run is configured for skill mode rather than pipeline mode.
---

# TestPilot：C 臂的一次运行

**自由度：low。** 这里没有你要判断的东西。**顺序是写死的，一步不能跳，一步不能换。**
两臂之间只允许差一件事（Agent State 的版本）——你在这里多做一步或少做一步，
Phase 3 的配对评测就比不出任何东西，而它看起来仍然会给出一个数字。

判断在 `testpilot-stories` 和 `testpilot-design` 里，不在这里。

## 顺序

### 0. 定 runId 与起始时间

```bash
date -u +%Y%m%dT%H%M%S     # 这是 runId
date -u +%Y-%m-%dT%H:%M:%SZ # 这是 startedAt，记下来
```

这次运行的所有产物都写进 `<workspace>/runs/<runId>/`。**一次运行一个目录，不要复用。**

### 1. 故事

读 `testpilot-stories` 的 SKILL.md 并照它做，写出 `runs/<runId>/stories.json`。

写盘会被一个 hook 校验。**被拒绝就照着报错改，再写一次**——
不要绕过它，不要换个文件名写，不要把内容塞进别的文件。那个报错是这一步的产物没写成。

### 2. 用例

读 `testpilot-design` 的 SKILL.md 并照它做，写出 `runs/<runId>/cases.json`。
同样有 hook 校验形状，**外加出处**：每条用例的 `sourceRefs` 必须是这次运行里 `retrieve_spec`
返回过的段 id。被拒绝时理由会列出哪几条、哪几个 id——回去取那几段或改引用，不要删掉 `sourceRefs` 蒙混。

### 3. 等门禁放行

**你不跑门禁，门禁是一个 hook。** 它挂在「写 `meta.json`」这一次调用之前：
你去写 meta.json 的那一刻，它读盘上的 `cases.json`、跑门禁①、把 `GateReport`
写成 `runs/<runId>/gate.json`。

- 门禁**过了**：写 meta.json 这次调用正常进行。
- 门禁**没过**：这次调用被拒绝，拒绝理由里带着分数、阈值、negativeRatio、
  各条规则各几条、外加三条具体的例子。**回到第 2 步改 cases.json**，然后再写一次 meta.json。

**不要自己算门禁分，不要自己写 gate.json。** 模型不写分。

### 4. meta.json

写 `runs/<runId>/meta.json`。它是 P3 来源印记的载体——**缺任一必填项，`score_run` 拒绝打分**，
于是这次运行白跑。形状见 `REFERENCE.md`，那里有取每个值的确切命令。

### 5. 审计

读 `testpilot-scanner` 的 SKILL.md 并照它做，写出 `<workspace>/scans/<runId>.json`。
**注意它不在 `runs/` 里**——审计产物独立于运行产物，可以跨运行汇总。

### 6. 记一笔

读 `testpilot-memory` 的 SKILL.md。**只记这次踩到的具体的坑**，不要记通用规范。
没踩到坑就什么都不记——空的一次记录比一条正确的废话有用。

### 7. 回报

回报**五个数**，一个不多一个不少：

```
runId:     <runId>
stories:   <stories.json 里 stories 的条数>
cases:     <cases.json 里 cases 的条数>
gateScore: <gate.json 里的 score>
outDir:    runs/<runId>/
```

`gateScore` 是门禁的，不是你的：**不要把它复述成一个判断**，
不要给这批用例评级，不要说它好不好，不要说「覆盖比较全面」。
需要看细节就读 `gate.json`——但读了也只报数字。

## 如果 hook 根本没有触发（2026-09-03 起的已知退化）

这台机器上装的 PenguinHarness（`penguin-cli` / `penguin-core` **0.2.9**）**没有实现 hook**：
`pre_tool_use` 和 `stop` 两个点在发布版里都不存在（依据与实测见
`docs/v3/03-penguin-hooks-契约.md` §9）。装好的 `agent_state/hooks/testpilot/`
是对的，但没有任何东西去读它。

**怎么认出来**：你写完 `cases.json` 再写 `meta.json`，**没有被拒绝，也没有出现 `gate.json`**。

**这时候按下面做，一步不能少：**

1. **不要假装门禁过了。** 也不要自己判断这批用例好不好——那正是这条规矩防的事。
2. 手动跑门禁脚本。它和 hook、和 A 臂 `run_pipeline` 是**同一份 `runGate` 代码**，
   所以这样算出来的分和 hook 算的逐字节相同：

   ```bash
   H="<app_data_dir>/agents/<agent_id>/agent_state/hooks/testpilot"
   RUN="<workspace>/runs/<runId>"
   python3 -c "import json;print(json.dumps({'hook':'pre_tool_use','session_id':'manual','tool_name':'write_file','arguments':json.dumps({'file_path':'$RUN/meta.json','content':'{}'})}))" \
     | node "$H/gate1.mjs"
   ```

   它会把 `GateReport` 写成 `$RUN/gate.json` 并在 stdout 上打印分数与阈值。
3. **分低于阈值就照办**：回第 2 步改 `cases.json`，重跑这条命令，直到它说 `"gate":"pass"`。
   门禁没过就**不要**写 `meta.json`——`stopAfter` 的语义在 hook 缺席时靠你自己守。
4. **在最终回报里明说这一处偏差**：hook 没触发、`gate.json` 是手动跑同一份代码补的。
   这不是「复述判断」，这是报告一次基础设施缺席。**藏起来的代价比这次运行本身大。**

## 不许做的事

- **不许跳步。** 没有 stories.json 就不许写 cases.json；没过门禁就不许写 meta.json。
- **不许自评。** 分由工具算（门禁 hook、`score_run`），模型不写分。
- **不许绕过 hook。** 被拒绝是信息，不是障碍。用 `exec_command` 拿 `cat > file` 绕过
  `write_file` 的校验，是把这次运行变成一次不可比的运行——它比失败更糟，因为它看起来成功了。
- **不许改已经写好的产物**，除非是门禁拒绝之后回去改 cases.json。
- **不许对着材料"先改进一下规格"**。材料是输入，不是草稿。

## 失败了怎么办

原样报告错误信息然后停下。不要换参数重试，不要退回去手写用例，不要绕过去。
**一次失败是关于这条流水线的信息，藏起来的代价比这次运行本身更大。**
