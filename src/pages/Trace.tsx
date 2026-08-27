import { useEffect, useState } from "react";
import { Link2, Unlink } from "lucide-react";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";
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

function Kpi({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="min-w-[92px]">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div className={cn("mt-0.5 font-mono text-[15px] tabular-nums", warn && "text-amber-600 dark:text-amber-400")}>
        {value}
      </div>
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

  if (!activeProjectId) return <div className="p-4 text-sm text-muted-foreground">{t("assets.pickProject")}</div>;
  if (error) return <div className="p-4 text-[12.5px] text-rose-500">{error}</div>;
  if (!rep) return <div className="p-4 text-sm text-muted-foreground">…</div>;

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
                  "cursor-pointer rounded-full border px-2.5 py-0.5 text-[11.5px]",
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
                "cursor-pointer rounded px-2 py-1 text-[12px]",
                side === k ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {t(`trace.side.${k}`)}
            </button>
          ))}
        </div>
      </div>

      <p className="border-b border-border px-4 py-2 text-[12.5px] text-muted-foreground">
        {side === "cases" ? t("trace.ledeCases") : t("trace.ledeStories")}
      </p>

      {side === "cases" ? (
        <table className="w-full text-[12.5px]">
          <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
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
                    <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <Unlink className="h-3.5 w-3.5" />
                      {r.storyId ? t("trace.storyMissing").replace("{id}", r.storyId) : t("trace.noStory")}
                    </span>
                  ) : (
                    <>
                      <span className="flex items-center gap-1">
                        <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-mono text-[11px]">{r.storyId}</span>
                        <span className="text-muted-foreground">{r.storyTitle}</span>
                      </span>
                      {r.acceptance.slice(0, 2).map((a, i) => (
                        <div key={i} className="pl-4 text-[11.5px] text-muted-foreground">
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
                            "rounded px-1.5 py-0.5 text-[10.5px]",
                            !a.grounded
                              ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                              : a.where === "spec"
                                ? // 只在整理后的规格里查到：不是编造，但材料里确实没有这句话。
                                  "bg-sky-500/15 text-sky-700 dark:text-sky-400"
                                : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
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
        <table className="w-full text-[12.5px]">
          <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-1.5 font-medium">{t("trace.colStoryId")}</th>
              <th className="px-2 py-1.5 font-medium">{t("trace.colStoryTitle")}</th>
              <th className="px-2 py-1.5 font-medium">{t("trace.colCases")}</th>
              <th className="px-2 py-1.5 font-medium">{t("trace.colSource")}</th>
            </tr>
          </thead>
          <tbody>
            {rep.stories.map((s) => (
              <tr key={s.storyId} className={cn("border-b border-border/50", s.cases === 0 && "bg-amber-500/5")}>
                <td className="px-4 py-1.5 font-mono text-[11.5px]">{s.storyId}</td>
                <td className="px-2 py-1.5">{s.title}</td>
                <td className="px-2 py-1.5 font-mono tabular-nums">
                  {s.cases === 0 ? (
                    <span className="text-amber-600 dark:text-amber-400">0</span>
                  ) : (
                    s.cases
                  )}
                </td>
                <td className="px-2 py-1.5 font-mono text-[10.5px] text-muted-foreground">{s.source ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">{t("trace.footnote")}</p>
    </div>
  );
}
