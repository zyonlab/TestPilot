import { useState } from "react";
import { Globe, ListChecks, Plus, ChevronRight, Rocket, Loader2, Blocks, Trash2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui";
import { useT } from "@/lib/prefs";
import { closeCard, openCard } from "@/lib/open";
import { api } from "@/lib/api";
import type { TargetPlatform } from "@/lib/types";

export function ProjectsPage() {
  const t = useT();
  const projects = useStore((s) => s.projects);
  const activeId = useStore((s) => s.activeProjectId);
  const selectProject = useStore((s) => s.selectProject);
  const createProject = useStore((s) => s.createProject);
  const loadData = useStore((s) => s.loadData);
  const backendUp = useStore((s) => s.backendUp);
  const updateProject = useStore((s) => s.updateProject);

  const activeProject = projects.find((p) => p.id === activeId);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://");
  const [platform, setPlatform] = useState<TargetPlatform>("web");
  const [busy, setBusy] = useState(false);
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
      openCard("cases");  // 示例项目自带用例，看板是有内容的
    } catch {
      /* backend offline */
    }
    setExBusy(false);
  };
  const submit = async () => {
    if (!name.trim() || !/^https?:\/\/.+/.test(url)) return;
    setBusy(true);
    await createProject(name.trim(), url.trim(), platform);
    setBusy(false);
    setAdding(false);
    setName("");
    setUrl("https://");
    closeCard();
  };

  return (
    <>
      <TopBar
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={tryDappExample} disabled={exBusy || !backendUp}>
              {exBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Blocks className="h-3.5 w-3.5 text-violet-500" />
              )}
              {t("projects.tryDappExample")}
            </Button>
            <Button variant="primary" onClick={() => setAdding((a) => !a)}>
              <Plus className="h-3.5 w-3.5" />
              {t("projects.newProject")}
            </Button>
          </div>
        }
      />
      <div className="flex-1 overflow-auto p-4">
        <h1 className="mb-1 font-display text-lg font-medium">{t("projects.title")}</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("projects.subtitle")}
          {!backendUp && ` ${t("projects.backendOfflineLocal")}`}
        </p>

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
              onChange={(e) => void updateProject(activeProject.id, { targetPlatform: e.target.value as TargetPlatform })}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="web">Web</option>
              <option value="ios">iOS</option>
              <option value="android">Android</option>
            </select>
            <span className="text-[11px] text-muted-foreground">
              {(activeProject.targetPlatform ?? "web") === "web"
                ? t("projects.platformWebHint")
                : t("projects.platformNativeHint")}
            </span>
          </div>
        )}

        {adding && (
          <div className="mb-4 rounded-xl border border-border bg-card p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label htmlFor="pname" className="mb-1 block text-xs text-muted-foreground">
                  {t("projects.name")}
                </label>
                <input
                  id="pname"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My web app"
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label htmlFor="purl" className="mb-1 block text-xs text-muted-foreground">
                  {t("projects.targetUrl")}
                </label>
                <input
                  id="purl"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label htmlFor="pplat" className="mb-1 block text-xs text-muted-foreground">
                  {t("projects.platform")}
                </label>
                <select
                  id="pplat"
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value as TargetPlatform)}
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="web">Web</option>
                  <option value="ios">iOS</option>
                  <option value="android">Android</option>
                </select>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {platform === "web" ? t("projects.platformWebHint") : t("projects.platformNativeHint")}
                </p>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant="primary" onClick={submit} disabled={busy}>
                {t("projects.createProject")}
              </Button>
              <Button variant="outline" onClick={() => setAdding(false)}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}

        {projects.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            <span>{t("projects.empty")}</span>
            <Button
              variant="outline"
              onClick={tryDappExample}
              disabled={exBusy || !backendUp}
              className="text-xs"
            >
              {exBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Rocket className="h-3.5 w-3.5 text-violet-500" />
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
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
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
                    读的人要试一次才知道。条数正好是决定要不要进来时最想先知道的事。 */}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ListChecks className="h-3.5 w-3.5" />
                  {p.cases === undefined
                    ? "—"
                    : p.cases === 0
                      ? t("projects.noCasesYet")
                      : t("projects.caseCount").replace("{n}", String(p.cases))}
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase">
                    {p.targetPlatform ?? "web"}
                  </span>
                  {p.id === activeId && (
                    <span className="ml-auto rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
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
                  className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-red-50 hover:text-red-500 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-red-950"
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
