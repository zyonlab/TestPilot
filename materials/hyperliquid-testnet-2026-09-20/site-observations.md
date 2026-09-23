# Hyperliquid Testnet /trade — 本次页面观察

采集日期：2026-09-20；derivedFrom: exploration；使用 Codex 浏览器实际访问 https://app.hyperliquid-testnet.xyz/trade 。agent-browser 本机未安装，改用内置浏览器。以下是本次观察摘要，不是正式 runObserve 的 graph/report；没有伪造状态或转移 ID。

## 范围与登录状态
本次浏览器是未连接钱包状态；查看了主交易页、账户模式弹窗、限价面板、仓位表、资产表及 Connect 弹窗。没有下单、修改账户模式、划转或签名。页面没有显示 WAF 挑战；未运行注入钱包后的登录验证。页面空余额不代表本机测试钱包没有资金。

## 交易主页面
BTC-USDC；行情包含 Mark、Oracle、24h Change、24h Volume、Open Interest、Funding / Countdown；订单簿有 Price、Size (BTC)、Total (BTC)。价格、费率、倒计时、杠杆显示均不得由这次快照硬编码为长期断言。
下单面板：Cross、杠杆按钮（加载后20x）、Unified、Market、Limit、Pro、Buy / Long、Sell / Short、Available to Trade、Current Position、Size（BTC）、百分比、Reduce Only、Take Profit / Stop Loss。
预估区：Liquidation Price、Order Value、Margin Required、Slippage、Fees。本次未登录时费率显示0.0450% / 0.0150%，仅是观察，不是所有账户的常量。
切到 Limit 后出现 Price (USDC)、Mid、TIF、GTC；没有提交表单。

## 账户模式弹窗
点击 Unified 打开 Account Type，包含 Unified Account (Recommended)、Portfolio Margin、Manual。
Unified 的说明：抵押资产各自一个余额；永续只能用结算资产做抵押，相同抵押资产的全仓仓位共享保证金。
Portfolio Margin 的说明：合并现货与永续；HYPE、BTC 等合格资产可直接用作抵押；空闲资产与借入资产涉及利息。
Manual 的说明：不同 DEX 独立余额，全仓只在同一 DEX 内共享。
当前账号是否符合 Portfolio Margin 准入、模式切换是否成功均未验证。点 Cross 没有得到有效模式弹窗，逐仓行为由文档支持，不能冒充本次已验证。

## 资产、仓位和订单
Balances 表头：Asset / Total Balance / Available Balance / USDC Value / PNL (ROE %) / Repay / Contract；未登录空态 No balances yet。
Positions 表头：Market / Size / Position Value / Entry Price / Mark Price / PNL (ROE %) / Liq. Price / Margin / Funding；未登录空态 No open positions yet。
Open Orders 表头：Time / Type / Market / Direction / Size / Original Size / Order Value / Price / Reduce Only / Trigger Conditions / TP/SL；未登录空态 No open orders yet。
还可见 TWAP、Chase、Trade History、Funding History、Order History 标签，本次未核对内容。
右侧摘要：Unified Account Summary、Unified Account Ratio、Portfolio Value、Unrealized PNL、Perps Maintenance Margin、Unified Account Leverage。Deposit / Withdraw 按钮可见，未操作。

## 钱包连接
Connect 弹窗有 Log in with Email、Default Wallet、WalletConnect、OKX Wallet、Coinbase Wallet。
本项目按用户要求使用 TestPilot 注入钱包。上述未注入环境的钱包名称不能代替注入后的实测定位；仓库既有测试网环境的 Enable Trading → Establish Connection 步骤只能作为待首跑核对的配置。

## 未验证
注入钱包后的地址、资金、Enable Trading、最小下单边界、具体币对精度、成交和撤单、模式切换、反手、资金费结算、清算和多抵押品借贷均未实际执行。高级订单/不同资产/不同账户的可用性需要逐项确认。
