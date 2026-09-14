import { projectHref } from './projectContext';
import { API_BASE } from './base';
export interface Revision { id: string; runId: string; name: string; kind: string; revision: number; contentHash: string; sourceRefs: string[]; parentRevision: string | null; createdAt: string; createdBy: { kind: string; id: string } }
export interface WorkflowRun { id: string; status: string; detail?: { parameters?: { sourceKind?: string; sourceUrl?: string; limit?: number } }; provenance: string; startedAt?: string; binding: { models: { entry: string; runtime: string; planner: { model?: string | null; source: string }; executor: { model?: string | null } }; skillVersion: string | null; inputHash: string | null } | null; nodes: { node: string; phase: string; at: string; message?: string }[]; revisions: Revision[] }
export interface ReviewCase { caseId: string; revision: Revision; content: { id: string; title: string; steps: string[]; expected: string; oracle?: unknown; sourceRefs?: string[]; [key: string]: unknown }; approval: { decision: string; principal: { id: string }; at: string } | null }
export interface Execution { id: string; status: string; resultRevision: string | null; startedAt: string }
export function runOrigin(run:WorkflowRun) {
  const models=run.binding?.models;
  if(!models)return '—';
  if(models.entry==='web')return 'Web';
  return ({codex:'Codex','claude-code':'Claude Code',penguin:'PenguinHarness'} as Record<string,string>)[models.runtime]??models.runtime;
}
export class WorkflowError extends Error { constructor(readonly code: string) { super(code); } }
export async function workflowRequest<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}/api/${path}`, { method, signal, credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json(); if (!res.ok) {
    throw new WorkflowError(data.code ?? 'request_failed');
  } return data as T;
}
export const workflowBase = (projectId: string) => `projects/${encodeURIComponent(projectId)}/workflow-runs`;
export const workflowHref = (runId: string) => projectHref('canvas', {runId,revisionId:'',nodeId:''});

/** getRandomValues also works on local HTTP deployments without randomUUID. */
export function workflowRequestId() { return `web-${Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('')}`; }
