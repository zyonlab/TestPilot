import { Router } from "express";
import { ModelRoleSchema, previewLegacyModelMigration, selectModelProfile } from "@testpilot/harness-core/model-profiles";
import { OpenAIModel } from "@testpilot/harness-core";
import { projectModelProfiles, projectProfileLayers, saveProjectModelProfile, projectModelConnection, ProfileStoreError } from "./modelProfiles.js";
import { getSavedModelConfig } from "./modelconfig.js";
import { PROBE_IMAGE } from "./config.js";

/** Saved-version probes; no provider error body (which may echo credentials) reaches clients. */
export function modelProfilesRouter() {
  const router = Router({ mergeParams: true });
  router.get<{ projectId: string }>("/", (req, res) => {
    try { res.json({ profiles: projectModelProfiles(req.params.projectId), migration: previewLegacyModelMigration(process.env, getSavedModelConfig() as Record<string, unknown>) }); }
    catch (e) { const err = e instanceof ProfileStoreError ? e : new ProfileStoreError(500, "profile_read_failed"); res.status(err.status).json({ code: err.code }); }
  });
  router.put<{ projectId: string; role: string }>("/:role", (req, res) => {
    const role = ModelRoleSchema.safeParse(req.params.role);
    if (!role.success) { res.status(400).json({ code: "invalid_role" }); return; }
    try { res.json(saveProjectModelProfile(req.params.projectId, role.data, req.body)); }
    catch (e) { const err = e instanceof ProfileStoreError ? e : new ProfileStoreError(500, "profile_write_failed"); res.status(err.status).json({ code: err.code, role: role.data }); }
  });
  router.post<{ projectId: string; role: string }>("/:role/probe", async (req, res) => {
    const role = ModelRoleSchema.safeParse(req.params.role);
    if (!role.success) { res.status(400).json({ code: "invalid_role" }); return; }
    try {
      const { profile } = selectModelProfile(role.data, projectProfileLayers(req.params.projectId, role.data));
      if (req.body?.version !== profile.version || req.body?.profileId !== profile.id) { res.status(409).json({ code: "profile_version_conflict", role: role.data }); return; }
      const connection = projectModelConnection(req.params.projectId, role.data);
      const model = new OpenAIModel({ baseUrl: profile.endpoint, model: profile.model,
        apiKey: connection.apiKey, noThink: profile.thinking === false, providerThinkingDefault: profile.thinking === null,
        timeoutMs: 30_000, retries: 0, thinkBudget: profile.thinkBudget });
      const result = await model.chat({ stable: "Reply with ok.", variable: "Connection check.", maxTokens: 64,
        label: `model.${role.data}.probe`, ...(role.data === "executor" ? { images: [PROBE_IMAGE] } : {}) });
      res.json({ state: result.text.trim() ? "ok" : "empty", role: role.data, version: profile.version,
        checked: role.data === "executor" ? "image-request" : "text-request" });
    } catch (e) {
      if (e instanceof ProfileStoreError) res.status(e.status).json({ code: e.code, role: role.data });
      else res.status(502).json({ code: "model_probe_failed", role: role.data });
    }
  });
  return router;
}
