# 回放：冻结的运行，确定性重打分

借 commerce-agents 的 `commerce-evals`：**CI 只跑 replay，不打 API。** `score_run` 是确定性的，
所以一次录下来的运行在任何机器上都该算出同一个数。这里每个子目录是一次冻结的运行
（`cases.json` + `meta.json`），`expected.json` 记着它对着本目录 `../gold.json` 的分。

`node scripts/replay.mjs` 逐个重打分，`coverage` / `heldOutCoverage` / `cases` 与 `expected.json`
逐位不同就退出 1。`--write` 把当前分写成新的 expected——那是「我知道分为什么变了」的宣告，
不是修法：gold.json 变了（新谱系）、匹配规则变了（`covers`）、或者夹具本身改了，三者之一。

`fixture-run/` 是一份手写的合成运行：三条用例命中 casegen gold 的 S-01 / S-02 / S-08。
它不是真实产物，只用来钉住打分器本身——真实运行的录制放在 `benchmark/<cap>/recordings/`。
