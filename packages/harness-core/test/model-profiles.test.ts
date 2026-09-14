import { describe, expect, it } from "vitest";
import {
  ModelProfileSchema, RunModelsSchema, HostPlannerBindingSchema, ModelConfigError,
  selectModelProfile, resolveRunModels, readRunModels, previewLegacyModelMigration,
  type ModelProfile, type HostPlannerBinding,
} from "../src/model/profiles.js";

const profile = (role: "planner" | "executor", version = 1): ModelProfile => ({
  schemaVersion: 1, id: role, version, role, provider: "local",
  model: `${role}-model`, endpoint: `http://${role}.test/v1`, secretRef: `vault:${role}`,
  thinking: role === "planner", capabilities: { vision: "unknown", toolUse: "unknown" },
});
const profiles = { default: { planner: profile("planner"), executor: profile("executor") } };
const host: HostPlannerBinding = {
  role: "planner", source: "host", runtime: "claude-code", model: null,
  provider: null, thinking: null, identityEvidence: "unknown",
};
const web = () => resolveRunModels({ entry: "web", mode: "skill", runtime: "penguin", profiles });

describe("two entrances and independent model roles", () => {
  it("binds two complete profiles for Web, without credentials or secret references", () => {
    const b = web();
    expect(b.planner.model).toBe("planner-model");
    expect(b.executor.model).toBe("executor-model");
    expect(JSON.stringify(b)).not.toContain("vault:");
  });

  it.each(["planner", "executor"] as const)("rejects a missing %s Web profile", (role) => {
    const defaults = { ...profiles.default }; delete defaults[role as keyof typeof defaults];
    expect(() => resolveRunModels({ entry: "web", mode: "skill", runtime: "penguin", profiles: { default: defaults } }))
      .toThrow(`missing_profile (${role})`);
  });

  it.each(["claude-code", "codex", "penguin"] as const)("inherits %s host identity without a planner profile", (runtime) => {
    const b = resolveRunModels({ entry: "host", mode: "skill", runtime,
      hostPlanner: { ...host, runtime }, profiles: { default: { executor: profile("executor") } } });
    expect(b.planner).toEqual({ ...host, runtime });
    expect(b.executor.model).toBe("executor-model");
  });

  it("does not substitute a configured planner for absent host identity", () => {
    expect(() => resolveRunModels({ entry: "host", mode: "skill", runtime: "claude-code", profiles }))
      .toThrow("invalid_binding (planner)");
  });

  it("requires an executor even when the host provides planning", () => {
    expect(() => resolveRunModels({ entry: "host", mode: "skill", runtime: "claude-code", profiles: {}, hostPlanner: host }))
      .toThrow("missing_profile (executor)");
  });

  it("keeps A pipeline explicit and rejects a host claiming internal generation is host planning", () => {
    expect(resolveRunModels({ entry: "web", mode: "pipeline", runtime: "pipeline", profiles }).planner.source).toBe("configured");
    expect(() => resolveRunModels({ entry: "host", mode: "pipeline", runtime: "claude-code", profiles, hostPlanner: host }))
      .toThrow(ModelConfigError);
  });

  it("rejects switched roles and a host from another runtime", () => {
    const b = web();
    expect(RunModelsSchema.safeParse({ ...b, planner: b.executor, executor: b.planner }).success).toBe(false);
    expect(() => resolveRunModels({ entry: "host", mode: "skill", runtime: "codex", profiles, hostPlanner: host }))
      .toThrow(ModelConfigError);
  });
});

describe("versioned configuration precedence", () => {
  it("takes an entire run profile ahead of project/default, leaving other roles independent", () => {
    const layers = { ...profiles, project: { planner: profile("planner", 2) }, run: { planner: profile("planner", 3) } };
    const b = resolveRunModels({ entry: "web", mode: "skill", runtime: "penguin", profiles: layers });
    expect(b.planner).toMatchObject({ profileVersion: 3, scope: "run" });
    expect(b.executor).toMatchObject({ profileVersion: 1, scope: "default" });
    layers.run.planner.version = 4;
    expect(b.planner).toHaveProperty("profileVersion", 3);
  });

  it("never fills a malformed high priority profile from lower scopes", () => {
    expect(() => selectModelProfile("planner", { ...profiles,
      project: { planner: { ...profile("planner"), endpoint: "" } },
    })).toThrow("invalid_profile (planner)");
  });

  it("allows two roles to use the same model while retaining separate profile bindings", () => {
    const b = resolveRunModels({ entry: "web", mode: "skill", runtime: "penguin", profiles: {
      default: { planner: profile("planner"), executor: { ...profile("executor"), model: "planner-model", endpoint: profile("planner").endpoint } },
    } });
    expect(b.planner.model).toBe(b.executor.model);
    expect(b.planner).toHaveProperty("profileId", "planner");
    expect(b.executor.profileId).toBe("executor");
  });

  it("rejects secrets in public profile fields and keeps errors free of input values", () => {
    for (const endpoint of ["https://user:secret@test.test/v1", "https://test.test/v1?key=secret", "https://test.test/v1#secret", "file:///secret"]) {
      expect(ModelProfileSchema.safeParse({ ...profile("planner"), endpoint }).success).toBe(false);
      try { selectModelProfile("planner", { default: { planner: { ...profile("planner"), endpoint } } }); }
      catch (e) { expect(String(e)).not.toContain("secret"); }
    }
    expect(ModelProfileSchema.safeParse({ ...profile("planner"), apiKey: "secret" }).success).toBe(false);
  });
});

describe("honest legacy migration and host evidence", () => {
  it("previews presence only, without writing, choosing roles or disclosing values", () => {
    const env = Object.freeze({ OPENAI_API_KEY: "secret", OPENAI_BASE_URL: "https://user:secret@test/v1", MIDSCENE_MODEL_NAME: "private-name" });
    const saved = Object.freeze({ apiKeyEnc: "encrypted-secret", modelName: "private-name" });
    const p = previewLegacyModelMigration(env, saved);
    expect(p.planner).toEqual({ configured: false, requiresExplicitChoice: true });
    expect(p.legacy).toMatchObject({ modelPresent: true, endpointPresent: true, credentialPresent: true });
    expect(p.requiresConfirmation).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/secret|private-name|https:/);
    expect(previewLegacyModelMigration({ OPENAI_API_KEY: " " }).legacy.credentialPresent).toBe(false);
  });

  it("reads old runs as unknown instead of inferring two roles from one legacy model", () => {
    expect(readRunModels({})).toBeNull();
    expect(readRunModels({ modelRoles: web() })).toEqual(web());
    expect(() => readRunModels({ modelRoles: {} })).toThrow("invalid_binding");
  });

  it("requires evidence for known host models, without accepting a host API key", () => {
    expect(HostPlannerBindingSchema.safeParse({ ...host, model: "guessed-model" }).success).toBe(false);
    expect(HostPlannerBindingSchema.safeParse({ ...host, identityEvidence: "host-reported" }).success).toBe(false);
    expect(HostPlannerBindingSchema.safeParse({ ...host, identityEvidence: "host-reported", model: "reported-model" }).success).toBe(true);
    expect(HostPlannerBindingSchema.safeParse({ ...host, apiKey: "secret" }).success).toBe(false);
  });
});
