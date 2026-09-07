import { useEffect, useRef, useState } from "react";
import { Plus, Check } from "lucide-react";
import { NAV } from "@/lib/nav";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { AppControls } from "@/components/AppControls";
import { useT } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/cn";

/**
 * 导航底部那一行：**当前项目 + 切换 + 新建**。
 *
 * 它此前是一个死的 `<div>`，只把项目名印出来。后果是：项目是贯穿全应用的上下文，
 * 而界面上**既切不了也建不了**——切换只剩 ⌘K 那条看不见的路，新建要走
 * 「接入 → 去配置 → 设置 → 项目 → 新建项目」五步跨三屏。
 *
 * 放在这里而不是在品牌栏旁边加个 `+`：一个 `+` 只解决新建，而缺的是两件事。
 * 项目名本来就常驻在这一行，让它自己可点，一个控件把两件都办了。
 */
function ProjectSwitcher() {
  const t = useT();
  const projects = useStore((s) => s.projects);
  const activeId = useStore((s) => s.activeProjectId);
  const selectProject = useStore((s) => s.selectProject);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  /* 点外面、按 Esc 都要收起来。一个只能靠再点一次它自己才关得掉的浮层，
     人会以为它卡住了。 */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = projects.find((p) => p.id === activeId);

  return (
    <div ref={box} className="relative mt-auto border-t border-border">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("nav.switchProject")}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[0.75rem] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <span className="min-w-0 flex-1 truncate">
          {active ? active.name : t("common.noProjectSelected")}
        </span>
        <span className="flex-none opacity-60">{open ? "▾" : "▴"}</span>
      </button>

      {open && (
        /* 往上弹：它在窗口最底下，往下弹会掉出视口。 */
        <div className="absolute bottom-full left-2 right-2 z-30 mb-1 overflow-hidden rounded-lg border border-input bg-card shadow-panel">
          <div className="max-h-[40vh] overflow-auto">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  void selectProject(p.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-1.5 px-2.5 py-[0.3125rem] text-left text-[0.75rem]",
                  p.id === activeId ? "bg-primary-soft text-primary" : "hover:bg-accent",
                )}
              >
                <Check className={cn("h-3 w-3 flex-none", p.id === activeId ? "opacity-100" : "opacity-0")} />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
              </button>
            ))}
            {projects.length === 0 && (
              <div className="px-2.5 py-2 text-[0.75rem] text-muted-foreground">{t("nav.noProjectYet")}</div>
            )}
          </div>
          {/* 新建就长在列表末尾——「换一个」和「再来一个」是同一个问题的两个答案。 */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setAdding(true);
            }}
            className="flex w-full items-center gap-1.5 border-t border-border px-2.5 py-[0.3125rem] text-left text-[0.75rem] text-primary hover:bg-accent"
          >
            <Plus className="h-3 w-3 flex-none" />
            {t("projects.newProject")}
          </button>
        </div>
      )}

      <NewProjectDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(id) => {
          setAdding(false);
          void selectProject(id);
        }}
      />
    </div>
  );
}

/**
 * 左导航。
 *
 * 它只做一件事：把 `?open=` 换成另一个值。**地址机制没有变**，
 * 所以 `#/?open=review&run=wf-xxx` 这样的旧链接照样能打开，
 * 只是现在它渲染成一屏而不是盖在画布上的一张浮层。
 */
export function AppNav({
  current,
  onGo,
  reviewCount,
}: {
  current: string;
  onGo: (id: string) => void;
  reviewCount?: number;
}) {
  const t = useT();
  const projects = useStore((s) => s.projects);
  const activeId = useStore((s) => s.activeProjectId);
  const hasProject = !!activeId && projects.some((p) => p.id === activeId);

  return (
    <nav className="flex h-full w-[11.25rem] flex-none flex-col overflow-y-auto border-r border-border bg-card">
      <div className="flex items-center gap-2 px-3 py-3 text-[0.8125rem] font-semibold">
        <span className="inline-block h-3.5 w-3.5 rounded-[3px] bg-primary" />
        TestPilot
      </div>
      {/* ⌘K 放在导航第一项——Langfuse 就是这么放的，理由很实在：它是最快的那条路，
          而人只有看得见它才会去用。 */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent("tp:cmdk"))}
        className="mx-2 mb-2 flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-left text-[0.75rem] text-muted-foreground transition-colors hover:border-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("cmdk.placeholder")}
        <kbd className="ml-auto rounded border border-border px-1 font-mono text-[0.6875rem]">⌘K</kbd>
      </button>
      {NAV.map((g) => (
        <div key={g.title} className="mb-1">
          <div className="px-3 pb-1 pt-2 font-mono text-[0.6875rem] uppercase tracking-[0.09em] text-muted-foreground">
            {t(g.title)}
          </div>
          {g.items.map((it) => {
            /**
             * 需要项目的落点在没选项目时**置灰但不隐藏**。
             *
             * 藏起来会让人以为这个产品没有这个功能——而它只是还差一个前提。
             * 一份说不出「还缺什么」的界面，人只能靠猜。
             */
            const blocked = !!it.needsProject && !hasProject;
            return (
              <button
                key={it.id || "canvas"}
                type="button"
                aria-current={current === it.id ? "true" : "false"}
                disabled={blocked}
                title={blocked ? t("common.noProjectSelected") : undefined}
                onClick={() => onGo(it.id)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[0.8125rem] transition-colors",
                  blocked
                    ? "cursor-not-allowed text-muted-foreground/40"
                    : current === it.id
                      ? "bg-accent font-medium text-foreground shadow-[inset_2px_0_0_hsl(var(--primary))]"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <span className="w-3.5 flex-none text-center opacity-70">{it.glyph}</span>
                <span className="min-w-0 flex-1 truncate">{t(it.title)}</span>
                {it.id === "review" && !!reviewCount && (
                  <span className="rounded bg-primary/10 px-1.5 py-px font-mono text-[0.6875rem] text-primary">
                    {reviewCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
      {/*
       * 语言与主题常驻在这里，而不是只藏在「设置 → 语言与调试」里。
       *
       * 换语言是**每个新环境要做一次**的事——一个装到新机器上的人，第一件事往往是
       * 把界面切回自己读得动的语言。让它走「配置 → 设置 → 语言与调试」三跳，
       * 等于让一个还读不懂界面的人先读懂三层导航。
       */}
      <div className="mt-auto flex-none border-t border-border px-2 py-2">
        <AppControls />
      </div>
      <ProjectSwitcher />
    </nav>
  );
}
