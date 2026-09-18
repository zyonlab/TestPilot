# Contributing to TestPilot

Thanks for your interest. This guide is in English first, with a Chinese version below.
感谢参与。英文在前，[中文版](#参与贡献中文) 在后。

## Before you start

- Read the [README](README.en.md) and the [architecture overview](docs/v3/00-架构.md) (Chinese).
- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Please keep changes within the current release scope. Self-improvement, experience libraries, parallel sub-agents, gold sets / scoreboards and the research track are frozen for now.

## Development setup

```bash
pnpm install --frozen-lockfile
cp server/.env.example server/.env        # fill in the executor model
node scripts/testpilot-setup.mjs doctor
node scripts/testpilot-setup.mjs start    # API :5301 + Web :5300
```

Node.js 22+ and pnpm 9/10 are required. Use the same Node major version to install and to run.

## Ground rules

These rules are enforced by checks or by review. A PR that breaks one will not be merged.

1. **Verdicts come from the screen.** TestPilot produces end-to-end UI tests. Never make a test's verdict depend on the product's own API; the design gate flags such oracles (`oracle-offsite`).
2. **No hard-coded domain content.** Anything specific to one product or industry belongs in project data (rule packs, domain references, environment profiles), never in code or skills, and never as `if (someDomain)`. `pnpm check:domain-neutral` must pass.
3. **Humans hold the gates.** Freezing a module tree, approving or rejecting cases, and deciding regression candidates are human decisions. Do not add paths that let an agent make them.
4. **Self-heal never edits an oracle.** Repairs may change how a step is phrased, never what is checked.
5. **Prompts and skills move together.** If you change `packages/harness-testing/src/casegen/prompts.ts` or `plugins/testpilot/skills/**`:
   - bump the matching `skillVersions` entry in `plugins/testpilot/plugin.json`;
   - regenerate the host plugins: `pnpm build:claude-plugin` and `pnpm build:codex-plugin`;
   - make sure `pnpm check:drift` passes.
6. **New UI routes are classified.** Every new API route used by the UI must be listed in `server/host-parity.json` as host-reachable, `todo`, or UI-only with a reason (`pnpm check:host-parity -- --write` adds it). Host coverage may not drop.
7. **UI text is translated.** Add every new string to `src/lib/i18n.ts` in Chinese, English and Japanese; `pnpm check:i18n` must pass.
8. **Protected evaluation data is off-limits.** Do not edit `benchmark/*/gold.json`, `human-labels.json`, `held-out/` or `rubric/`, and never put them into prompts.
9. **Only test what you may test.** Never point exploration or execution at production systems you do not own. Keep production hosts that must never be touched in `guard.denyHosts`.

## Checks to run before a PR

CI is currently switched off (see `.github/workflows/ci.yml`), so please run these locally:

```bash
pnpm typecheck && pnpm test
pnpm test:hooks
pnpm check:drift
pnpm check:host-parity
pnpm check:domain-neutral
pnpm check:i18n
```

If your change touches generation, execution or the UI, describe how you verified it with a real run or in a browser, including what did not work.

## Commits and pull requests

- Keep each PR focused on one change.
- Write commit messages and PR descriptions that state what failed or surprised you first, then what you changed, with numbers and where they came from.
- Include the checks you ran and their results in the PR description.
- Do not commit `server/.env`, API keys, wallet keys, `server/.data/`, `midscene_run/` or other run output.

## Reporting bugs and security issues

- Bugs and feature requests: open a GitHub issue using the templates.
- Security issues: do **not** open a public issue with details. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

---

## 参与贡献（中文）

### 开始之前

- 先读 [README](README.md) 和 [架构](docs/v3/00-架构.md)。
- 比小修复大的改动，请先开 issue 对齐做法。
- 请留在当前版本的范围内：自进化、经验库、子 agent 并行、Gold 与记分板、论文研究线目前冻结。

### 本地开发

```bash
pnpm install --frozen-lockfile
cp server/.env.example server/.env        # 填好执行模型
node scripts/testpilot-setup.mjs doctor
node scripts/testpilot-setup.mjs start    # API :5301 + Web :5300
```

需要 Node.js 22+ 和 pnpm 9/10，安装和运行要用同一个 Node 大版本。

### 基本规则

这些规则由检查或评审把关，违反的 PR 不会合并。

1. **判决从屏幕读**：不要让用例的判决依赖被测产品自己的接口，门禁会标记这类判据（`oracle-offsite`）。
2. **不写死领域内容**：只属于某个产品或行业的内容，一律放进项目数据（规则包、领域参考、环境画像），不进代码和 skill，也不写成 `if (某个领域)`。`pnpm check:domain-neutral` 必须通过。
3. **人把关的环节不交给 agent**：冻结模块树、批准或驳回用例、决定回归候选的去留，都是人的决定。
4. **自愈不改判据**：修复只能改步骤的写法，不能改检查的内容。
5. **提示词和 skill 一起改**：改了 `packages/harness-testing/src/casegen/prompts.ts` 或 `plugins/testpilot/skills/**`，要做三件事：
   - 提升 `plugins/testpilot/plugin.json` 里对应的 `skillVersions`；
   - 重新生成插件（`pnpm build:claude-plugin`、`pnpm build:codex-plugin`）；
   - 确认 `pnpm check:drift` 通过。
6. **新的界面路由要分类**：写进 `server/host-parity.json`（宿主可达、todo，或写明理由的界面专属；`pnpm check:host-parity -- --write` 会帮你加上），宿主覆盖率不能下降。
7. **界面文案要三语**：新文案加进 `src/lib/i18n.ts`（中英日），`pnpm check:i18n` 必须通过。
8. **受保护的评测数据不要动**：不改 `benchmark/*/gold.json`、`human-labels.json`、`held-out/`、`rubric/`，也不放进提示词。
9. **只测你有权测的东西**：不要把探索或执行指向不属于你的生产系统；绝不能碰的生产地址放进 `guard.denyHosts`。

### 提 PR 前要跑的检查

CI 目前手动关闭（见 `.github/workflows/ci.yml`），请在本地跑：

```bash
pnpm typecheck && pnpm test
pnpm test:hooks
pnpm check:drift
pnpm check:host-parity
pnpm check:domain-neutral
pnpm check:i18n
```

改动涉及生成、执行或界面时，请说明你是怎么用真实运行或浏览器验证的，包括没跑通的部分。

### 提交与 PR

- 一个 PR 只做一件事。
- 提交信息和 PR 说明先写失败与出乎意料的，再写改了什么；数字要带来源。
- 在 PR 说明里列出跑过的检查和结果。
- 不要提交 `server/.env`、API 密钥、钱包私钥、`server/.data/`、`midscene_run/` 等运行产物。

### 报告问题

- 缺陷和功能建议：按模板开 GitHub issue。
- 安全问题：**不要**公开细节，按 [SECURITY.md](SECURITY.md) 处理。

### 许可

提交贡献即表示你同意以 [MIT 许可](LICENSE) 发布这些贡献。
