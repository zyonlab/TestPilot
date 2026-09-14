/** Observe bounded render readiness before asking a vision model to act. */
export async function settleOn(
  page: { evaluate<T>(fn: () => T): Promise<T> },
  opts: { minMs?: number; maxMs?: number } = {},
): Promise<{ ms: number; controls: number; textLen: number; settled: boolean }> {
  const minMs = opts.minMs ?? 600;
  const maxMs = opts.maxMs ?? 12_000;
  const probe = async (): Promise<{ n: number; len: number; res: number }> =>
    page
      .evaluate(() => ({
        n: [...document.querySelectorAll("button, a, input, select, textarea, [role=button]")].filter(
          (el) => (el as HTMLElement).offsetParent !== null,
        ).length,
        len: (document.body?.innerText ?? "").length,
        res: performance.getEntriesByType("resource").length,
      }))
      .catch(() => ({ n: 0, len: 0, res: 0 }));

  const began = Date.now();
  if (minMs) await new Promise((r) => setTimeout(r, minMs));
  let last = await probe();
  let steady = 0;
  while (Date.now() - began < maxMs) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await probe();
    // 只看"有没有长"，不看有没有缩：SPA 切换时会先清空再重画，
    // 把"缩了"当成变化会让这里每次都等满上限。
    const domGrew = now.n > last.n || now.len > last.len;
    /**
     * **DOM 不动不等于画完了。**
     *
     * 2026-09-13 在 hyperliquid-testnet 量到的时间线：3742ms 起骨架是 17 个控件 /
     * 302 个字符，**连续两轮一模一样**，于是这里判 settled；而 `Order Book` 要到
     * 5309ms 才出现，文本 302 → 1220 → 1740。执行日志里那句
     * `page ready after 2117ms (16 controls, 309 text characters)` 就是这么来的，
     * 随后视觉模型对着骨架说「页面上不存在 Order Book 标签」——一条记在产品头上的失败，
     * 产品其实什么事都没有。
     *
     * 骨架期 DOM 不动是因为数据还在路上，而**资源计数一直在涨**（65→71→76→80，
     * 每 500ms 四到六条）；画完之后掉到每轮 0–1 条（行情轮询）。所以用它当第二个信号：
     * 涨得比轮询快，就还不算稳。同一条时间线上这条规则停在 9429ms / 28 控件 / 1740 字符。
     */
    const stillFetching = now.res - last.res > 1;
    if (!domGrew && !stillFetching) steady += 1;
    else steady = 0;
    last = now;
    if (steady >= 2 && (last.n > 0 || last.len > 0))
      return { ms: Date.now() - began, controls: last.n, textLen: last.len, settled: true };
  }
  return { ms: Date.now() - began, controls: last.n, textLen: last.len, settled: false };
}
