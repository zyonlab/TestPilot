import { useEffect, useState } from "react";
import { ServerCog } from "lucide-react";
import { useT } from "@/lib/prefs";
import { API_BASE, IS_OVERRIDDEN, resetApiBase } from "@/lib/base";
import { useInSection } from "@/components/SectionNav";
import { SurfaceTabsRow, useSurfaceTabs } from "@/lib/surfaceTabs";

/**
 * 一屏的页头，一行。
 *
 * 形状照搬原型 v3 的 `.hdr`：**标题 + 等宽副标题 + 右侧动作**。
 *
 * 三处和之前不同，每一处都不是审美：
 *
 * ① **副标题走等宽体，而且它是数字。** 「wf-mtinitzq · 门禁 63%」「50 次 · 最近 08-30」
 *    ——这些是拿来对齐着扫的，比例字体下同一列数字的宽度不一样，扫不动。
 *    此前这些数字被推进正文里，页头只剩一个项目名面包屑。
 *
 * ② **页面不再自带 `<h1>`。** 之前每一页是「页头一条 + 页内一个大标题 + 一段说明」，
 *    等于两层标题，正文的前两屏被标题占掉。标题归页头，只有一个。
 *
 * ③ 项目名去掉了。它在左导航底部常驻——同一件事印两遍，人会以为是两件事。
 *
 * `hint` 是那句「这一页为什么存在」。它留着，但只占半行并省略号收尾：
 * 第一次来的人需要它，之后每天来一百次的人不需要它占掉一整段。
 */
export function TopBar({
  title,
  sub,
  hint,
  actions,
}: {
  /** 这一屏叫什么。不传就只剩右侧动作（被 section 托管时就是这样）。 */
  title?: string;
  /** 等宽的一行事实：多少条、哪一批、多少分。 */
  sub?: React.ReactNode;
  /** 这一页为什么存在，一句话。 */
  hint?: string;
  actions?: React.ReactNode;
}) {
  const t = useT();
  // 被 section 托管时，标题已经在 section 自己的页头上了，这里只留动作——
  // 两个页头叠在一起比没有页头更糟。
  const inSection = useInSection();
  // 有同组 tab 时标题让位给它们：激活的那个 tab 就是这一屏的名字。
  const hasTabs = !!useSurfaceTabs();

  // 这个标签页在驱动哪个网关。只在不是常用那个时才显示：自举时会同时起两个实例，
  // 「我现在看的是哪一个」会立刻不再显然。
  const [instance, setInstance] = useState("");
  useEffect(() => {
    if (!IS_OVERRIDDEN) return;
    void fetch(`${API_BASE}/api/health`)
      .then((r) => r.json())
      .then((d: { instance?: string }) => setInstance(d.instance ?? "?"))
      .catch(() => setInstance("unreachable"));
  }, []);

  const gateway = IS_OVERRIDDEN && (
    <button
      onClick={resetApiBase}
      title={t("topbar.backToDefault")}
      className="flex flex-none items-center gap-1 rounded bg-warn-soft px-2 py-0.5 font-mono text-[0.6875rem] text-warn hover:brightness-95"
    >
      <ServerCog className="h-3.5 w-3.5" />
      {instance || "…"} · {API_BASE.replace(/^https?:\/\//, "")}
    </button>
  );

  if (inSection) {
    if (!actions && !gateway) return null;
    return (
      <div className="flex flex-none items-center justify-end gap-2 border-b border-border px-3 py-2">
        {gateway}
        {actions}
      </div>
    );
  }

  return (
    <header className="flex min-h-[2.875rem] flex-none items-center gap-x-2.5 border-b border-border px-3 py-2">
      {title && !hasTabs && (
        <h2 className="flex-none text-[1.0625rem] font-semibold leading-tight text-foreground">{title}</h2>
      )}
      {sub !== undefined && sub !== "" && (
        <span className="flex-none font-mono text-[0.75rem] text-muted-foreground">{sub}</span>
      )}
      {/* 同一组界面的其它镜头。只有一项时它自己不画——一个孤零零的 tab 只是噪声。 */}
      <SurfaceTabsRow />
      {hint && (
        <span className="min-w-0 flex-1 truncate text-[0.75rem] text-muted-foreground" title={hint}>
          {hint}
        </span>
      )}
      <div className="ml-auto flex flex-none items-center gap-2">
        {gateway}
        {actions}
      </div>
    </header>
  );
}
