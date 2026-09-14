import { navigateProject } from '@/lib/projectContext';
import { useState } from "react";
import { Button, EmptyState } from "@/components/ui";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { useT } from "@/lib/prefs";
import { useStore } from "@/lib/store";

/** Keep the requested page open while choosing or creating its project. */
export function NeedProject({ what }: { what?: string }) {
  const t = useT();
  const projects = useStore(s => s.projects);
  const selectProject = useStore(s => s.selectProject);
  const [adding, setAdding] = useState(false);
  return <>
    <EmptyState
      title={t("needProject.title")}
      body={what ? t("needProject.forWhat", { what }) : t("needProject.why")}
      actions={<div className="flex flex-wrap justify-center gap-2">
        {projects.map(p => <Button key={p.id} onClick={() => {navigateProject("canvas",{projectId:p.id});void selectProject(p.id);}}>{p.name}</Button>)}
        <Button variant="primary" onClick={() => setAdding(true)}>{t("projects.newProject")}</Button>
      </div>}
    />
    <NewProjectDialog open={adding} onClose={() => setAdding(false)} onCreated={id => {
      setAdding(false); void selectProject(id);
    }} />
  </>;
}
