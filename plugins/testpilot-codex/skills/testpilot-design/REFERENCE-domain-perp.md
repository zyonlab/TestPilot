# 合约交易前端的不变量（领域 REFERENCE）

> 这一份对应 `prompts.ts` 里的 `DOMAIN_PERP`。它是**可选的一段**：在 skill 世界里，「可选」= 这份文件在不在。
> 装上它是一臂，卸掉它是另一臂（`ablate: ["domain-perp"]`）。它存在的目的是被比较：
> 对着观察写的用例只能发现产品**变了**，对着这些规则写的用例才有资格说产品**错了**。
>
> 只写**做过合约前端的人才知道、而且能变成判据**的规则。通用测试方法不在这里（那是 `REFERENCE.md`）。
> 每条规则附一个判据示例，**全部打在屏幕上**：出现了哪一行、那一行里是什么值、哪个数必须不变、
> 前端的拒绝文案。这个产品产出的是端到端 UI 测试——去问被测产品自己的接口，判的就不是用户
> 看得见的那件事（2026-09-12 用户口径，见仓库 CLAUDE.md）。
> **没有一条钉在易变读数上**——有测试扫这份文件（`domain-perp.test.ts`）。

被测对象是合约交易页（下单面板、持仓、挂单）时，设计用例前先读它；不是就跳过。

## 规则与判据

### 1. 先确认数量单位、步长及该产品的输入归一化规则
只有规格明确要求截断的前端（如本仓库 tier4-demo 演示契约），0.001 步长输入 0.0016 才应提交 0.001。交易所接受的精度限制不能证明前端必须截断；有的入口会直接拒绝非整步数量。以下示例仅用于明确的截断契约。0.001 到 0.002 是翻倍，不能描述成十倍。
```json
{"expected": "仓位表里出现 BTC 的一行，数量列显示 0.001", "oracle": {"kind": "count", "value": "BTC", "op": "eq", "n": 1}}
```

### 2. 价格按 tickSize 对齐；离参考价超过交易所的带宽（Hyperliquid：80%）的限价单在前端就被拒
80% 是历史演示契约，不是所有交易所或当前所有产品的固定规则。先获取被测版本的带宽与拒绝文案；下面只有在规格明确该文案时适用。
```json
{"expected": "页面显示「Order price cannot be more than 80% away from the reference price」", "oracle": {"kind": "text", "value": "Order price cannot be more than 80% away from the reference price"}}
```

### 3. 杠杆上限随名义价值分档；账户最终的杠杆以仓位行显示的为准
```json
{"expected": "合约头部的杠杆徽标显示 5x，且仓位行的杠杆与它一致", "oracle": {"kind": "text", "value": "5x"}}
```

### 4. 逐仓 / 全仓切换：模式与余额重算是独立验收点
下面仅证明模式已切换；余额/强平价重算需要冻结行情、计算规格和独立判据。模式通过不能证明重算正确。
```json
{"expected": "下单面板的保证金模式控件显示 Isolated", "oracle": {"kind": "text", "value": "Isolated"}}
```

### 5. 触发单类型与价格关系分别验证
相对入场价的方向规则仅在该产品规格要求时适用；盈利后移动止损等场景不能套用统一方向。下面只证明触发单类型存在，触发价必须另有精确判据。
```json
{"expected": "当前委托表里出现一行 Take Profit Market，市场列是 BTC", "oracle": {"kind": "count", "value": "Take Profit Market", "op": "eq", "n": 1}}
```

### 6. 一键平仓后该币种从仓位表里消失
```json
{"expected": "平仓后仓位表不再列出 BTC（它是唯一持仓时显示空态文案）", "oracle": {"kind": "noText", "value": "BTC-USD"}}
```

### 7. 超过可用保证金的下单被拒，名义仓位不变（tier 2：两次读数的关系）
```json
{"expected": "下单被拒，当前委托表的行数在提交前后不变", "oracle": {"kind": "delta", "value": "当前委托", "direction": "unchanged"}}
```

### 8. 撤单后挂单从当前委托表里消失
```json
{"expected": "撤单后当前委托表里没有 BTC 的挂单", "oracle": {"kind": "noText", "value": "BTC-USD"}}
```

### 9. 资金费率、倒计时、24h 量、标记价 / 预言机价是**易变读数**，禁止钉在判据里
能断言的只有「字段存在」或一个关系。
```json
{"expected": "账户权益字段在页面上存在（只断言存在，不钉数值）", "oracle": {"kind": "count", "value": "Account Equity", "op": "gte", "n": 1}}
```

### 10. 断线重连后挂单列表与重连前一致
下面的 exists 仅是接口存在性检查，**不能证明重连后 UI/API 一致**。一致性需按同一订单 ID 比较快照；当前单一 oracle 无法组合时标为未覆盖，不能用存在性替代。
```json
{"expected": "重连后当前委托表仍列出同样多的行", "oracle": {"kind": "delta", "value": "当前委托", "direction": "unchanged"}}
```

## 写法约束

- 涉及资金或仓位状态的用例**必须**带 `api` 判据；`text` 只用于前端的拒绝文案。
- 接口地址与账户地址走 `${env.*}` 占位符，不写字面量。
- 数组元素按字段选（`[position.coin=BTC]`），不按下标——下标随账户里有几个仓位而变。
- `settleMs` 给 2–4 秒：交易所接口在下单后有传播延迟。

## 适用范围与依据（2026-09-09 核验）

这是一组测试设计候选规则，不是跨交易所统一交易规则。优先级：被测版本需求/契约 → 该交易所官方规格 → 待确认建议。每个 sourceRef 存在只证明定位成功，不证明它支持结论；人工审核需核对规则族、参数、单位和版本。

- [Hyperliquid tick and lot size](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size) 定义精度限制，不定义所有前端如何修改用户输入。
- [Hyperliquid order book](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-book) 定义 tick/lot 对齐。
- [Binance Spot filters](https://github.com/binance/binance-spot-api-docs/blob/master/filters.md) 是现货过滤器资料；不能未经核对推广至合约。

金额/数量优先使用十进制字符串，API 判据精确比较，不自动引入容差。数组需唯一币种/订单 ID；多项匹配不可观测。`unit: {path,value}` 可验证单位；`freshness: {timestampPath,maxAgeMs}` 检查毫秒时间戳或 ISO 时间。前后关系必须在相同币种、账户、环境复位条件下取样。等待固定时间不证明状态已传播；过期或缺失时间应记录未观测。
