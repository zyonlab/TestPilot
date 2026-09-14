import { useEffect, useState } from "react";
import { Dialog } from "@/components/overlay";
import { useT } from "@/lib/prefs";

/**
 * 按 `?` 看全部快捷键。
 *
 * 这个产品此前**没有任何一处总览**：复核台的键位印在右栏底部一段灰字里，
 * 而其余十屏一个字都没有。后果不是「高级用户不方便」——是
 * **一个每天要过上百条的界面，它最快的那条路没人知道存在**。
 *
 * 用 `?` 而不是菜单里一个条目：`?` 是这一类工具的通用约定（GitHub、Linear、
 * Gmail 都是它），而通用约定的价值恰恰在于不用教。
 *
 * 输入框里不拦截——在搜索框里打一个问号是打字，不是求助。
 */
export function Shortcuts() {
  const t = useT();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* 按**在哪儿用**分组，不按键位字母序：人是带着「我现在在复核」这个上下文来查的。 */
  const groups: Array<{ where: string; keys: Array<[string[], string]> }> = [
    {
      where: t("keys.global"),
      keys: [
        [["⌘", "K"], t("keys.palette")],
        [["?"], t("keys.thisSheet")],
        [["Esc"], t("keys.dismiss")],
      ],
    },
    {
      where: t("keys.review"),
      keys: [
        [["J"], t("keys.next")],
        [["K"], t("keys.prev")],
        [["X"], t("keys.toggle")],
        [["A"], t("keys.selectAll")],
        [["1"], t("keys.approve")],
        [["3"], t("keys.reject")],
      ],
    },
    {
      where: t("keys.tabs"),
      keys: [[["←", "→"], t("keys.switchTab")]],
    },
  ];

  return (
    <Dialog open={open} onClose={() => setOpen(false)} title={t("keys.title")}>
      <div className="flex flex-col gap-5 p-1">
        {groups.map((g) => (
          <div key={g.where}>
            <div className="eyebrow mb-1.5">{g.where}</div>
            <div className="flex flex-col gap-1">
              {g.keys.map(([keys, what]) => (
                <div key={what} className="flex items-baseline gap-2 text-[0.8125rem]">
                  <span className="flex flex-none gap-1">
                    {keys.map((k) => (
                      <kbd key={k} className="kbd">
                        {k}
                      </kbd>
                    ))}
                  </span>
                  <span className="text-ink2">{what}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {/* 复核那一组只在复核台上有效，说出来比让人试一遍便宜。 */}
        <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">{t("keys.scopeNote")}</p>
      </div>
    </Dialog>
  );
}
