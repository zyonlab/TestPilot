import { useEffect, useState } from "react";
import { openCard } from "@/lib/open";
import { Button, EmptyState } from "@/components/ui";
import { Link2, Unlink } from "lucide-react";
import { NeedProject } from "@/components/NeedProject";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
import { TopBar } from "@/components/TopBar";
import { API_BASE } from "@/lib/base";
import { cn } from "@/lib/cn";

/**
 * 资产 · 需求追溯。
 *
 * 三个问题，一页答完：这条用例指回哪一句规格；哪些故事一条用例都没有；以及这条断言
 * **凭什么这么写**——它引用的界面文案能不能在喂给那次运行的材料里查到。
 *
 * 最后一项的措辞是这一页最要紧的地方：查不到不等于错。可能是模型编的，也可能是产品
 * 确实这么显示、只是规格没写。两者都该看见，但结论相反——前者改用例，后者补规格。
 * 所以这一列叫「材料里查不到依据」，它给的是"这条断言能不能自证"的下界。
 */

interface Row {
  caseId: string;
  title: string;
  storyId?: string;
  storyTitle?: string;
  acceptance: string[];
  orphan: boolean;
  anchors: Array<{
    text: string;
    grounded: boolean;
    /** 在哪一份里查到的：`material` 是喂进去的材料，`spec` 是整理之后的规格。 */
    where?: "material" | "spec";
  }>;
  unanchored: boolean;
  sourceRunId?: string;
}

interface StoryRow {
  storyId: string;
  title: string;
  cases: number;
  source?: string;
}

interface Report {
  rows: Row[];
  stories: StoryRow[];
  orphans: number;
  uncovered: number;
  ungrounded: number;
  error?: string;
}

