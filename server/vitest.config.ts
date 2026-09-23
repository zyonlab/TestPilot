import { configDefaults, defineConfig } from "vitest/config";

/**
 * 测试有自己的数据目录。
 *
 * 不隔离的后果是实测出来的：`server/test/` 里的每一条 `startRun` 都会写进
 * **真实的** `server/.data/workflows.db`。一次 `pnpm test` 之后，运行列表里就多出
 * 十几条永远停在 `running` 的 g1-text-cases——它们和人真正跑过的运行混在一起，
 * 出现在运行下拉、⌘K 的候选、以及任何按时间排序的地方。
 * 2026-09-01 就是这么发现的：命令面板按时间取最近 12 次，取到的全是测试造的。
 *
 * `TP_DATA_DIR` 这个开关早就存在（见 `src/datadir.ts` 的注释，它是为自举时
 * 「两个网关不能共用一个库」加的）——测试要的是同一件事，只是一直没设。
 */
export default defineConfig({
  test: {
    // Exported Playwright suites are runtime evidence, not Vitest unit-test sources.
    exclude: [...configDefaults.exclude, '**/.data*/**'],
    env: {
      TP_DATA_DIR: ".data-test",
      TP_INSTANCE: "test",
    },
  },
});
