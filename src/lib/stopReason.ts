/**
 * 探索为什么停下来，翻译成读者的语言。
 *
 * 这句话原来是探索时拼好的中文，直接写进图 JSON、原样显示——
 * 于是英文界面里会冒出「采满 18 屏的上限」。现在探索同时发一份结构化的
 * `{ kind, n }`，语言由界面决定。
 *
 * **旧运行只有那句中文。**回落到原文，而不是显示空白或者一句「未知原因」——
 * 原文虽然语言不对，至少是真的。
 */
export function stopReason(
  t: (key: string, vars?: Record<string, string | number>) => string,
  stopped?: { kind: string; n?: number },
  legacy?: string,
): string {
  if (!stopped) return legacy ?? "";
  const key = `stop.${stopped.kind}`;
  const text = t(key, stopped.n !== undefined ? { n: stopped.n } : undefined);
  // 认不出的 kind（比如以后新增的）不要把 `stop.xxx` 这种内部字串印给人看。
  return text === key ? (legacy ?? "") : text;
}
