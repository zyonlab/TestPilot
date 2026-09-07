import { createContext, useContext, useEffect, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * A page made of sections instead of a wall of cards.
 *
 * 资产、运行、设置 each hold several unrelated things — a list of executions is not a
 * baseline is not a language preference. Laid out flat they read as one pile, so the left
 * rail names them and only one is on screen at a time.
 *
 * Existing pages are hosted here unchanged. They each render their own `<TopBar>`, which
 * would stack two headers inside a section, so the host publishes a flag and the top bar
 * steps aside — cheaper and far less risky than restructuring twelve files, and the pages
 * keep working standalone.
 */
const InSection = createContext(false);
export const useInSection = (): boolean => useContext(InSection);
/** Host a page inside something that already has a header (a section, or a surface card). */
export const InSectionProvider = ({ children }: { children: React.ReactNode }) => (
  <InSection.Provider value={true}>{children}</InSection.Provider>
);

export interface Section {
  id: string;
  label: string;
  /** Why this section exists, in one line. Shown beside the heading, not as a tooltip. */
  why?: string;
  group?: string;
  /** 自成一类但只有一项：不给组标题，给一条分隔线。 */
  standalone?: boolean;
  /** Hidden sections stay out of the rail — e.g. chain config when the target is not web. */
  hidden?: boolean;
  render: () => React.ReactNode;
}

/**
 * The active section lives in the URL (`#/history?s=baselines`), so"the baselines waiting
 * for review" is a link someone can send.
 */
export function useSectionParam(fallback: string): [string, (id: string) => void] {
  const read = () => new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("s") ?? fallback;
  const [id, setId] = useState(read);
  useEffect(() => {
    const onHash = () => setId(read());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /*
   * 换一个分节只该改 `s`，**不该把地址里其它参数一起扔掉**。
   *
   * 之前这里是把查询串整个重建成 `?s=<next>`，于是 `?open=settings` 跟着没了。
   * 而 `App.tsx` 的 `readOpen()` 在没有 `open` 时回落到复核队列——后果是
   * **点设置里任何一个分节，人被踢回复核队列**，看起来像点一下就掉出了设置。
   *
   * 这是这个应用里第三个写地址的地方，也是第三套「保哪些参数」的规矩：
   * `go()` 保 `run`，`openCard()` 一个不保，这里全清。同一件事三种写法，
   * 其中两种是错的。
   */
  const set = (next: string) => {
    const [path, query] = window.location.hash.split("?");
    const params = new URLSearchParams(query ?? "");
    params.set("s", next);
    window.location.hash = `${path || "#/"}?${params}`;
    setId(next);
  };
  return [id, set];
}

export function SectionPage({
  title,
  subtitle,
  sections,
  fallback,
  compact = false,
}: {
  title: string;
  subtitle: string;
  sections: Section[];
  fallback: string;
  /** Inside a drawer the title is already on the drawer's own header. */
  compact?: boolean;
}) {
  const shown = sections.filter((s) => !s.hidden);
  const [active, setActive] = useSectionParam(fallback);
  const current = shown.find((s) => s.id === active) ?? shown[0];

  let group: string | undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!compact && (
        /* 和 `TopBar` 同一个形状：标题 + 半行说明，一条 46px 的带子。
           此前它是两行——大标题一行、说明一整段——于是被 section 托管的页面
           在同一屏上有两个页头高度不同的头，人会以为进了另一个产品。 */
        <div className="flex min-h-[2.875rem] flex-none items-center gap-x-2.5 border-b border-border px-3 py-2">
          <h2 className="flex-none text-[1.0625rem] font-semibold leading-tight text-foreground">{title}</h2>
          <span className="min-w-0 flex-1 truncate text-[0.75rem] text-muted-foreground" title={subtitle}>
            {subtitle}
          </span>
        </div>
      )}

      <div className="grid min-h-0 flex-1 md:grid-cols-[11rem_minmax(0,1fr)]">
        <nav className="flex flex-col gap-0.5 overflow-auto border-r border-border p-2">
          {shown.map((s) => {
            const head = s.group && s.group !== group ? s.group : null;
            group = s.group;
            return (
              <div key={s.id} className={cn(s.standalone && "mt-2 border-t border-border pt-2")}>
                {head && (
                  <div className="px-2.5 pb-1 pt-2.5 font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground/70">
                    {head}
                  </div>
                )}
                <button
                  onClick={() => setActive(s.id)}
                  className={cn(
                    "w-full cursor-pointer rounded-md px-2.5 py-1.5 text-left text-[0.8125rem] transition-colors",
                    s.id === current?.id
                      ? "bg-accent font-medium text-foreground shadow-[inset_2px_0_0_hsl(var(--primary))]"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  {s.label}
                </button>
              </div>
            );
          })}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-col">
          {current?.why && (
            <div className="border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
              {current.why}
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col">
            <InSection.Provider value={true}>{current?.render()}</InSection.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}
