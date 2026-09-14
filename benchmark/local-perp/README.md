# Local Perp Lab v1 benchmark

N-14 人工复核准备包。`gold.draft.json` 为 agent 准备的 12 条建议，**没有人工确认，不是冻结 gold**。训练/开发/留出按四个规则族隔离；每族正常、边界、反例各一条。Web Gold 选择 `local-perp` 后逐条核对预期、出处与 split，再保存、冻结。服务会记录当前内容哈希与真实审核入口，编辑后旧确认失效。

规格：statement/materials.md；SUT：fixtures/perp-lab；只适用于该受控版本，不推广到 Binance/Hyperliquid。旧 benchmark 的 gold、人标、held-out/rubric 保持原样。

## 复核清单
- 检查每条输入、数量/价格单位、预期与对应规格段是否一致
- 同一规则族只属于一个 split；正常、边界、反例一起移动
- 确认遗漏范围：动态杠杆档位、逐仓/全仓重算、TP/SL、资金费率、重连一致性、外部交易所与 DEX
- 逐条勾选确认，保存后再冻结；draft 和工具自测不构成人工 gold

## goldHash

尚未人工冻结。
