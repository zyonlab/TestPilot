import { useEffect, useMemo, useRef, useState } from "react";
import { NAV } from "@/lib/nav";
import { useT } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { useWf } from "@/lib/wf";
import { cn } from "@/lib/cn";

/**
 * ⌘K：说一句话，落到该去的那个**对象**上。
 *
 * 它返回的是**落点**，不是答案，也不是动作——这是与 chat 的分界。
 * 一个能直接执行动作的命令面板，会让「跑什么、什么时候跑」变成一次模糊匹配的结果；
 * 而这个产品里那些动作（起跑、批准、导出）都要人看清楚了再点。
 *
 * 也不是「标题搜索」：那种搜索答不了「昨天那次被 codegate 拦下的」这类
 * **按对象、按时间、按发生过的事**提问。所以候选里除了落点，还有最近的运行与项目——
 * 它们是这个产品里真正的对象。
 *
 * 这一版是确定性匹配，不问模型。模型版本要等到它能读到事实之后再说（见 P4）。
 */
export function CommandPalette({ onGo }: { onGo: (open: string, extra?: Record<string, string>) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const projects = useStore((s) => s.projects);
  const selectProject = useStore((s) => s.selectProject);
  const runs = useWf((s) => s.runs);

  useEffect(() => {
    const show = () => {
      setOpen((v) => !v);
      setQ("");
      setI(0);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        show();
      } else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    /*
     * 左导航第一格那个写着 `Go to…` 的东西**长得就是一个搜索输入框**——有边框、
     * 有浅底、有占位文字、右边还挂着一枚 ⌘K 键帽。而它此前是个 `<div>`，
     * `tabIndex` 为 null：点它没反应，Tab 也走不到它上面。
     *
     * 一个第一次用这个产品的人，进来看到的第二个东西就是它。他会点、会往里打字，
     * 然后什么都不会发生。
     *
     * 现在它是一颗真按钮，广播这个事件把面板叫起来——和键盘走同一条路，
     * 不另开一份状态。
     */
    window.addEventListener("tp:cmdk", show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("tp:cmdk", show);
    };
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  type Item = { key: string; label: string; hint: string; run: () => void };
  /** 时间戳读不出来时**不要显示一个假的**：`new Date(undefined)` 会给出 Invalid Date。 */
  const fmt = (s: string): string => {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
  };
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const g of NAV)
      for (const it of g.items)
        out.push({
          key: `nav:${it.id}`,
          label: t(it.title),
          hint: t(g.title),
          run: () => onGo(it.id),
        });
    /**
     * 最近的运行也是落点。
     *
     * 「昨天那次被 codegate 拦下的」——人记得的是**发生过的事**，不是一个界面的名字。
     * 所以候选里要有对象，否则这就只是一个换了皮的菜单。
     */
    /**
     * **按时间倒序取最近的**，不是取数组前 12 条。
     *
     * 第一版直接 `runs.slice(0, 12)`，而那是「库里排在前面的 12 条」——
     * 实测 50 次运行里，今晚刚跑的那几次一条都进不了候选，搜 `g0` 零命中。
     * 一个搜不到你刚跑那次的「转到」，人试一次就不会再用它。
     */
    const recent = [...runs]
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, 12);
    for (const r of recent)
      out.push({
        key: `run:${r.id}`,
        // 带上 id 的尾巴：同一张图同一分钟可能有好几次，光看图名和时间分不出来。
        label: `${r.graphId} · ${fmt(r.startedAt)} · ${r.id.slice(-6)}`,
        hint: `${t("nav.runs")} · ${r.status}`,
        run: () => onGo("canvas", { run: r.id }),
      });
    for (const p of projects)
      out.push({
        key: `proj:${p.id}`,
        label: p.name,
        hint: t("nav.projects"),
        run: () => {
          void selectProject(p.id);
          setOpen(false);
        },
      });
    return out;
  }, [t, runs, projects, onGo, selectProject]);

  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    /*
     * 没打字时**先给对象，再给落点**。
     *
     * 之前是 `items.slice(0, 12)`，而 `items` 是「导航项在前、运行在后」拼起来的——
     * 11 个导航项把 12 条候选占满，最近的运行只露得出 1 条。而导航项在左边一直看得见，
     * 真正只能靠这里找的是运行：「昨晚被 codegate 拦下的那次」不在任何一个菜单里。
     */
    if (!s) {
      const runsFirst = items.filter((x) => x.key.startsWith("run:")).slice(0, 6);
      const rest = items.filter((x) => !x.key.startsWith("run:"));
      return [...runsFirst, ...rest].slice(0, 12);
    }
    return items.filter((x) => `${x.label} ${x.hint}`.toLowerCase().includes(s)).slice(0, 12);
  }, [q, items]);

  if (!open) return null;
  const pick = (n: number) => {
    const it = hits[n];
    if (!it) return;
    it.run();
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/30 p-6 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-[32.5rem] overflow-hidden rounded-xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          placeholder={t("cmdk.placeholder")}
          onChange={(e) => {
            setQ(e.target.value);
            setI(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setI((n) => Math.min(hits.length - 1, n + 1));
            else if (e.key === "ArrowUp") setI((n) => Math.max(0, n - 1));
            else if (e.key === "Enter") pick(i);
          }}
          className="w-full border-b border-border bg-transparent px-4 py-3 text-[0.875rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
        <div className="max-h-[46vh] overflow-y-auto py-1">
          {hits.length === 0 && (
            <p className="px-4 py-3 text-[0.8125rem] text-muted-foreground">{t("cmdk.none")}</p>
          )}
          {hits.map((x, n) => (
            <button
              key={x.key}
              type="button"
              onMouseEnter={() => setI(n)}
              onClick={() => pick(n)}
              className={cn(
                "flex w-full items-baseline gap-3 px-4 py-2 text-left text-[0.8125rem]",
                n === i ? "bg-accent" : "hover:bg-accent/50",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{x.label}</span>
              <span className="flex-none font-mono text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                {x.hint}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
