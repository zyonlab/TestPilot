# Hyperliquid 永续合约前端 · 领域参考（评测数据集）

> **这是评测数据，不是代码。** 它是 `evals/domain-perp.json` 那次「带 / 不带领域参考」对照的冻结数据集
> （按路径绑定到评测臂，内容哈希进提示词指纹）。它不出现在任何用户界面里，也不会被导入到新项目。
> 项目的领域参考由用户在「领域参考」页聊出来或上传。

## 不变量

IF THE PRODUCT UNDER TEST IS A PERPETUAL-FUTURES TRADING FRONT-END, these invariants are what a case can
contradict. Each one names the check; write the oracle against what the front-end itself shows — the row that
appears, the value in it, the refusal text — never against the exchange's own API. Apply only rules supported
by this product/version specification; missing venue rules are unobservable, never invented:
- Resolve the venue lot size and documented UI normalization first. Only a product that explicitly TRUNCATES
  0.0016 at step 0.001 must place 0.001. Rejection is also valid for other venues; never infer normalization from decimal limits.
- Price is aligned to the tick size; a limit price outside the exchange's band around the reference price is
  refused before it reaches the book. Oracle: the refusal text the front-end shows, quoted exactly.
- Max leverage falls with notional value (tiers); the leverage the account ends up with is what the position
  row shows. Oracle: the leverage badge / the position row's leverage cell reads the chosen value.
- Switching isolated/cross recomputes available balance and liquidation price — assert the MODE the panel now
  shows, not the numbers, which move with the market.
- A take-profit trigger sits above the entry for a long and below for a short; stop-loss the other way.
  Oracle: after placing, a row for that trigger order appears in the open-orders table naming that market.
- Closing a position removes it: after Market Close the positions table no longer lists that market (the empty
  state text appears when it was the only one).
- An order larger than available margin is refused: the front-end shows its refusal, and no new row appears in
  the open-orders table (tier 2: the row count is unchanged).
- Funding rate, countdown, 24h volume, mark/oracle price are VOLATILE readings: never pin them in an
  assertion. Assert that the field exists, or assert a relation, never a value.
- After a disconnect/reconnect the open-orders table must still list the same rows it listed before.
Assertions about money or position state are made on the table that displays them, with the identifiers the
user chose (market, price, size) — so a reader can reproduce the check by looking at the screen.
Use decimal strings for financial values, explicit base/quote units, uniquely selected coin/order IDs, fresh state and reset preconditions.
Mode existence does not prove balance recomputation, and order existence does not prove trigger price or UI/API equality. Split these obligations or report unobservable.

## 这些不变量怎么变成屏幕判据（原 `REFERENCE-domain-perp.md` 的示例）

### 1. 「某件事发生了」→ 出现了哪一行
```json
{"expected": "仓位表里出现 BTC 的一行，数量列显示 0.001", "oracle": {"kind": "count", "value": "BTC", "op": "eq", "n": 1}}
```

### 2. 「某件事被撤销了」→ 那一行不见了
```json
{"expected": "平仓后仓位表不再列出 BTC（它是唯一持仓时显示空态文案）", "oracle": {"kind": "noText", "value": "BTC-USD"}}
```

### 3. 「产品应该拒绝」→ 拒绝文案逐字出现
```json
{"expected": "页面显示「Order must have minimum value of $10.」", "oracle": {"kind": "text", "value": "Order must have minimum value of $10."}}
```

### 4. 「这一步不该改变什么」→ 两次读数的关系（tier 2）
```json
{"expected": "下单被拒，当前委托表的行数在提交前后不变", "oracle": {"kind": "delta", "value": "当前委托", "direction": "unchanged"}}
```

### 5. 易变读数只能断言存在或关系，不能钉住数值
```json
{"expected": "标头显示 Funding / Countdown 字段", "oracle": {"kind": "text", "value": "Funding / Countdown"}}
```

### 6. 判决永远从屏幕读，不去问被测产品自己的接口
```json
{"expected": "屏幕显示「Limit order placed.」", "oracle": {"kind": "text", "value": "Limit order placed."}}
```
