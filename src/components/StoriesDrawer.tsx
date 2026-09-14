import { useEffect, useState } from "react";
import { ListTree } from "lucide-react";
import { Drawer } from "@/components/overlay";
import { useT } from "@/lib/prefs";
import { API_BASE } from "@/lib/base";
import { StoryCard } from "@/lib/artifact/StoryCard";
import type { ArtifactStory } from "@/lib/artifact/types";

/**
 * 这次运行拆出来的用户故事。
 *
 * 故事卡此前点开的是「需求追溯」，而追溯读的是**项目里已批准的用例**——两件不同的事：
 * 一次运行刚拆出二十条故事时，项目里通常一条用例都还没有，于是那张卡把人送到一个空表，
 * 或者送到「先选一个项目」。产物属于运行，所以它的阅读器也属于运行。
 *
 * 怎么画由 `src/lib/artifact/StoryCard` 决定，这里只负责取数。
 * 此前这个文件自己声明了一份 `Story` 接口，里面只写了它想画的四个键——于是同一份接口
 * 数据，故事地图上画出了「用户 · 能进入按姓氏检索主人的页面」，这里一个字都没有。
 * 不是拿不到，是本地接口里没写。所以现在类型来自 `artifact/types`，字段全量。
 */
export function StoriesDrawer({ wfRunId, onClose }: { wfRunId: string; onClose: () => void }) {
  const t = useT();
  const [stories, setStories] = useState<ArtifactStory[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!wfRunId) return;
    fetch(`${API_BASE}/api/wf/runs/${wfRunId}/nodes/stories`)
      .then((r) => r.json())
      .then((d: { output?: { stories?: ArtifactStory[] }; error?: string }) => {
        if (d.error || !d.output?.stories) return setError(d.error ?? t("stories.none"));
        setStories(d.output.stories);
      })
      .catch((e) => setError((e as Error).message));
  }, [wfRunId, t]);

  const withoutAc = stories.filter((s) => !s.acceptance?.length).length;
  // 「不是用户故事，是界面事实」的条数。这是这批故事最该被一眼看到的数字——
  // 它说的是「下游用例将建立在多少条说不出为谁而做的东西上」。
  const notStories = stories.filter((s) => !s.role || !s.benefit).length;

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
      /* 物料正文抽屉：整屏打开，收合按钮可切回常规宽度。 */
      fullscreen
      defaultWidth={860}
    >
      {error && <div className="p-4 text-[0.8125rem] text-bad">{error}</div>}

      {stories.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-[0.75rem] text-muted-foreground">
            <span className="font-mono">{wfRunId}</span>
            {withoutAc > 0 && (
              <span className="rounded bg-warn-soft px-1.5 py-0.5 text-warn">
                {t("stories.withoutAc").replace("{n}", String(withoutAc))}
              </span>
            )}
            {notStories > 0 && (
              <span className="rounded bg-warn-soft px-1.5 py-0.5 text-warn">
                {t("stories.notStories", { n: notStories })}
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {stories.map((s) => (
              <StoryCard key={s.id} story={{ ...s, acceptance: s.acceptance ?? [] }} />
            ))}
          </div>
        </>
      )}
    </Drawer>
  );
}
