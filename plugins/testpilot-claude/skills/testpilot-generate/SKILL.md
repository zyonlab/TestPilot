---
name: testpilot-generate
description: Generates test cases from the specification documents in the workspace by making one call to the TestPilot run_pipeline MCP tool. Use it when the run is configured for pipeline mode (the A arm) — that is, when the whole generator is meant to run as one deterministic tool call rather than as skills; for skill mode use testpilot-run-c instead.
---

# TestPilot：生成测试用例（A 臂 / pipeline 模式）

**自由度：low。** 这条 skill 的全部内容是「调一次工具，报回来的数」。

生成流水线是**一步**，不是几步。它是确定性的，而且是被称量的；
一次由模型挑选步骤的运行，和任何别的运行都不可比。

## 这是两条路里的哪一条

TestPilot 的生成器有两条并行的实现，**它们只允许差一件事**（Agent State 的版本），
Phase 3 的第一次配对评测就是 A vs C：

| 臂 | 入口 | 生成器住在哪 |
|---|---|---|
| **A（本 skill）** | `testpilot-generate` | 代码里：`run_pipeline` 一次调用跑完九步 |
| **C** | `testpilot-run-c` | Agent State 里：`testpilot-stories` + `testpilot-design` 两条 skill |

**这次运行被配置成 pipeline 模式，才用本 skill。** 拿不准就问，不要两条都跑——
两条都跑不会得到「更好的结果」，只会得到两批没法互相解释的产物。

## 运行的就是这一条

调 `mcp__testpilot__run_pipeline`，参数：

- `stage` = `g1`
- `materialsDir` = `<workspace>/materials`
- `outDir` = `<workspace>/runs/<timestamp>`，`<timestamp>` 是当前 UTC 的
  `YYYYMMDDTHHMMSS`（`date -u +%Y%m%dT%H%M%S`）

工具名是**带前缀的全名** `mcp__testpilot__run_pipeline`，不是 `run_pipeline`。

不要把流水线拆成步骤。
不要改参数。
用户没说故事条数就不要传 `limit`。
用户给了 `ablate`（消融臂要关掉的组件）就**原样**传这个数组；没给就不传。
不要先去读、改写、总结或者「改进」规格文档——工具自己会读。
不要自己写用例，也不要改工具写出来的文件。

## 返回之后

工具返回 `{runId, stories, cases, gateScore, outDir}`。**原样报这五个数然后停下。**
门禁分是工具的，不是你的：不要把它复述成一个判断，不要给这批用例评级，
不要就它们好不好发表意见。

## 失败了

原样报告返回的错误信息然后停下。不要换参数重试，不要退回去手写用例，不要绕过这次失败——
**一次失败是关于这条流水线的信息，藏起来的代价比这次运行本身更大。**
