import { ExplorationSettings } from '@/components/ExplorationSettings';
import { useState } from "react";
import { Globe, ListChecks, Plus, ChevronRight, Rocket, Loader2, Blocks, Trash2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { closeCard, openCard } from "@/lib/open";
import { api } from "@/lib/api";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { cn } from "@/lib/cn";
import type { TargetPlatform } from "@/lib/types";

export function ProjectsPage() {
  const t = useT();
  const projects = useStore((s) => s.projects);
  const overviews = useStore((s) => s.overviews);
  const activeId = useStore((s) => s.activeProjectId);
  const selectProject = useStore((s) => s.selectProject);
  const loadData = useStore((s) => s.loadData);
  const backendUp = useStore((s) => s.backendUp);
  const updateProject = useStore((s) => s.updateProject);

  const activeProject = projects.find((p) => p.id === activeId);
  // 表单本身住在 `NewProjectDialog` 里——这一页和工作台用的是同一张表，
  // 而不是两份会各自漂移的副本。这里保留的是**管理已有项目**：列表、平台、删除。
  const [adding, setAdding] = useState(false);
  const [exBusy, setExBusy] = useState(false);

  const exitProject = useStore((s) => s.exitProject);
  const [delId, setDelId] = useState<string | null>(null);
  const open = async (id: string) => {
    await selectProject(id);
    // 落在工作台而不是看板：进入一个项目之后要做的事是跑流水线，而一个刚建的项目
    // 看板必然是空的——用一个空表回答「我现在该干什么」是最没用的回答。
    closeCard();
  };
  const remove = async (id: string) => {
    setDelId(id);
    try {
      await api.deleteProject(id);
      if (id === activeId) exitProject();
      await loadData();
    } catch {
      /* backend offline */
    }
    setDelId(null);
  };
  // One-click Uniswap dapp example: create (or reuse) the sample project + cases, then open it.
  const tryDappExample = async () => {
    setExBusy(true);
    try {
      const { project } = await api.loadUniswapExample();
      await loadData();
      await selectProject(project.id);
      openCard("cases"); // 示例项目自带用例，看板是有内容的
    } catch {
      /* backend offline */
    }
    setExBusy(false);
  };

  return (
    <>
      {/* 建项目不再是这一页的一段内联表单：同一张表也从工作台的项目下拉打开，
          两处必须是同一份实现，否则迟早只有一边加上新字段。 */}
      <NewProjectDialog open={adding} onClose={() => setAdding(false)} onCreated={() => closeCard()} />
      <TopBar
        title={t("projects.title")}
        hint={`${t("projects.subtitle")}${!backendUp ? ` ${t("projects.backendOfflineLocal")}` : ""}`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={tryDappExample} disabled={exBusy || !backendUp}>
              {exBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Blocks className="h-3.5 w-3.5 text-chat" />
              )}
              {t("projects.tryDappExample")}
            </Button>
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" />
              {t("projects.newProject")}
            </Button>
          </div>
        }
      />
      <div className="flex-1 overflow-auto p-4">
        {/* The end this project runs on. It is here rather than in the create form alone
            because it is a decision people revise: a team starts on web and adds a native
            build later, and re-creating the project would take the whole board with it. */}
        {activeProject && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
            <span className="text-sm font-medium">{activeProject.name}</span>
            <label htmlFor="activeplat" className="ml-2 text-xs text-muted-foreground">
              {t("projects.platform")}
            </label>
            <select
              id="activeplat"
              value={activeProject.targetPlatform ?? "web"}
              onChange={(e) =>
                void updateProject(activeProject.id, { targetPlatform: e.target.value as TargetPlatform })
              }
              className="rounded-md border border-border bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="web">Web</option>
              <option value="ios">iOS</option>
              <option value="android">Android</option>
            </select>
            <div className="w-full"><ExplorationSettings maxScreens={activeProject.explorationMaxScreens??8} scope={activeProject.explorationScope??"rules"} onChange={(n,s)=>void updateProject(activeProject.id,{explorationMaxScreens:n,explorationScope:s})}/></div>
            <span className="text-[0.6875rem] text-muted-foreground">
              {(activeProject.targetPlatform ?? "web") === "web"
                ? t("projects.platformWebHint")
                : t("projects.platformNativeHint")}
            </span>
          </div>
        )}

        {projects.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            <span>{t("projects.empty")}</span>
            <Button variant="primary" onClick={() => setAdding(true)} className="text-xs">
              <Plus className="h-3.5 w-3.5" />
              {t("projects.newProject")}
            </Button>
            <Button
              variant="outline"
              onClick={tryDappExample}
              disabled={exBusy || !backendUp}
              className="text-xs"
            >
              {exBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Rocket className="h-3.5 w-3.5 text-chat" />
              )}
              {t("projects.tryDappExample")}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {projects.map((p) => (
              <div key={p.id} className="group relative">
                <button
                  onClick={() => void open(p.id)}
                  className="w-full cursor-pointer rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/30"
                >
                  <div className="mb-3 flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted">
                      <Globe className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{p.name}</div>
                      <div className="truncate font-mono text-[0.6875rem] text-muted-foreground">
                        {p.targetUrl.replace(/^https?:\/\//, "")}
                      </div>
                    </div>
                    <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
                      {t("nav.enter")}
                      <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </div>
                  {/* 事实，不是第二个按钮。整张卡就是一个按钮，点哪儿都是进入工作台——
                    这一行以前写着「打开测试用例」，一个说得像按钮却不是按钮的东西，
                    读的人要试一次才知道。

                    两套账各说各的：**已批准**是「我们的套件」，**待复核**是「等着被看的
                    东西」。此前这里只数前者，于是一个有 68 次运行、40 条待复核用例的项目
                    在卡片上写着「还没有用例」——那句话字面上没错，但它让人以为这里什么
                    都没发生。合成一个数不是修法，那只会把同一句谎话说得更圆滑。 */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <ListChecks className="h-3.5 w-3.5" />
                      {overviews[p.id]
                        ? t("projects.approvedN", { n: overviews[p.id]!.approved.cases })
                        : p.cases === undefined
                          ? "—"
                          : p.cases === 0
                            ? t("projects.noCasesYet")
                            : t("projects.caseCount").replace("{n}", String(p.cases))}
                    </span>
                    {!!overviews[p.id]?.candidates.cases && (
                      <span
                        title={t("projects.candidatesWhy")}
                        className="rounded bg-warn-soft px-1.5 py-0.5 text-[0.6875rem] text-warn"
                      >
                        {t("projects.candidatesN", {
                          n: overviews[p.id]!.candidates.cases,
                          runs: overviews[p.id]!.candidates.runsWithCases,
                        })}
                      </span>
                    )}
                    {/* 规格从哪来，决定这套用例能说明什么——这件事该在卡片上，不该藏在设置里。 */}
                    <span
                      title={p.materials?.length ? t("projects.fromDocsWhy") : t("projects.fromExploreWhy")}
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[0.6875rem]",
                        p.materials?.length ? "bg-ok-soft text-ok" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {p.materials?.length
                        ? t("projects.fromDocs", { n: p.materials.length })
                        : t("projects.fromExplore")}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] uppercase">
                      {p.targetPlatform ?? "web"}
                    </span>
                    {p.id === activeId && (
                      <span className="ml-auto rounded-md bg-ok-soft px-1.5 py-0.5 text-[0.6875rem] font-medium text-ok">
                        {t("projects.active")}
                      </span>
                    )}
                  </div>
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(t("projects.deleteConfirm").replace("{name}", p.name)))
                      void remove(p.id);
                  }}
                  disabled={delId === p.id}
                  aria-label="Delete project"
                  title={t("common.delete")}
                  className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-bad-soft hover:text-bad focus:opacity-100 group-hover:opacity-100"
                >
                  {delId === p.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
