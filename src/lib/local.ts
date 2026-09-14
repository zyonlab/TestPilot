/**
 * 本地记忆的两个安全读写。
 *
 * localStorage 在无痕窗口、或禁用站点数据的浏览器里会**直接抛**。记住上次看到哪儿
 * 只是个便利，不该因为它让整个应用打不开——所以读写都吞掉异常，读不到就当没有。
 */
export function safeGet(k: string): string {
  try {
    return window.localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
}

export function safeSet(k: string, v: string): void {
  try {
    window.localStorage.setItem(k, v);
  } catch {
    /* 存不下就算了 */
  }
}

/** 上次复核停在哪一批的哪一条。 */
export const LAST_PLACE = "tp.lastReviewPlace";
