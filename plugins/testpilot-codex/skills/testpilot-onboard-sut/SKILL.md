---
name: testpilot-onboard-sut
description: Interviews the person once about a new system under test — its address, login state, viewport, where the materials come from, where the gold checklist comes from, which model judges — runs the deterministic precondition checks, and writes the answers as a decision record into the workspace CLAUDE.md so later runs read it instead of asking again. Use it before the first generation run against a new product. Not needed once the workspace already has a decision record, and not for exploring the product itself (testpilot-explore).
---

# TestPilot：接入一个新的被测对象

**自由度：low。** 问题清单是定死的，检查是定死的命令，写出来的记录形状是定死的。
你要判断的只有一件事：用户没答的项用默认值，还是必须停下来问。

借的是 commerce-agents 的 `/scaffold-commerce-agent`：一次问完，复述确认，写进项目的决策记录，
之后每条 skill 只读记录不重问。三条 SUT 前提（WAF / 视口 / 模型端点）此前是 `testpilot-explore`
里的文字清单，靠模型照着做；这里变成命令，输出进记录。

## 1. 一次问完（缺的用默认值，并在记录里标「默认」）

| # | 问题 | 默认 |
|---|---|---|
| 1 | 被测对象地址（一个 URL） | 无默认，**必须问** |
| 2 | 登录态从哪来：`none`（登出态探索）/ `import`（从使用者浏览器导入会话）/ `credentials`（`${secret.NAME}` 占位） | `none` |
| 3 | 视口 | `1600×1000` |
| 4 | 材料类型：`document`（人写的规格）/ `exploration`（探索观察）/ 两者 | `exploration` |
| 5 | 材料放在哪 | `<workspace>/materials` |
| 6 | 黄金清单从哪来：`human`（人写 gold.json）/ `draft`（从探索生成草稿等人审） | `draft` |
| 7 | 判官模型（与生成器**不同族**） | 读环境 `TP_JUDGE_MODEL` |
| 8 | 运行模式：`pipeline`（A 臂）/ `skill`（C 臂） | `skill` |
| 9 | 门禁阈值 `minGateScore` / `minNegativeRatio` | `0.6` / `0.3` |
| 10 | 这次接入是谁、为什么（一句话） | 无默认，**必须问** |

## 2. 三条前提，跑命令，记结果

```bash
# WAF：有这个响应头就是被挡，登出态探索会被弹到登录页；答案决定问题 2 能不能选 none
curl -sI "<地址>" | grep -i "x-amzn-waf-action" || echo "no-waf-header"
# 视口：探索与执行的环境变量必须显式给，否则下单面板整块不渲染
echo "MIDSCENE_SHOT_WIDTH=${MIDSCENE_SHOT_WIDTH:-unset} MIDSCENE_SHOT_HEIGHT=${MIDSCENE_SHOT_HEIGHT:-unset}"
# 模型端点：显式传参探一次，脚本默认值指向别处
echo "OPENAI_BASE_URL=${OPENAI_BASE_URL:-unset} MIDSCENE_MODEL_NAME=${MIDSCENE_MODEL_NAME:-unset} TP_JUDGE_MODEL=${TP_JUDGE_MODEL:-unset}"
```

三条的输出**原样**进记录。有 WAF 头而问题 2 答了 `none`，停下来告诉用户：登出态在这里探不到内容。

## 3. 复述，确认，再写

把十个答案与三条检查结果念一遍。用户改哪条就改哪条。确认后写 `<workspace>/CLAUDE.md`，
追加（已有则**替换**）这一节，别的内容不动：

```markdown
## TestPilot SUT decision record（<YYYY-MM-DD>）

- target: <地址>
- login: none | import | credentials          （默认）
- viewport: 1600×1000                          （默认）
- materials: exploration @ <workspace>/materials
- gold: draft → benchmark/<capability>/gold.draft.json，**人审后另存为 gold.json，草稿任何工具不得读**
- judge: <模型>（与生成器不同族）
- mode: skill | pipeline
- gate: minGateScore=0.6 minNegativeRatio=0.3
- why: <一句话>，by <谁>
- checks: waf=<有/无 x-amzn-waf-action> viewport=<W×H 或 unset> endpoint=<base_url / model / judge>
```

## 4. 之后的 skill 怎么用它

`testpilot-run-c` / `testpilot-explore` / `testpilot-benchmark-design` 开始前读这一节：地址、登录态、
视口、材料位置都从这里取，**不再问用户**。记录里标着「默认」的项，用户随时能改一行。

## 停在哪

- 问题 1、10 没答：停，问。
- WAF 头存在且登录态选 `none`：停，说明后果，让用户改选 `import`。
- 别的一律用默认值写进去，标「默认」，不停。
