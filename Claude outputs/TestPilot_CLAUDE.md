# TestPilot — 给 Claude Code 的接手说明

## 先做什么
1. 读 `docs/v3/00-架构.md`（唯一真相源，尤其 §8 红线、§13 规则在哪强制）。
2. 读 `docs/v3/07-第四档路线-任务与进度.md` §0，然后：
   `node scripts/plan.mjs --doc docs/v3/07-第四档路线-任务与进度.md --next`
3. 认领一条（`--set T-xx doing`），做完验收判据再标 done，并在 07 §10 追加一行执行记录。

## 不做的事（除非用户当轮明说）
- 不调模型端点、不真跑浏览器、不 `git commit` / `git push`。这三件事要网络、费用或人的决定。
- 不改 `benchmark/*/gold.json`、`human-labels.json`、`held-out/`、`rubric/`；不把它们放进任何提示词。
- 不让自愈改 `oracle`。
- 动 `packages/harness-testing/src/casegen/prompts.ts` 或 `plugins/testpilot/skills/**` 时：`node scripts/check-drift.mjs` 必须绿，`plugins/testpilot/plugin.json` 的 `skillVersions` 跳版本。

## 验收命令
```bash
pnpm typecheck && pnpm test          # 各包 tsc + vitest + hook 子进程测试
pnpm check:drift                     # 两臂提示词逐条认领
node scripts/replay.mjs              # 冻结运行确定性重打分
node scripts/cost-report.mjs         # 每条用例的账（跑过用例之后）
```

## 目录速查
- `packages/harness-testing/` 九步节点、打分、变异、执行器（`exec/run.ts`）、接口判据（`exec/apiOracle.ts`）
- `packages/testpilot-mcp/` stdio MCP：run_pipeline · score_run · paired_eval · mutate_and_detect · drive_sut · retrieve_spec …
- `plugins/testpilot/` skills（纯数据）+ hooks（脚本）；`hooks/lib/tp.mjs::deny` 记 holds
- `server/src/penguin.ts` harness 接缝（四个函数）；第二个运行时照它的形状写
- `benchmark/<capability>/` gold · human-labels · statement · rubric · held-out · scoreboard.yaml
- `evals/*.json` 评测定义：两臂只差一件事，`expect` 跑之前写
- `fixtures/hyperliquid-testnet/` 执行层降本的被测对象（8 条 P0，全接口判据）

## 写作与提交信息的口径
中文；第一人称；先写失败与出乎意料的，再写改了什么；数字带来源。提交信息看 `git log` 的前 20 条照着写。
