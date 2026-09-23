# 用例审核意见

运行：run-be86df4d-bb2e-48c4-9596-249d4dc7e157

审核来源：Codex 受用户委托进行文档审查；不是实际产品测试结果，也不冒充人类签字。

结论：暂不整体放行至自动执行。确定性设计门禁 passed=true，但不证明夹具就绪或资金断言可计算。83 条用例中，77 条 requires-fixture、2 条 ready、2 条 blocked、2 条 not-executable。

## 需要修改

1. C-market-03-01、C-order-01-01 标为 ready，但 reason 仍写缺账户和数值计算能力，与其只检查静态标签的步骤和前置条件矛盾。应更正理由；同时确认 Oracle、Funding / Countdown、Sell / Short 等附加断言均有执行判据，不能只凭主标签判整例通过。
2. C-account-02-01 前置要求已经启用交易，步骤却点击 Enable Trading。需使用“已连接但尚未启用交易”的对应夹具，并保留拒签流程的覆盖缺口。
3. C-position-07-01 目标为单市场全平，步骤使用 Close All，可能波及其他市场；改为目标行平仓或明确独占单仓夹具。其余额核对目标还需要显式采集 Balances，而非仅查看持仓和历史。
4. C-order-05-01 拒绝场景的清理写“撤销本次被接受的委托”，需要改为条件清理；未接受时不得撤销其他订单。
5. C-settlement-05-02、C-settlement-06-02 是测试系统的审计约束，不是产品 UI 行为，应移到测试框架验证集合，保留对应需求缺口。
6. 金额准确性用例描述了十进制/同步快照公式，但执行能力仍未具备。必须补齐取数时间窗、市场/订单/币种作用域、舍入区间和独立计算判据，再允许自动判定。

## 放行条件

- 两条静态标签用例修正元数据并逐项配置断言后，可单独复核为 UI 冒烟集，不能代表交易闭环已验证。
- 77 条夹具依赖用例逐条补齐可重置账户/资金/持仓/订单状态、操作定位和计算判据。缺夹具不等于设计无效，暂缓放行而非一律驳回。
- 两条借贷 blocked 用例先验证产品适用性；两个审计判据从产品执行队列移出。
- 本轮没有下单、平仓、转账或更改钱包，也没有写入人工批准记录。

## 逐条处置建议

