# TestPilot — 给 Claude Code 的接手说明

## 先做什么
0. **先读 `docs/v3/09-执行目标与接手指南.md`**：目标、当前阶段（初步交付）、现状、下一步、验收命令、交接记录格式。每次停止前按它 §6 在 §7 最上面留一条记录。
1. 再读 `docs/v3/00-架构.md`（进程、包、阶段流水线、账本、单元循环、守卫的代码落点）与 `docs/v3/01-数据契约.md`（各产物的真源 schema）。
   产品能做什么看 `03-用户故事.md`（按代码梳理的史诗与故事），每个功能落在哪一层哪个函数看 `04-分层功能实现.md`。安装与宿主接入看 10、14。
   想知道「一次运行到底怎么走、每步读写什么、哪里等人、出错报什么码」，读 `docs/v3/02-工作流-横向与纵向.md`：横向流程与运行状态机、六条关键操作的时序图、界面截图，末尾 §10 是**按代码核过的已知缺口清单**（修一条划掉一条）。
2. `docs/v3/history/` 是 2026-09-16 之前的实验报告、任务台账（T/N/P 系列）、设计提案和交接日志，**只作追溯，不代表现状**；里面的「最新」「当前」都是当时的说法，数字有的后来被更正过。代码注释里引用的 `docs/v3/history/NN §x` 是设计来由，不是待办。
3. 本地审核免身份验证（2026-09-10 用户决定）：不要恢复 ReviewerSession / TP_REVIEW_TOKEN；操作来源与版本审计保留。

## 判决必须在屏幕上（2026-09-12 用户决定）
- **这个项目产出的是端到端 UI 测试代码。一切基于界面：不要直接调用被测网站的接口。**
  用例驱动产品的界面，再对界面上出现的东西下判断；接口说成功而屏幕上没有那一行，
  用例会通过而产品其实是坏的。
- 已落地：`casegen/prompts.ts` 的第六种判据（`api`）整段改写成「判决从屏幕读」，
  受限解码的 `kind` 枚举里去掉了 `api`（模型发不出来了）；门禁新增 `oracle-offsite`
  （warn，按 caseId 计分，等于挡住这类用例过关）。
- **旧口径的遗留物，别拿它们当范例**：`fixtures/hyperliquid-testnet/cases.json`（8/8 接口判据）、
  `docs/v3/history/06-执行层降本.md`、`fixtures/*/README.md` 里「判据全部是 kind: api」那套说法，
  都是这条口径之前写的。（同批的 `fixtures/tier4-demo/` 已于 2026-09-18 删除。）
- `exec/apiOracle.ts` 与 `MachineOracleSchema` 里的 `api` 分支**还在**（执行旧用例要用），
  但新用例走不到那里了。要彻底拆掉是另一件事，没做。

## 被测地址只有一个口径（2026-09-12 用户决定）
- Hyperliquid 相关的一切跑动，**地址一律是 `https://app.hyperliquid-testnet.xyz/trade`**（测试网）。
  本机链配置 `chainId 421614`（Arbitrum Sepolia）、`fixtures/hyperliquid-testnet/`、注入钱包用的账户，
  说的都是这一条链。测试网上随便点是对的。
- **主网 `app.hyperliquid.xyz` 不作为被测对象**。同一个钱包在那边有真钱（2026-09-12 实测
  `Portfolio Value $6.77`），同一串点击就是在花钱，而两者只差一个域名。它在
  `server/harness.config.ts` 的 `guard.denyHosts` 里，永远不该被移出——代码与测试里出现的主网地址是「被禁止的那个例子」，别顺手改掉。
- **没有主机白名单，也没有「允许不可逆」这个开关**（2026-09-15 / 2026-09-16 用户决定）。删除、完成、清理是被测产品的功能，用例要测的正是这一段生命周期，所以**默认放行**；
  探索要点会改状态的东西，声明 `exploreActions:"interact"` 即可。全局只留禁止名单 `guard.denyHosts`，主网在上面，谁也放不开；
  运营方要整机拦截不可逆步骤，把 `guard.blockIrreversible` 设回 true 或给 `GUARD_STRICT=1`（那时规则包的 `sideEffectLabels` 才起作用）。
- `fixtures/hyperliquid-mainnet/` 这个目录名是历史，里面的规则包对测试网同样适用（已实测）。

## 人把关，谁也不能替（红线）
- 流水线停下来等人的地方：**冻结模块树、复核用例（批准/驳回/修改）、决定回归候选**；另有一处有条件的——
  故事的规则里带未确认假设时，候选故事要人审（`storyReview.ts`，驳回同样要理由）。
  学习回路里生效的决定也只能是人：确认界面事实、冻结标准集、评估后换执行模型（docs/v3/15 阶段 6～9）；存知识库新版本、立执行基线同理。
  服务端要求 `actor.kind === "human"`，判定方式是「请求不带 `Authorization` 头，也不带 `x-testpilot-actor`」（`reviewPrincipal.ts`）。
