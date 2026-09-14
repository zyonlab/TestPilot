# TestPilot — 给 Claude Code 的接手说明

## 先做什么
- 2026-09-10 最新专业性要求先读 `docs/v3/20-领域专业物料链路诊断与重构交接.md` 和 `docs/v3/21-节点提示词与结构化契约草案.md`：先领域引导探索与产品模型，再故事/风险/文本用例/工程集成。当前只是诊断与方案，不能把原冒烟 10/10 当专业验收。
- 2026-09-10 最新用户决定：本地审核免身份验证。不要恢复 ReviewerSession / TP_REVIEW_TOKEN；操作来源与版本审计保留，详见 09 第 25 节。
0. **快速接手先读 `docs/v3/09-执行目标与接手指南.md`**：目的与边界、进度快照、设计取舍、N-01 起手式、交接记录格式。每次停止前按该文档 §6 留下可接续记录，并更新 §7 最近交接点。
1. 读 `docs/v3/00-架构.md`，先读顶部 **2026-09-08 用户决策补充**，再读 §8 红线、§13 规则在哪强制。Web 管项目/workflow/模型/物料/review；Penguin UI 管自进化评估。
2. 最新 Codex 原生复验见 `docs/v3/19-Codex宿主Hyperliquid实测.md`（10/10 通过；公共页面冒烟范围）。生产实施与真实验收再读 `docs/v3/18-本地UI重构与Hyperliquid验收.md`（Hyperliquid 15/16 通过，C-14 待审；P 项仍按剩余验收保持 doing）。当前 UI 的本地实施再读 `docs/v3/11-WebUI全流程评审与产品设计.md`、`docs/v3/13-UI与论文路线任务台账.md`，然后：
   `node scripts/plan.mjs --doc docs/v3/13-UI与论文路线任务台账.md --next`
3. 认领 P 任务（同一 `--doc`，`--set P-xx doing`），按已有基础、代码落点和验收实施；全部兑现后再 done，证据写 `docs/v3/evidence/p-xx/`。当前优先 P-01；PC/SR 已合并到 P 台账。
4. 08 保留 N 系列历史及人工/观察/发布待条件项，07 保留 T 历史。旧完成率和旧 UI 迁移决策不能替代本轮验收。

## 判决必须在屏幕上（2026-09-12 用户决定）
- **这个项目产出的是端到端 UI 测试代码。一切基于界面：不要直接调用被测网站的接口。**
  用例驱动产品的界面，再对界面上出现的东西下判断；接口说成功而屏幕上没有那一行，
  用例会通过而产品其实是坏的。
- 已落地：`casegen/prompts.ts` 的第六种判据（`api`）整段改写成「判决从屏幕读」，
  受限解码的 `kind` 枚举里去掉了 `api`（模型发不出来了）；门禁新增 `oracle-offsite`
  （warn，按 caseId 计分，等于挡住这类用例过关）。
- **旧口径的遗留物，别拿它们当范例**：`fixtures/hyperliquid-testnet/cases.json`（8/8 接口判据）、
  `fixtures/tier4-demo/cases.json`（4/4）、`docs/v3/06-执行层降本.md`、
  `fixtures/*/README.md` 里「判据全部是 kind: api」那套说法，都是这条口径之前写的。
- `exec/apiOracle.ts` 与 `MachineOracleSchema` 里的 `api` 分支**还在**（执行旧用例要用），
  但新用例走不到那里了。要彻底拆掉是另一件事，没做。

## 被测地址只有一个口径（2026-09-12 用户决定）
- Hyperliquid 相关的一切跑动，**地址一律是 `https://app.hyperliquid-testnet.xyz/trade`**（测试网）。
  本机链配置 `chainId 421614`（Arbitrum Sepolia）、`fixtures/hyperliquid-testnet/`、注入钱包用的账户，
  说的都是这一条链。测试网上随便点是对的。
- **主网 `app.hyperliquid.xyz` 不作为被测对象**。同一个钱包在那边有真钱（2026-09-12 实测
  `Portfolio Value $6.77`），同一串点击就是在花钱，而两者只差一个域名。它在 `guard.allowHosts`
  里也永远不该出现——代码与测试里出现的主网地址是「不在白名单的那个例子」，别顺手改掉。
- 探索要点会改状态的东西（`exploreActions:"interact"`）时，服务端只认 `config.guard.allowHosts`。
  测试网域名**已经在 `server/harness.config.ts` 的 allowHosts 里**（2026-09-07 加的，理由写在那儿），
  所以不需要 `ALLOW_HOSTS` 环境变量——2026-09-12 实测：不给这个变量，测试网 interact 照样放行，
  主网照样 403。要给别的域名开这个口子，走那份配置并在旁边写清理由。
- `fixtures/hyperliquid-mainnet/` 这个目录名是历史，里面的规则包对测试网同样适用（已实测）。

## 不做的事（除非用户当轮明说）
- 本会话用户已授权本地真实模型/浏览器联调，不需要再次索要 `.env` 或确认这类验收。新会话按其授权范围执行；不得把旧默认限制当成本会话的额外审批。`git commit` / `git push` / 对外发布仍未授权。
- 不改 `benchmark/*/gold.json`、`human-labels.json`、`held-out/`、`rubric/`；不把它们放进任何提示词。
- 不让自愈改 `oracle`。
- 动 `packages/harness-testing/src/casegen/prompts.ts` 或 `plugins/testpilot/skills/**` 时：`pnpm check:drift`（等价于 `node scripts/check-drift.mjs`）必须绿，`plugins/testpilot/plugin.json` 的 `skillVersions` 跳版本。
  改完 skill 记得 `node scripts/build-claude-plugin.mjs` 与 `build-codex-plugin.mjs` 重新生成宿主副本——检查会拦，但拦住之前先想着它：2026-09-14 那次，改过的 skill 有四个文件整整两天没到宿主 agent 手里。

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
- `server/src/runtimes.ts` runtime 注册；`penguin.ts` / `claudecode.ts` 已有适配，`codex.ts` 原生适配已按 N-11 完成
- `benchmark/<capability>/` gold · human-labels · statement · rubric · held-out · scoreboard.yaml
- `server/src/evolution/` 与 `extensions/penguin-evaluation/`：配套评估 UI、固定预算沙箱、版本/CAS、只读冻结运行 release adapter
- `evals/*.json` 评测定义：两臂只差一件事，`expect` 跑之前写
- `fixtures/hyperliquid-testnet/` 执行层降本的被测对象（8 条 P0，全接口判据）

## 写作与提交信息的口径
中文；第一人称；先写失败与出乎意料的，再写改了什么；数字带来源。提交信息看 `git log` 的前 20 条照着写。
