import { createContext, useContext } from "react";
import { cn } from "@/lib/cn";

/**
 * 同一组界面在页头上并列成 tab。
 *
 * 这是把左导航从 18 项收回 11 项之后，那些界面的去处：**同一个对象的不同镜头
 * 不该各占一个导航项**。看板 / 复核队列 / 需求追溯问的都是「这批用例怎么样」，
 * 套件批次 / 执行记录 / 趋势问的都是「这一批跑得怎么样」。
 * 各占一项的代价是人要先记住每样东西归在哪一类，而这正是当初想用画布取代目录的理由。
 *
 * 为什么用 context 而不是把 tab 画在页面外面：页头是每一页**自己**渲染的
 * （`TopBar`），tab 要和标题在同一行才不会变成第二条工具栏。外壳把同组界面放进
 * context，页头顺手画出来——页面本身一行都不用改。
 */
export interface SurfaceTab {
  id: string;
  label: string;
}

export interface SurfaceTabsValue {
  tabs: SurfaceTab[];
  current: string;
  onSwitch: (id: string) => void;
}

const Ctx = createContext<SurfaceTabsValue | undefined>(undefined);

export const SurfaceTabsProvider = Ctx.Provider;

/** 页头用它决定要不要画 tab。只有一项时不画：一个孤零零的 tab 是噪声。 */
export function useSurfaceTabs(): SurfaceTabsValue | undefined {
  const v = useContext(Ctx);
  return v && v.tabs.length > 1 ? v : undefined;
}

/**
 * 那一排 tab 本身。
 *
 * 抽成组件是因为它有两个家：多数页面的页头是 `TopBar`，而复核台自己写了一条页头
 * （它要在同一行里塞下批次切换与门禁分数）。同一排 tab 在两处各画一遍，
 * 迟早只在一处改样式。
 */
export function SurfaceTabsRow({ className }: { className?: string }) {
  const group = useSurfaceTabs();
  if (!group) return null;
  return <TabsRow tabs={group.tabs} current={group.current} onSwitch={group.onSwitch} className={className} />;
}

/**
 * 同一排 tab 的**画法**，与它的内容从哪来无关。
 *
 * 从 `SurfaceTabsRow` 里抽出来的理由和当初把 `SurfaceTabsRow` 抽成组件的理由一模一样：
 * 它又多了一个家。审计台内部也是一组 tab（校准 / 审计报告 / 变化），
 * 而**那三个必须和页头这三个用同一套键盘语义**——同一个界面里两排长得一样的 tab，
 * 一排能用方向键走、另一排不能，人会认为方向键坏了，而不是认为这两排不一样。
 * 照抄一遍必然分叉，所以只留一份实现。
 */
export function TabsRow({
  tabs,
  current,
  onSwitch,
  className,
  label,
}: {
  tabs: SurfaceTab[];
  current: string;
  onSwitch: (id: string) => void;
  className?: string;
  /** 这一组 tab 是干什么的。页头那一排不需要（激活项就是屏名），页内那排需要。 */
  label?: string;
}) {
  const group = { tabs, current, onSwitch };
  /* 激活的那一个**就是**这一屏的标题，页头不再另外印一遍同样的词。
     但它和旁边几个**同高**：靠填色和字重把它拎出来，不靠字号——
     一行里三种字号会让整条页头看起来是拼出来的。 */
  /*
   * `role="tablist"` / `role="tab"` 而不是三颗各自 `aria-pressed` 的按钮。
   *
   * 差别不是标签好看：`aria-pressed` 读出来是**三个互不相关的开关**，
   * 而这三个是同一个对象的三个镜头，一次只能选一个。屏幕阅读器需要知道
   * 「3 之 1」才说得出人在哪儿，也才会用左右方向键在它们之间走。
   */
  return (
    <div role="tablist" aria-label={label} className={cn("flex flex-none items-center gap-1", className)}>
      {group.tabs.map((x) => (
        <button
          key={x.id}
          type="button"
          role="tab"
          aria-selected={x.id === group.current}
          /* 未激活的 tab 退出 Tab 键序列——一组 tab 在键盘上是**一站**，
             进去之后用方向键走，而不是每个 tab 各占一次 Tab。 */
          tabIndex={x.id === group.current ? 0 : -1}
          onKeyDown={(e) => {
            const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            const i = group.tabs.findIndex((y) => y.id === group.current);
            group.onSwitch(group.tabs[(i + d + group.tabs.length) % group.tabs.length]!.id);
          }}
          onClick={() => group.onSwitch(x.id)}
          className={cn(
            "inline-flex min-h-[1.5625rem] items-center rounded-full border px-[0.625rem] py-[0.1875rem] text-[0.8125rem] leading-[1.35] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            x.id === group.current
              ? "border-primary bg-primary-soft font-semibold text-primary"
              : "border-input bg-card text-muted-foreground hover:border-primary hover:text-primary",
          )}
        >
          {x.label}
        </button>
      ))}
    </div>
  );
}
