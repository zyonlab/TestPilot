import { Button } from "@/components/ui";
import { useStore } from "@/lib/store";
import { useT } from "@/lib/prefs";

/** Loading failures remain visible without locking navigation. */
export function ProjectLoadNotice() {
  const t = useT();
  const projectsLoading = useStore(s => s.projectsLoading);
  const projectsError = useStore(s => s.projectsError);
  const dataLoading = useStore(s => s.projectDataLoading);
  const dataError = useStore(s => s.projectDataError);
  const activeId = useStore(s => s.activeProjectId);
  const loadData = useStore(s => s.loadData);
  const selectProject = useStore(s => s.selectProject);
  const failed = projectsError || dataError;
  if (!projectsLoading && !dataLoading && !failed) return null;
  return <div role={failed ? "alert" : "status"} className="flex flex-none flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-sm">
    <span className={failed ? "text-bad" : "text-muted-foreground"}>
      {t(projectsError ? "projectLoad.failed" : dataError ? "projectLoad.dataFailed" : "projectLoad.loading")}
    </span>
    {failed && <Button size="sm" disabled={projectsLoading || dataLoading} onClick={() => {
      if (projectsError) void loadData();
      else if (activeId) void selectProject(activeId);
    }}>{t("common.retry")}</Button>}
  </div>;
}