/** 一层可展开的故事树：故事 → 用例 → 测试点。 */
function StoryTree({ stories, rows }: { stories: StoryRow[]; rows: Row[] }) {
  const t = useT();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  /*
   * 一条故事都没有时，这块区域不能是空白。
   *
   * 换成树之前它至少还有一行表头，人知道「这里本该有东西」。一片什么都没有的空白
   * 读起来像页面没加载完——而实际情况是「这个项目还没有已批准的故事」，
   * 那是一句话就能说清、而且有下一步的事。
   */
  if (!stories.length)
    return (
      <EmptyState
        className="m-3"
        title={t("trace.noStoriesTitle")}
        body={t("trace.noStoriesWhy")}
        actions={
          <Button variant="primary" onClick={() => openCard("review")}>
            {t("trace.emptyGoReview")}
          </Button>
        }
      />
    );

  return (
    <div role="tree" aria-label={t("trace.ledeStories")}>
      {stories.map((s) => {
        const mine = rows.filter((r) => r.storyId === s.storyId);
        const isOpen = open.has(s.storyId);
        return (
          <div key={s.storyId} role="treeitem" aria-expanded={isOpen}>
            <button
              type="button"
              onClick={() => toggle(s.storyId)}
              /* 0 条用例的故事整行标黄——它是这张表存在的第一个理由。 */
              className={cn(
                "flex w-full items-baseline gap-2 border-b border-border/50 px-4 py-1.5 text-left text-[0.8125rem] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                s.cases === 0 ? "bg-warn-soft hover:bg-warn-soft" : "hover:bg-muted/50",
              )}
            >
              <span className="w-3 flex-none font-mono text-[0.6875rem] text-muted-foreground">
                {mine.length ? (isOpen ? "▾" : "▸") : ""}
              </span>
              <span className="w-[7rem] flex-none truncate font-mono text-[0.75rem]">{s.storyId}</span>
              <span className="min-w-0 flex-1">{s.title}</span>
              <span className="flex-none font-mono tabular-nums">
                {s.cases === 0 ? (
                  <span className="text-warn">{t("trace.noCase")}</span>
                ) : (
                  t("trace.nCases", { n: s.cases })
                )}
              </span>
              <span className="w-[8rem] flex-none truncate text-right font-mono text-[0.6875rem] text-muted-foreground">
                {s.source ?? "—"}
              </span>
            </button>

            {isOpen &&
              mine.map((r) => (
                <div key={r.caseId} role="group" className="border-b border-border/50 bg-muted/20 py-1.5 pl-[2.4rem] pr-4">
                  <div className="flex items-baseline gap-2 text-[0.8125rem]">
                    <span className="w-[7rem] flex-none truncate font-mono text-[0.6875rem] text-muted-foreground">
                      {r.caseId}
                    </span>
                    <span className="min-w-0 flex-1 text-ink2">{r.title}</span>
                    {r.unanchored && (
                      <span
                        className="flex-none rounded bg-warn-soft px-1.5 text-[0.6875rem] text-warn"
                        title={t("trace.ungroundedWhy")}
                      >
                        {t("trace.noLiteral")}
                      </span>
                    )}
                  </div>
                  {/* 第三层：测试点。这是 AC-03.1 那半句话的所指——
                      没有它，「这条故事有 4 条用例」说不出那 4 条测的是不是同一件事。 */}
                  {r.acceptance.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-0.5 pl-[7.5rem]">
                      {r.acceptance.map((a, i) => (
                        <li key={i} className="flex gap-1.5 text-[0.75rem] text-muted-foreground">
                          <span className="flex-none text-faint">·</span>
                          <span className="min-w-0">{a}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}

function Kpi({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="min-w-[5.75rem]">
      <div className="font-mono text-[0.6875rem] uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div className={cn("mt-0.5 font-mono text-[1.0625rem] tabular-nums", warn && "text-warn")}>{value}</div>
    </div>
  );
}

export function TracePage() {
  const t = useT();
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [rep, setRep] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [side, setSide] = useState<"cases" | "stories">("cases");
  /**
   * 只看有问题的那些。
   *
   * 117 条用例里 21 处引文查不到出处——KPI 上是一个数字，表里是二十一处散落在一百多行
   * 中间的黄标。一个只能报出总数、指不到具体哪几条的检查，实际上等于没有报。
   */
  const [only, setOnly] = useState<"all" | "ungrounded" | "unanchored" | "orphan">("all");

  useEffect(() => {
    if (!activeProjectId) return;
    setError("");
    fetch(`${API_BASE}/api/projects/${activeProjectId}/traceability`)
      .then((r) => r.json())
      .then((d: Report) => (d.error ? setError(d.error) : setRep(d)))
      .catch((e) => setError((e as Error).message));
  }, [activeProjectId]);

  /**
   * 空的时候要说清楚**为什么**空。
   *
   * 这一页追的是已经批准进套件的用例；一次运行刚生成的四十条还在复核队列里，
   * 不算数。于是一次有四十条用例的运行，在这里显示 `CASES 0`——
   * 而界面上只有那个 0，人只会得出「坏了」。
   *
   * 「没跑过」和「0 分」要分得开这条规矩，在别处贯彻了，这里漏了。
   * 要分开就得知道队列里有没有东西，所以顺带问一次。
   */
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    fetch(`${API_BASE}/api/review`)
      .then((r) => r.json())
      // 数**批次**，不数用例。用例总数是跨批次相加的，而同一批四十条被重复生成过十几次,
      // 于是那个数会显示成「570 条正等着复核」——一个吓人且没有意义的数。
      .then((d: { runs?: Array<{ pending: number }> }) =>
        setPending((d.runs ?? []).filter((r) => (r.pending ?? 0) > 0).length),
      )
      .catch(() => setPending(null));
  }, []);

  if (!activeProjectId)
    return (
      <>
        <TopBar title={t("surface.trace")} />
        <div className="p-4"><NeedProject /></div>
      </>
    );
  if (error)
    return (
      <>
        <TopBar title={t("surface.trace")} />
        <div className="p-4 text-[0.8125rem] text-bad">{error}</div>
      </>
    );
  if (!rep)
    return (
      <>
        <TopBar title={t("surface.trace")} />
        <div className="p-4 text-sm text-muted-foreground">…</div>
      </>
    );

  const shown = rep.rows.filter((r) =>
    only === "all"
      ? true
      : only === "ungrounded"
        ? r.anchors.some((a) => !a.grounded)
        : only === "unanchored"
          ? r.unanchored
          : r.orphan,
  );
  const counts = {
    all: rep.rows.length,
    ungrounded: rep.rows.filter((r) => r.anchors.some((a) => !a.grounded)).length,
    unanchored: rep.rows.filter((r) => r.unanchored).length,
    orphan: rep.rows.filter((r) => r.orphan).length,
  };

  return (
    <>
      <TopBar title={t("surface.trace")} />
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <div className="flex flex-wrap items-center gap-5 border-b border-border px-4 py-3">
          <Kpi label={t("trace.kpiCases")} value={String(rep.rows.length)} />
          <Kpi label={t("trace.kpiOrphans")} value={String(rep.orphans)} warn={rep.orphans > 0} />
          <Kpi
            label={t("trace.kpiCovered")}
            value={`${rep.stories.length - rep.uncovered} / ${rep.stories.length}`}
            warn={rep.uncovered > 0}
          />
          <Kpi label={t("trace.kpiUngrounded")} value={String(rep.ungrounded)} warn={rep.ungrounded > 0} />
          {side === "cases" && (
            <div className="flex flex-wrap gap-1">
              {(["all", "ungrounded", "unanchored", "orphan"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setOnly(k)}
                  title={k === "all" ? undefined : t(`trace.only.${k}Why`)}
                  className={cn(
                    "cursor-pointer rounded-full border px-2.5 py-0.5 text-[0.75rem]",
                    only === k
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted",
                  )}
                >
                  {t(`trace.only.${k}`)} · {counts[k]}
                </button>
              ))}
            </div>
          )}
          <div className="ml-auto flex gap-1">
            {(["cases", "stories"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setSide(k)}
                className={cn(
                  "cursor-pointer rounded px-2 py-1 text-[0.75rem]",
                  side === k
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {t(`trace.side.${k}`)}
              </button>
            ))}
          </div>
        </div>

        <p className="border-b border-border px-4 py-2 text-[0.8125rem] text-muted-foreground">
          {side === "cases" ? t("trace.ledeCases") : t("trace.ledeStories")}
        </p>

        {rep.rows.length === 0 && (
          <div className="m-4 max-w-2xl space-y-2 rounded-xl border border-dashed border-border p-4 text-[0.8125rem]">
            <div className="font-medium text-foreground">{t("trace.emptyTitle")}</div>
            <p className="leading-relaxed text-muted-foreground">{t("trace.emptyWhy")}</p>
            {pending !== null && pending > 0 ? (
              <p className="text-muted-foreground">
                {t("trace.emptyPending", { n: pending })}{" "}
                <button
                  onClick={() => {
                    const [path] = window.location.hash.split("?");
                    window.location.hash = `${path || "#/"}?open=review`;
                  }}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {t("trace.emptyGoReview")}
                </button>
              </p>
            ) : (
              pending !== null && <p className="text-muted-foreground">{t("trace.emptyNoRuns")}</p>
            )}
          </div>
        )}

        {side === "cases" ? (
          <table className="w-full text-[0.8125rem]">
            <thead className="bg-muted/50 text-left text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-1.5 font-medium">{t("trace.colCase")}</th>
                <th className="px-2 py-1.5 font-medium">{t("trace.colStory")}</th>
                <th className="px-2 py-1.5 font-medium">{t("trace.colAnchor")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.caseId} className="border-b border-border/50 align-top">
                  <td className="px-4 py-1.5">{r.title}</td>
                  <td className="px-2 py-1.5">
                    {r.orphan ? (
                      <span className="flex items-center gap-1 text-warn">
                        <Unlink className="h-3.5 w-3.5" />
                        {r.storyId ? t("trace.storyMissing").replace("{id}", r.storyId) : t("trace.noStory")}
                      </span>
                    ) : (
                      <>
                        <span className="flex items-center gap-1">
                          <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="font-mono text-[0.6875rem]">{r.storyId}</span>
                          <span className="text-muted-foreground">{r.storyTitle}</span>
                        </span>
                        {r.acceptance.slice(0, 2).map((a, i) => (
                          <div key={i} className="pl-4 text-[0.75rem] text-muted-foreground">
                            · {a}
                          </div>
                        ))}
                      </>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {r.unanchored ? (
                      <span className="text-muted-foreground">{t("trace.noLiteral")}</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {r.anchors.map((a) => (
                          <span
                            key={a.text}
                            title={
                              a.grounded
                                ? t(a.where === "spec" ? "trace.inSpecOnlyWhy" : "trace.groundedWhy")
                                : t("trace.ungroundedWhy")
                            }
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[0.6875rem]",
                              !a.grounded
                                ? "bg-warn-soft text-warn"
                                : a.where === "spec"
                                  ? // 只在整理后的规格里查到：不是编造，但材料里确实没有这句话。
                                    "bg-primary-soft text-primary"
                                  : "bg-ok-soft text-ok",
                            )}
                          >
                            {a.grounded ? (a.where === "spec" ? "△ " : "") : "? "}
                            {a.text}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          /*
           * **故事树**，不是一张故事平表（US-03.1 AC：「拆解结果以故事树呈现，
           * 每个故事可展开为测试点」）。
           *
           * 三层，而且每一层回答的问题都不一样：
           *   故事   这条需求有没有被测到（0 条就是没有，整行标黄）
           *   用例   它是被哪几条测到的
           *   测试点 那一条具体验的是什么 —— 也就是「测试点」这个词的所指
           *
           * 之前它是一张平表，只到第一层：能看出「S-03 有 4 条用例」，
           * 看不出那 4 条测的是不是同一件事。而复核时真正要判断的恰恰是后者——
           * 四条用例覆盖同一个测试点，和覆盖四个，在这张表上长得一模一样。
           */
          <StoryTree stories={rep.stories} rows={rep.rows} />
        )}

        <p className="px-4 py-3 text-[0.75rem] leading-relaxed text-muted-foreground">{t("trace.footnote")}</p>
      </div>
    </>
  );
}
