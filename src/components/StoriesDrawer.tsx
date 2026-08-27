import { useEffect, useState } from "react";
import { ListTree } from "lucide-react";
import { Drawer } from "@/components/overlay";
import { useT } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import { API_BASE } from "@/lib/base";

/**
 * 这次运行拆出来的用户故事。
 *
 * 故事卡此前点开的是「需求追溯」，而追溯读的是**项目里已批准的用例**——两件不同的事：
 * 一次运行刚拆出二十条故事时，项目里通常一条用例都还没有，于是那张卡把人送到一个空表，
 * 或者送到「先选一个项目」。产物属于运行，所以它的阅读器也属于运行。
 *
 * 每条故事显示它的验收标准：这是下游用例的直接来源，也是「这条用例凭什么这么写」
 * 唯一能对上的东西。
 */
interface Story {
  id: string;
  title: string;
  acceptance?: string[];
  source?: string;
  /**
   * 出处是怎么来的。`located` 是拿验收标准回规格里定位出来的；`claimed` 是模型说的。
   * 显示成同一个文件名就等于宣称它们一样可信，而它们不是。
   */
  sourceBy?: "located" | "claimed";
  requirementId?: string;
}

export function StoriesDrawer({ wfRunId, onClose }: { wfRunId: string; onClose: () => void }) {
  const t = useT();
  const [stories, setStories] = useState<Story[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!wfRunId) return;
    fetch(`${API_BASE}/api/wf/runs/${wfRunId}/nodes/stories`)
      .then((r) => r.json())
      .then((d: { output?: { stories?: Story[] }; error?: string }) => {
        if (d.error || !d.output?.stories) return setError(d.error ?? t("stories.none"));
        setStories(d.output.stories);
      })
      .catch((e) => setError((e as Error).message));
  }, [wfRunId, t]);

  const withoutAc = stories.filter((s) => !s.acceptance?.length).length;

  return (
    <Drawer
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-1.5">
          <ListTree className="h-4 w-4 text-primary" />
          {t("stories.title")} · {stories.length || "—"}
        </span>
      }
      resizeKey="stories"
      defaultWidth={820}
    >
      {error && <div className="p-4 text-[12.5px] text-rose-500">{error}</div>}

      {stories.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-[11.5px] text-muted-foreground">
            <span className="font-mono">{wfRunId}</span>
            {withoutAc > 0 && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-400">
                {t("stories.withoutAc").replace("{n}", String(withoutAc))}
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {stories.map((s) => (
              <div key={s.id} className="border-b border-border/60 px-4 py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[11.5px] text-primary">{s.id}</span>
                  <span className="text-[13px] font-medium">{s.title}</span>
                  {s.source ? (
                    <span
                      title={t(`stories.sourceBy.${s.sourceBy ?? "claimed"}`)}
                      className={cn(
                        "ml-auto shrink-0 truncate font-mono text-[10.5px]",
                        s.sourceBy === "located"
                          ? "text-muted-foreground"
                          : "text-amber-600 dark:text-amber-400",
                      )}
                    >
                      {s.sourceBy === "located" ? "" : "? "}
                      {s.source.split("/").pop()}
                    </span>
                  ) : (
                    // 说出来，而不是留白：一条不知道出自哪份材料的故事，覆盖率里算不进任何一份。
                    <span
                      title={t("stories.sourceBy.none")}
                      className="ml-auto shrink-0 text-[10.5px] text-muted-foreground"
                    >
                      {t("stories.noSource")}
                    </span>
                  )}
                </div>
                {s.acceptance?.length ? (
                  <ul className="mt-1 space-y-0.5 pl-4">
                    {s.acceptance.map((a, i) => (
                      <li key={i} className="list-disc text-[12.5px] text-muted-foreground">
                        {a}
                      </li>
                    ))}
                  </ul>
                ) : (
                  // Said plainly rather than left blank: a story with no acceptance criteria
                  // gives the case designer nothing to write an assertion against.
                  <div className="mt-1 text-[12px] text-amber-600 dark:text-amber-400">{t("stories.noAc")}</div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </Drawer>
  );
}
