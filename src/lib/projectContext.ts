/** One URL context for every project view; changing a project invalidates child identities. */
export interface ProjectContext { projectId: string; runId: string; revisionId: string; nodeId: string; scope: string; caseId?:string }
export function readProjectContext(): ProjectContext {
  const p = new URLSearchParams(location.hash.split('?')[1] ?? '');
  return { projectId: p.get('project') ?? '', runId: p.get('run') ?? '', revisionId: p.get('artifact') ?? '', nodeId: p.get('node') ?? '', scope: p.get('scope') ?? '', ...(p.get('case')?{caseId:p.get('case')!}:{}) };
}
export function projectHref(surface: string, context: Partial<ProjectContext> = {}): string {
  const current = readProjectContext();
  const changedProject = context.projectId !== undefined && context.projectId !== current.projectId;
  const changedRun = context.runId !== undefined && context.runId !== current.runId;
  const next = { ...(changedProject ? { projectId: context.projectId } : changedRun ? {projectId:current.projectId,runId:context.runId} : current), ...context };
  const p = new URLSearchParams({ open: surface });
  for (const [field, key] of Object.entries({projectId:'project',runId:'run',revisionId:'artifact',nodeId:'node',scope:'scope',caseId:'case'})) {
    const value = next[field as keyof ProjectContext]; if (value) p.set(key, value);
  }
  return '#/?' + p;
}
export function navigateProject(surface: string, context: Partial<ProjectContext> = {}): void {
  location.hash = projectHref(surface, context);
  window.dispatchEvent(new CustomEvent('tp:navigated'));
}