- **驳回必须写理由**（2026-09-19）：一批里只要有 `rejected`，`note` 去掉首尾空白不足 4 个字就报
  400 `rejection_requires_reason`（`approvedRuns.ts::decideRevisions`，宿主工具走同一个函数）。
  理由是反例候选的唯一来源；批准不需要理由。
- **已知缺口，别当它不存在**：MCP 这一路已经堵上——`operatorOnly` 的动作（冻结、批准、决定候选……）不注册给规划器，
  宿主工具的请求一律带 `x-testpilot-actor`；服务端起的规划宿主进程里 node/curl/wget 发往本服务的请求也自动带它（`hostActorTag.ts`）。
  剩下的是**刻意去掉请求头的裸 HTTP** 仍能冒充本地操作员——那要身份验证，本地审核免登录的决定没变，**没有彻底修**。详见 `docs/v3/02` §10-1。

## 领域内容一律是项目数据（2026-09-15 用户决定）
- 非通用的部分**不许写进代码**（也不许写成 `if (某个领域)`）：只能是项目数据，由用户用对话抽屉聊出来或自己指定。
  载体三个：**规则包**（`actionVocabulary` / `sideEffectLabels` / `volatileReadings` 等）、**领域参考**（「领域参考」页，
  按版本存、运行开始时冻结绑定）、**环境画像**（前提名 `capabilities`、`injectWallet`）。
- 仓库里的 Hyperliquid 测试网数据只有**内置示例** `examples/hyperliquid-testnet/`（领域参考、规则包，新建项目时可参考，存进项目才生效）。
  2026-09-28 删掉了旧评测数据集 `benchmark/hyperliquid-testnet/`、`evals/domain-perp.json`、`materials/hyperliquid-testnet-2026-09-20/`
  （草稿金标未复核、用的是已禁的接口判据、`domain-perp` 指向从没有过的 `gold.json` 跑不起来；git 历史里都在）。
  测试要的真实样本留成夹具：`packages/harness-testing/test/fixtures/hyperliquid-testnet-*`。内置示例在知识库里以只读 `builtin:` 条目出现，选了才绑定；除此之外没有「预设」，不做旧数据兼容。
- `pnpm check:domain-neutral` 必须绿：产品源码非注释代码与 skill 里不许有写死的领域词。

## 初步交付：开源发布（2026-09-16 用户决定）
- 对象：**开源 / 公开发布**，许可 MIT。**现状（2026-09-19）**：代码就在公开仓库 `zyonlab/TestPilot` 上，带着完整提交历史，改动走 PR 合进 `main`；仓库描述与 topics 已设。
  2026-09-16 原计划的「另建一个不带历史的公开仓库、现有私有仓库原样保留」**没有执行**，要不要再做是未决的事，别当它已经定了。
- 入口：**Web + Claude Code**。Web 发起的生成由项目选定的本机已登录宿主规划（Claude Code 或 Codex，`plannerHost.ts`；表单发 `planner:"connected"`），
  `TP_AGENT_RUNTIME` 只是 API 直接建运行时的默认值；Penguin（需 Node 24 与 Penguin 服务）只能走 API，标实验性。运行登记时定下规划运行时，续跑用同一个。
- 验收被测对象：**只有 Hyperliquid 测试网**（2026-09-18 用户决定）。Vikunja 那条线连同它的数据一起清掉了，早期在它上面跑通的记录留在 history。
- **2026-09-28 用户解冻**：自进化、经验与反例库、标准测试集纳入初步交付（「数据要自动拿来学习」）。落点与顺序见 `docs/v3/15` 阶段 6～9：反例回流用例生成 → 经验沉淀成界面事实候选（人确认才进知识库领域参考）→ 测试网标准测试集（金标只能人冻结）→ 自进化（候选版本在标准集上比，人决定上线）。人把关的红线不变。
- **仍冻结**：子 agent 并行、去不去掉 Penguin、记分板与论文研究线（台账 P-13～P-24 里与上面无关的项）。新需求先问「初步交付需不需要」。
- 本机基准应用目录由 `TP_BENCH_DIR` 给（默认 `~/bench`），仓库里不写死任何人的主目录。

