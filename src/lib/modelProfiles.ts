import { API_BASE } from "./base";
import type { ModelProfileDraft, ModelRole, PublicModelProfile } from "../../packages/harness-core/src/model/profiles";
export type { ModelProfileDraft, ModelRole, PublicModelProfile };

export type ProjectModels = {
  profiles: Partial<Record<ModelRole, PublicModelProfile>>;
  migration: { legacy: { endpointPresent: boolean; modelPresent: boolean; credentialPresent: boolean } };
};
export class ModelProfileRequestError extends Error {
  constructor(readonly code: string) { super(code); }
}
async function request<T>(projectId: string, suffix: string, body?: unknown, method = "GET"): Promise<T> {
  const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/model-profiles${suffix}`, {
    method, headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45_000),
  });
  const data = await res.json();
  if (!res.ok) throw new ModelProfileRequestError(typeof data.code === "string" ? data.code : "request_failed");
  return data as T;
}
export const modelProfilesApi = {
  read: (projectId: string) => request<ProjectModels>(projectId, ""),
  save: (projectId: string, role: ModelRole, draft: ModelProfileDraft) => request<PublicModelProfile>(projectId, `/${role}`, draft, "PUT"),
  probe: (projectId: string, role: ModelRole, version: number, profileId: string) => request<{ state: "ok" | "empty"; version: number }>(projectId, `/${role}/probe`, { version, profileId }, "POST"),
};
