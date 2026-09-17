## What and why / 改了什么、为什么

<!-- Start with what failed or surprised you, then what you changed. / 先写失败与出乎意料的，再写改了什么。 -->

## Verification / 验证

- [ ] `pnpm typecheck && pnpm test`
- [ ] `pnpm test:hooks`
- [ ] `pnpm check:drift`
- [ ] `pnpm check:host-parity`
- [ ] `pnpm check:domain-neutral`
- [ ] `pnpm check:i18n`
- [ ] Real run / browser check, if generation, execution or UI changed / 涉及生成、执行或界面时，真实运行或浏览器验证：

## Checklist / 自查

- [ ] Verdicts still come from the screen; no oracle reads the product's own API / 判决仍从屏幕读
- [ ] No hard-coded domain content / 没有写死的领域内容
- [ ] Prompts or skills changed → `skillVersions` bumped and host plugins rebuilt / 改了提示词或 skill 已跳版本并重建插件
- [ ] New UI strings in zh / en / ja; new UI routes classified in `server/host-parity.json` / 新文案三语、新路由已分类
- [ ] No secrets, run data or protected evaluation files (`gold.json`, `human-labels.json`, `held-out/`, `rubric/`) / 没有密钥、运行数据或受保护的评测文件