## 不做的事（除非用户当轮明说）
- 本会话用户已授权本地真实模型/浏览器联调，不需要再次索要 `.env` 或确认这类验收。新会话按其授权范围执行；不得把旧默认限制当成本会话的额外审批。
- `git commit` / `git push` / 开 PR / 合并 / 对外发布**都要用户当轮明说**。仓库已公开这件事不等于授权——2026-09-17 起多次推送与合并，每次都是用户当轮点的头。
- 不改 `benchmark/*/gold.json`、`human-labels.json`、`held-out/`、`rubric/`；不把它们放进任何提示词。
- 不让自愈改 `oracle`。
- 动 `packages/harness-testing/src/casegen/prompts.ts` 或 `plugins/testpilot/skills/**` 时：`pnpm check:drift`（等价于 `node scripts/check-drift.mjs`）必须绿，`plugins/testpilot/plugin.json` 的 `skillVersions` 跳版本。
  改完 skill 记得 `node scripts/build-claude-plugin.mjs` 与 `build-codex-plugin.mjs` 重新生成宿主副本——检查会拦，但拦住之前先想着它：2026-09-14 那次，改过的 skill 有四个文件整整两天没到宿主 agent 手里。

## 验收命令
```bash
pnpm typecheck && pnpm test          # 各包 tsc + vitest
pnpm test:hooks                      # hook 子进程测试（不在 pnpm test 里）
pnpm check:drift                     # 两臂提示词逐条认领
pnpm check:host-parity               # 宿主入口对 UI 操作的覆盖；加了 UI 路由必须同步分类
pnpm check:domain-neutral            # 发给每个产品的代码与 skill 里没有写死的领域内容
pnpm check:i18n                      # 界面文案三语齐全、引用都命中
node --test scripts/test/*.test.mjs  # 安装脚本与 hook 夹具的测试
node scripts/replay.mjs              # 冻结运行确定性重打分（夹具在 benchmark/casegen/replay/）
node scripts/cost-report.mjs         # 每条用例的账（跑过用例之后）
```

## 目录速查
- `packages/harness-testing/` 九步节点、打分、变异、执行器（`exec/run.ts`）、接口判据（`exec/apiOracle.ts`）
- `packages/testpilot-mcp/` stdio MCP：run_pipeline · score_run · paired_eval · mutate_and_detect · drive_sut · retrieve_spec …
- `plugins/testpilot/` skills（纯数据）+ hooks（脚本）；`hooks/lib/tp.mjs::deny` 记 holds
- `server/src/runtimes.ts` runtime 注册；`penguin.ts` / `claudecode.ts` 已有适配，`codex.ts` 原生适配已按 N-11 完成
- `benchmark/<capability>/` gold · human-labels · statement · rubric · held-out · scoreboard.yaml。
  现在只剩 `casegen`（自举，仓库里唯一有冻结 gold、能打分的，catalog 标归档）。测试网的尺子是项目里的**标准测试集**（`server/src/standardSets.ts`，人冻结），不在 `benchmark/`
- 学习回路（docs/v3/15 阶段 6～9）：`regressionCandidates.ts::selectCounterexamples`（反例随运行冻结下发）、`factCandidates.ts`（界面事实候选，人确认后存成项目知识库的新版领域参考，新建运行选中才生效）、
  `standardSets.ts`（标准测试集，人冻结）、`standardEvaluation.ts`（执行模型在冻结集上比，人决定换）。
- `server/src/evolution/` 与 `extensions/penguin-evaluation/`：独立进程的旧评估沙箱（玩具任务、版本/CAS、release adapter），没接进上面的回路
- `evals/*.json` 评测定义：两臂只差一件事，`expect` 跑之前写。现在只剩 `runtime-compare`（换规划运行时）
- `fixtures/` 只剩六个：`hyperliquid-testnet`（执行层降本的被测对象，8 条 P0、全接口判据、旧口径）、
  `export-contract-v1`（2026-09-20 证据研究的组件任务，`server/src/evidenceStudy/runner.ts` 按路径读它——下面「产品代码不许读 fixtures」的唯一例外，没改）、
  `hyperliquid-mainnet`（Hyperliquid 规则包与材料，`server/scripts/` 的几个真跑脚本按路径读它）、
  `judge-golden`（判官金标）、`eval-cases`（评测用例加载器的伪造/投毒夹具）、
  `sample-spec`（合成规格 Acme Portal，G1 假模型测试用）。
  2026-09-18 删掉了 `binance-futures`、`local-perp`、`perp-lab`、`tier4-demo`、`self-test`、`recordings`、`benchmark` 等非 Hyperliquid 的数据集；
  规则包契约测试要的那份 perp-lab 规则包留成了纯夹具 `packages/harness-testing/test/fixtures/perp-lab-rules.json`（12 条测试逐条断言它里面的目标与规则，换别的包会全红）
- **产品代码不许读 `fixtures/`**：2026-09-19 下掉了 `/api/materials`（它把 `docs/` 与 `fixtures/` 下的 Markdown 列成「可选材料」发给用户项目）和 `pack.ts` 的默认规格路径

## 写作与提交信息的口径
中文；第一人称；先写失败与出乎意料的，再写改了什么；数字带来源。提交信息看 `git log` 的前 20 条照着写。
