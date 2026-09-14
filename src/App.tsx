import { useEffect, useState } from "react";
import { safeGet, safeSet } from "@/lib/local";
import { WorkflowBench } from "@/pages/WorkflowBench";
import { projectHref, readProjectContext } from "@/lib/projectContext";
import { ProjectLoadNotice } from "@/components/ProjectLoadNotice";
import { AppNav } from "@/components/AppNav";
import { CommandPalette } from "@/components/CommandPalette";
import { Shortcuts } from "@/components/Shortcuts";
import { surfaceById, surfacesInGroup } from "@/lib/surfaces";
import { SurfaceTabsProvider } from "@/lib/surfaceTabs";
import { navIdFor, navItemFor } from "@/lib/nav";
import { useT } from "@/lib/prefs";
import { useStore } from "@/lib/store";

const LEGACY: Record<string, string> = {
  "/cases": "cases",
  "/review": "review",
  "/trace": "trace",
  "/code": "code",
  "/changes": "changes",
  "/deliver": "deliver",
  "/runs": "runs",
  "/suite": "batches",
  "/batches": "batches",
  "/baselines": "baselines",
  "/trends": "trends",
  "/evals": "evals",
  "/assets": "cases",
  "/history": "runs",
};

function normalise(): void {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [path, query] = raw.split("?");
  const params = new URLSearchParams(query ?? "");
  if (params.get("open")) return;

  const deep = /^\/review\/((?:wf-|run-)[A-Za-z0-9_-]+)$/.exec(path ?? "");
  if (deep) {
    params.set("open","review"); params.set("run",deep[1]); window.location.hash = `#/?${params}`;
    return;
  }

  const section = params.get("s");
  const card = (section && LEGACY[`/${section}`]) || LEGACY[path];
  // 设置 is a drawer rather than a card, and the workspace itself is the address.
  if (
    path === "/settings" ||
    path === "/projects" ||
    path === "/model" ||
    path === "/chain" ||
    path === "/processes" ||
    path === "/capabilities"
  ) {
    params.set("open","settings"); params.set("s",path === "/model" ? "models" : path === "/chain" ? "chain" : "projects"); window.location.hash = `#/?${params}`;
    return;
  }
  if (card) {params.set("open",card); window.location.hash = `#/?${params}`;}
  else if (path !== "/" && path !== "/workspace" && path !== "/canvas") window.location.hash = "#/";
  else if (path !== "/") window.location.hash = query ? `#/?${query}` : "#/";
}

export function App() {
  const [, force] = useState(0);
  useEffect(() => {
    normalise();
    const onHash = () => {
      normalise();
      force((n) => n + 1);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return <AppShell />;
}

function AppShell() {
  const t = useT();
  const [open, setOpen] = useState(readOpen);
  useEffect(() => {
    const onHash = () => setOpen(readOpen());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const loadData = useStore((s) => s.loadData);
  const selectProject = useStore((s) => s.selectProject);
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const requested = readProjectContext().projectId;
    if (requested) {
      if (projects.some(p => p.id === requested) && activeProjectId !== requested) void selectProject(requested);
      return;
    }
    if (activeProjectId || !projects.length) return;
    const remembered = safeGet(LAST_PROJECT);
    const want = projects.find((p) => p.id === remembered) ?? projects[0];
    if (want) void selectProject(want.id);
  }, [projects, activeProjectId, selectProject, location.hash]);

  useEffect(() => {
    if (activeProjectId) safeSet(LAST_PROJECT, activeProjectId);
  }, [activeProjectId]);

  const go = (id: string, extra?: Record<string, string>) => {
    const href = projectHref(id, {projectId: activeProjectId ?? ''});
    const p = new URLSearchParams(href.split('?')[1]);
    for (const [k,v] of Object.entries(extra ?? {})) p.set(k,v);
    window.location.hash = '#/?' + p;
    setOpen(id);
  };

  const requestedProject=readProjectContext().projectId;
  const contextPending=!!requestedProject&&requestedProject!==activeProjectId;
  const surface = open && open !== CANVAS && open !== "wfruns" ? surfaceById(open) : undefined;
  return (
    <div className="flex h-screen w-full overflow-hidden">
      <AppNav current={navIdFor(open)} onGo={go} />
      <CommandPalette onGo={go} />
      <Shortcuts />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <ProjectLoadNotice />
        
        {contextPending ? <div role="status" className="p-6 text-sm">{projects.some(p=>p.id===requestedProject)?t("workflow.loading"):t("workflow.runMissing")}</div> : surface ? <SurfaceScreen id={surface.id} title={t(surface.title)} onGo={go} /> : <WorkflowBench />}
      </div>
    </div>
  );
}

const LAST_PROJECT = "tp.lastProject";

function readOpen(): string {
  const p = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const open = p.get("open");
  if (open !== null) return open;
  return CANVAS;
}

export const CANVAS = "canvas";

function SurfaceScreen({ id, title, onGo }: { id: string; title: string; onGo: (id: string) => void }) {
  const t = useT();
  const s = surfaceById(id);
  const [ctx, setCtx] = useState(readCtx);
  useEffect(() => {
    const onHash = () => setCtx(readCtx());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (!s) return null;
  /*
   * 同组的其它界面。页头（`TopBar`）会把它们画成一排 tab——
   * 这是左导航从 18 项收到 11 项之后，那些界面的去处。
   *
   * 一组里每一项都已经在左导航上时不画（配置组就是这样）：那只是把导航抄了一遍，
   * 而两处说同一件事，人会以为它们是两件事。
   */
  const siblings = surfacesInGroup(s.group);
  const tabs = siblings.some((x) => !navItemFor(x.id))
    ? siblings.map((x) => ({ id: x.id, label: t(x.title) }))
    : [];
  return (
    <SurfaceTabsProvider value={{ tabs, current: id, onSwitch: onGo }}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-surface={id} aria-label={title}>
        {s.render(ctx)}
      </div>
    </SurfaceTabsProvider>
  );
}

function readCtx(): { wfRunId?: string; revisionId?: string; focus?: string } {
  const p = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  return { revisionId: p.get("artifact") ?? undefined, wfRunId: p.get("run") ?? undefined, focus: p.get("at") ?? undefined };
}
