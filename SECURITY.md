# Security Policy

[中文](#安全策略中文)

## Supported versions

TestPilot is in an early release (0.1). Only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue, discussion or pull request that describes a vulnerability.

Instead, open a GitHub issue titled "Security contact request" **without any technical details**, and a maintainer will reply with a private channel. We aim to acknowledge reports within 7 days.

Please include, once a private channel is set up:

- the affected component (Web UI, API server, MCP server, plugin/hooks, executor, export);
- steps to reproduce and the impact;
- the commit you tested.

## Scope and threat model

Things worth knowing before you deploy or report:

- **Local, single-user by design.** Local review has no authentication. The API server (`:5301`) and Web UI (`:5300`) are meant to run on your own machine. Do not expose them to a network you do not trust.
- **It drives real browsers.** Exploration and execution click, submit and delete on the target site, and irreversible steps are allowed by default. Only point TestPilot at systems you are allowed to test, ideally a test environment. `guard.denyHosts` in `server/harness.config.ts` (plus `DENY_HOSTS`) is the only global block list; `GUARD_STRICT=1` blocks irreversible steps machine-wide.
- **Secrets stay local.** Model keys live in `server/.env`, project secrets are encrypted in the local data directory, and diagnostics never print credential values. Reports that TestPilot leaks a secret into logs, artifacts, exports, prompts or the UI are in scope.
- **Wallet injection is for test networks.** The injected wallet signs locally without prompts. Never use it with an account that holds real funds.
- **Model output is untrusted.** Generated cases and code are reviewed by a human before they run, and self-heal may not change an oracle. Ways to bypass those gates are in scope.

Out of scope: issues that require an attacker who already controls your machine or your `server/.env`, and findings in third-party services TestPilot is pointed at.

---

## 安全策略（中文）

### 支持的版本

TestPilot 处于早期版本（0.1），只对 `main` 的最新提交提供安全修复。

### 报告漏洞

请**不要**在公开的 issue、讨论或 PR 里描述漏洞。

请开一个标题为「Security contact request」的 issue，**不要写任何技术细节**，维护者会回复一个私下沟通的渠道。我们争取在 7 天内确认收到。

建立私下渠道后，请提供：

- 受影响的组件（Web 界面、API 服务、MCP 服务、插件/hooks、执行器、导出）；
- 复现步骤和影响；
- 你测试时的提交。

### 范围与威胁模型

部署或报告前值得了解的几点：

- **设计上是本机单用户**：本地复核不做身份验证，API 服务（`:5301`）和 Web 界面（`:5300`）只应在自己的机器上运行，不要暴露到不受信任的网络。
- **会驱动真实浏览器**：探索和执行会在被测站点上真的点击、提交、删除，不可逆步骤默认放行。只对你有权测试的系统使用，最好是测试环境。`server/harness.config.ts` 的 `guard.denyHosts`（加上 `DENY_HOSTS`）是唯一的全局禁止名单；`GUARD_STRICT=1` 可在整台机器上拦截不可逆步骤。
- **密钥留在本机**：模型密钥在 `server/.env`，项目密钥加密存放在本地数据目录，诊断输出不打印凭证。TestPilot 把密钥泄露到日志、产物、导出工程、提示词或界面的问题，都在范围内。
- **钱包注入只用于测试网**：注入的钱包在本地签名、不弹窗，绝不要用于持有真实资产的账户。
- **模型输出不可信**：生成的用例和代码要经人复核才能执行，自愈不允许改判据。能绕过这些关口的方法都在范围内。

不在范围内：需要攻击者已经控制你的机器或 `server/.env` 的问题，以及 TestPilot 所测试的第三方服务本身的问题。