| 用例 | 标题 | 当前执行状态 | 审核处置 |
|---|---|---|---|
| C-account-01-01 | 连接注入钱包后身份与测试夹具一致 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-account-02-01 | 准备交易授权时保持测试账户身份 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-account-03-01 | 余额表分别标识总量可用量与估值 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-account-04-01 | 同币种子账划转在总账户内抵消 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-account-04-02 | 挂单冻结不把可用额度下降重复记为权益损失 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-account-05-01 | 全平后余额差不叠加释放保证金 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-account-06-01 | Unified同抵押币全仓市场共享保证金占用 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-account-06-02 | 不同抵押币余额不能补足本市场资金缺口 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-account-07-01 | Manual单DEX挂单不占另一DEX余额 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-account-07-02 | DEX A余额不足时不能使用DEX B余额下单 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-market-01-01 | 从BTC切换ETH后使用ETH数量与杠杆约束 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-market-02-01 | 订单详情绑定账户DEX与计价币 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-market-02-02 | 切换不同结算币市场不复用上一市场金额单位 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-market-03-01 | 行情区为Mark Oracle和资金费分别标注名称 | ready | 修改就绪理由并核实全部断言后复核 |
| C-market-04-01 | 同快照比较行情Mark与持仓Mark Price | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-market-05-01 | 合法步长数量保持提交精度 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-market-05-02 | 超精度输入不能成为超精度委托数量 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-market-06-01 | 非整数合法价格提交后不被默改 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-market-06-02 | 非法非整数价格不能作为原值进入委托 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-market-06-03 | 合法整数例外不被5位有效数字规则拒绝 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-risk-01-01 | Cross开仓计入相关共享风险池 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-risk-02-01 | 调整逐仓A保证金不挪用逐仓B抵押品 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-risk-02-02 | 余额不足的追加保证金不能挪用另一逐仓抵押品 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-risk-03-01 | 最低1倍杠杆可保存 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-risk-03-02 | 有效上限Lmax可保存 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-risk-03-03 | 跨档位后超出新上限的杠杆不能保存 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-risk-04-01 | 空仓预估分离保证金基式与费用 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-risk-04-02 | 已有持仓和挂单时预估使用净增风险 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-risk-05-01 | 市场A增仓保留市场B数量与入场价 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-risk-05-02 | 风险汇总不得把不同抵押币名义数额直接相加 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-risk-06-01 | 合格抵押品借款额度扣除已有负债 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-risk-06-02 | 不满足资格不能进入可借款状态 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-risk-06-03 | 超过已核实借款上限的申请被拒绝 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-order-01-01 | 观察回归：下单面板保留多空方向标签 | ready | 修改就绪理由并核实全部断言后复核 |
| C-order-02-01 | 预算换算后不足门槛的最终数量不能提交普通订单 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-order-03-01 | 保证金预估与基式及明确调整项对齐 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-order-03-02 | 部分成交名义额不计未成交残量 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-order-04-01 | 实际成交费用采用逐笔角色与成交价 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-order-05-01 | 普通订单低于量化最低数量一个步长被拒 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-order-05-02 | 普通订单在量化最低数量可接受 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-order-05-03 | 普通订单高于量化最低数量一个步长可接受 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-order-06-01 | 保证金不足拒绝普通订单 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-order-06-02 | Reduce Only增仓请求拒绝 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-order-06-03 | 异常价格委托被拒绝 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-order-06-04 | 无流动性市价请求不产生虚构成交 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-execution-01-01 | 限价买入每笔成交不高于限价 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-execution-01-02 | 限价卖出每笔成交不低于限价 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-execution-01-03 | IOC未立即成交残量取消 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-execution-01-04 | ALO跨价请求不能立即吃单 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-execution-02-01 | 高级订单在其已核实约束内接受参数 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-execution-02-02 | 高级类型独立约束外参数被拒绝 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-execution-03-01 | 部分成交数量与挂单残量合计Original Size | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-execution-03-02 | 订单结束后成交量与取消量不重复计数 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-execution-04-01 | 撤销余单仍保留已成交仓位 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-execution-04-02 | 撤单成交竞态只产生唯一最终数量分配 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-execution-05-01 | 提交未决时重复点击不产生重复交易 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-execution-05-02 | 重复反馈不重复计入成交 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-execution-06-01 | 刷新并重连后保持订单与成交集合 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-position-01-01 | 零持仓边界首开按全部成交计算Entry Price | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-position-01-02 | 不同成交价同向加仓按新旧数量加权成本 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-position-02-01 | 部分平仓不能重写剩余仓位入场成本 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-position-03-01 | 无仓位时Reduce Only不得开仓 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-position-03-02 | 超额Reduce Only平仓不得翻为空头 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-position-04-01 | TP触发后零成交边界不得显示已退出 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-position-05-01 | 风险档位边界使用对应维持保证金率及扣减项 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-position-06-01 | 双市场部分平仓只减少目标仓位 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-position-07-01 | 恰好全平边界清零并排除保证金重复收益 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-settlement-01-01 | 多空盈亏零点边界使用同步Mark | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-settlement-01-02 | 加仓后与部分平仓后分别复核持仓成本 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-settlement-02-01 | 混合maker与taker成交按实际费档分别核费 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-settlement-03-01 | 资金费率零点两侧按结算Oracle核对历史现金流 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-settlement-04-01 | 合资格账户借入本金同时增加资产与负债 | blocked | 暂缓：先核实功能适用性和夹具 |
| C-settlement-04-02 | 恰还清本金边界区分本金与利息 | blocked | 暂缓：先核实功能适用性和夹具 |
| C-settlement-05-01 | 同一时间窗逐币种重建权益并抵消内部流转 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-settlement-05-02 | 对账差额未获凭证时拒绝用其他项填平（审计判据） | not-executable | 移到测试框架审计验证，保留覆盖缺口 |
| C-settlement-06-01 | 量化后的数量用于Order Value十进制区间计算 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-settlement-06-02 | 关键输入不同步时拒绝给出精确通过结论（审计判据） | not-executable | 移到测试框架审计验证，保留覆盖缺口 |
| C-journey-01-01 | 同一身份市场完成首开并以成交重建Entry Price | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-journey-01-02 | 持仓减至零边界后余额不重复计入释放保证金 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-journey-01-03 | AC外补充R20：会立即吃单的ALO委托不得启动成交闭环 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-journey-02-01 | 部分成交撤余单后重连保留唯一成交和仓位 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-journey-02-02 | 撤单竞态在未成交残量零边界不得抹除最终成交 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |
| C-journey-02-03 | 撤余单重连后的资金变化只计实际成交及费用 | requires-fixture | 保留设计候选，补齐夹具与判据后复核 |

