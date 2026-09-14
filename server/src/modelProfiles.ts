/** Project model profiles, versioned in the existing SQLite database. */
import { randomUUID } from "node:crypto";
import {
  ModelProfileSchema, ModelProfileDraftSchema, ModelConfigError,
  type ModelProfile, type ModelRole, type PublicModelProfile, type ProfileLayers,
  selectModelProfile, requireModelConnection, type RoleModelConnection,
} from "@testpilot/harness-core/model-profiles";
import { db, getProject } from "./db.js";
import { encryptSecret, decryptSecret } from "./vault.js";
import { environmentModelProfile, plannerConnectionFromEnv, executorConnectionFromEnv, plannerModel, gated, traced } from "@testpilot/harness-core";

type Row = { profileJson: string; keyEnc: string | null };
export class ProfileStoreError extends Error {
  constructor(readonly status: number, readonly code: string, readonly role?: ModelRole) {
    super(code); this.name = "ProfileStoreError";
  }
}

function requireProject(projectId: string) {
  if (!getProject(projectId)) throw new ProfileStoreError(404, "project_not_found");
}
function latest(projectId: string, role: ModelRole): Row | undefined {
  return db.prepare("SELECT profileJson, keyEnc FROM model_profiles WHERE projectId=? AND role=? ORDER BY version DESC LIMIT 1")
    .get(projectId, role) as Row | undefined;
}
function parse(row: Row): ModelProfile {
  try { return ModelProfileSchema.parse(JSON.parse(row.profileJson)); }
  catch { throw new ProfileStoreError(500, "stored_profile_invalid"); }
}
function publicProfile(row: Row): PublicModelProfile {
  const { secretRef: _ref, ...profile } = parse(row);
  let credentialState: PublicModelProfile["credentialState"] = "none";
  if (row.keyEnc) {
    try { decryptSecret(row.keyEnc); credentialState = "ok"; }
    catch { credentialState = "undecryptable"; }
  }
  return { ...profile, credentialState, origin: "project" };
}

export function projectModelProfiles(projectId: string): Partial<Record<ModelRole, PublicModelProfile>> {
  requireProject(projectId);
  const result: Partial<Record<ModelRole, PublicModelProfile>> = {};
  for (const role of ["planner", "executor"] as const) {
    const row = latest(projectId, role);
    if (row) result[role] = publicProfile(row);
    else {
      const profile = environmentModelProfile(role);
      if (profile) {
        const { secretRef, ...rest } = profile;
        result[role] = { ...rest, credentialState: secretRef ? "ok" : "none", origin: "environment" };
      }
    }
  }
  return result;
}

export function saveProjectModelProfile(projectId: string, role: ModelRole, input: unknown): PublicModelProfile {
  return db.transaction(() => {
    requireProject(projectId);
    const parsed = ModelProfileDraftSchema.safeParse(input);
    if (!parsed.success) throw new ProfileStoreError(400, "invalid_profile", role);
    const { expectedVersion, apiKey, clearCredential, ...fields } = parsed.data;
    if (clearCredential && apiKey) throw new ProfileStoreError(400, "conflicting_credential_actions", role);
    const row = latest(projectId, role);
    const previous = row ? parse(row) : undefined;
    if (expectedVersion !== (previous?.version ?? 0)) throw new ProfileStoreError(409, "profile_version_conflict", role);
    const inherited = !row ? environmentModelProfile(role) : undefined;
    if ((row?.keyEnc || inherited?.secretRef) && (previous?.endpoint ?? inherited?.endpoint) !== fields.endpoint && !apiKey && !clearCredential)
      throw new ProfileStoreError(400, "endpoint_change_requires_credential_choice", role);
    const version = expectedVersion + 1;
    const profileId = previous?.id ?? `model:${randomUUID()}`;
    const inheritedKey = inherited?.secretRef && !apiKey && !clearCredential
      ? (role === "planner" ? plannerConnectionFromEnv() : executorConnectionFromEnv()).apiKey : "";
    const keyEnc = clearCredential ? null : apiKey ? encryptSecret(apiKey) : row?.keyEnc ?? (inheritedKey ? encryptSecret(inheritedKey) : null);
    const profile = ModelProfileSchema.parse({ ...fields, schemaVersion: 1, role, id: profileId, version,
      secretRef: keyEnc ? `${profileId}:v${version}` : null });
    const record = { profileJson: JSON.stringify(profile), keyEnc };
    db.prepare("INSERT INTO model_profiles (projectId,role,version,profileJson,keyEnc,createdAt) VALUES (?,?,?,?,?,?)")
      .run(projectId, role, version, record.profileJson, keyEnc, new Date().toISOString());
    return publicProfile(record);
  })();
}

/** Snapshot references are immutable. Credentials only resolved on the server, by exact version. */
export function projectProfileLayers(projectId: string, selectedRole?: ModelRole): ProfileLayers {
  requireProject(projectId);
  const roles = selectedRole ? [selectedRole] : ["planner", "executor"] as const;
  const project: Partial<Record<ModelRole, ModelProfile>> = {};
  for (const role of roles) {
    const row = latest(projectId, role);
    if (row) project[role] = parse(row);
  }
  const environment: Partial<Record<ModelRole, ModelProfile>> = {};
  for (const role of roles) {
    // A complete project profile does not depend on unrelated or broken env settings.
    if (!project[role]) {
      const profile = environmentModelProfile(role);
      if (profile) environment[role] = profile;
    }
  }
  return { project, environment };
}

export function resolveProfileCredential(projectId: string, profile: ModelProfile): string {
  requireProject(projectId);
  const row = db.prepare("SELECT profileJson,keyEnc FROM model_profiles WHERE projectId=? AND role=? AND version=?")
    .get(projectId, profile.role, profile.version) as Row | undefined;
  if (!row || parse(row).id !== profile.id || parse(row).secretRef !== profile.secretRef)
    throw new ModelConfigError("invalid_profile", profile.role);
  if (!row.keyEnc) return "";
  try { return decryptSecret(row.keyEnc); }
  catch { throw new ProfileStoreError(400, "credential_undecryptable", profile.role); }
}

/** Capture one exact role/version without mutating process.env. */
export function projectModelConnection(projectId: string, role: ModelRole): RoleModelConnection {
  const { profile, binding } = selectModelProfile(role, projectProfileLayers(projectId, role));
  if (binding.scope === "environment") return role === "planner" ? plannerConnectionFromEnv() : executorConnectionFromEnv();
  return requireModelConnection(role, {
    role, endpoint: profile.endpoint, model: profile.model, thinking: profile.thinking,
    timeoutMs: profile.timeoutMs, thinkBudget: profile.thinkBudget, vlMode: profile.vlMode,
    apiKey: resolveProfileCredential(projectId, profile),
  });
}

/** The gateway owns planner credentials; a runner asks by project, never receives them. */
export function projectPlannerModel(projectId?: string, name = "gateway.planner") {
  return traced(gated(plannerModel(projectId
    ? projectModelConnection(projectId, "planner") : plannerConnectionFromEnv())), { name });
}
