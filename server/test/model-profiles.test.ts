import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";

let store: typeof import("../src/modelProfiles.js");
let database: typeof import("../src/db.js");
let a: string, b: string, url: string, server: Server;
let dir: string;
const actualFetch = globalThis.fetch;
const calls: { url: string; body: string; key: string }[] = [];
const draft = (model = "planner-model", endpoint = "https://planner.test/v1") => ({
  expectedVersion: 0, provider: "test", model, endpoint, thinking: false,
  capabilities: { vision: "unknown", toolUse: "unknown" }, apiKey: "test-secret",
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-profiles-"));
  vi.stubEnv("TP_DATA_DIR", dir);
  const env = join(dir, "empty.env"); writeFileSync(env, ""); vi.stubEnv("DOTENV_CONFIG_PATH", env);
  database = await import("../src/db.js"); store = await import("../src/modelProfiles.js");
  a = database.createProject("A", "http://sut.test").id;
  b = database.createProject("B", "http://sut.test").id;
  const { modelProfilesRouter } = await import("../src/modelProfilesRoutes.js");
  const app = express(); app.use(express.json()); app.use("/projects/:projectId/models", modelProfilesRouter());
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    if (u.startsWith(url)) return actualFetch(input, init);
    if (!u.startsWith("https://planner.test/") && !u.startsWith("https://executor.test/")) throw new Error("Unexpected endpoint");
    calls.push({ url: u, body: String(init?.body), key: String((init?.headers as Record<string, string>)?.Authorization) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { total_tokens: 2 } }), { status: 200 });
  }));
});
afterAll(async () => {
  if (server) await new Promise<void>(r => server.close(() => r()));
  database?.db.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("project role settings", () => {
  it("saves an encrypted, versioned project profile without exposing secrets", () => {
    const p = store.saveProjectModelProfile(a, "planner", draft());
    expect(p).toMatchObject({ version: 1, role: "planner", credentialState: "ok" });
    expect(JSON.stringify(p)).not.toMatch(/test-secret|secretRef|keyEnc/);
    const rows = database.db.prepare("SELECT * FROM model_profiles").all();
    expect(JSON.stringify(rows)).not.toContain("test-secret");
    expect(store.projectModelProfiles(b)).toEqual({});
  });

  it("preserves old credential versions when a profile is updated", () => {
    const old = store.projectProfileLayers(a).project!.planner!;
    store.saveProjectModelProfile(a, "planner", { ...draft(), expectedVersion: 1, apiKey: "new-secret" });
    expect(store.resolveProfileCredential(a, old)).toBe("test-secret");
    expect(store.resolveProfileCredential(a, store.projectProfileLayers(a).project!.planner!)).toBe("new-secret");
    expect(() => store.resolveProfileCredential(b, old)).toThrow("invalid_profile");
  });

  it("rejects stale updates and malformed profiles without writing rows", () => {
    const n = database.db.prepare("SELECT count(*) n FROM model_profiles").get();
    expect(() => store.saveProjectModelProfile(a, "planner", draft())).toThrow("profile_version_conflict");
    expect(() => store.saveProjectModelProfile(a, "executor", { ...draft(), endpoint: "https://secret@test/v1" })).toThrow("invalid_profile");
    expect(database.db.prepare("SELECT count(*) n FROM model_profiles").get()).toEqual(n);
  });

  it("requires an explicit credential choice when an endpoint changes", () => {
    expect(() => store.saveProjectModelProfile(a, "planner", { ...draft("m", "https://changed.test/v1"), expectedVersion: 2, apiKey: "" }))
      .toThrow("endpoint_change_requires_credential_choice");
  });

  it("persists both project roles in the existing DB, readable by a fresh connection", () => {
    store.saveProjectModelProfile(a, "executor", draft("executor-model", "https://executor.test/v1"));
    const reopened = new Database(join(dir, "testpilot.db"), { readonly: true });
    try { expect(reopened.prepare("SELECT DISTINCT role FROM model_profiles WHERE projectId=?").all(a)).toHaveLength(2); }
    finally { reopened.close(); }
  });

  it("scopes HTTP reads to a project and reports missing projects", async () => {
    const res = await fetch(`${url}/projects/${a}/models`); const result = await res.json();
    expect(res.status).toBe(200); expect(result.profiles.planner.version).toBe(2);
    expect(JSON.stringify(result)).not.toMatch(/test-secret|new-secret|keyEnc|secretRef/);
    expect((await fetch(`${url}/projects/missing/models`)).status).toBe(404);
  });

  it("probes exactly the saved role and version, with images only for the executor", async () => {
    for (const role of ["planner", "executor"]) {
      const version = role === "planner" ? 2 : 1;
      const r = await fetch(`${url}/projects/${a}/models/${role}/probe`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version, profileId: store.projectModelProfiles(a)[role as "planner" | "executor"]!.id }),
      });
      expect(r.status).toBe(200); expect((await r.json()).state).toBe("ok");
    }
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://planner.test/v1/chat/completions");
    expect(calls[0].key).toBe("Bearer new-secret");
    expect(calls[0].body).not.toContain("image_url");
    expect(calls[1].url).toBe("https://executor.test/v1/chat/completions");
    expect(calls[1].body).toContain("image_url");
  });

  it("rejects probes for a stale version before calling a model", async () => {
    const r = await fetch(`${url}/projects/${a}/models/planner/probe`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: 1 }),
    });
    expect(r.status).toBe(409); expect(calls).toHaveLength(2);
  });

  it("clears a key without falling back to old environment credentials", () => {
    const p = store.saveProjectModelProfile(a, "executor", { ...draft("executor-model", "https://executor.test/v1"), expectedVersion: 1, apiKey: "", clearCredential: true });
    expect(p.credentialState).toBe("none");
    expect(store.resolveProfileCredential(a, store.projectProfileLayers(a).project!.executor!)).toBe("");
  });

  it("resolves a host executor without requiring or validating a separate planner", () => {
    vi.stubEnv("TP_PLANNER_MODEL_NAME", "unrelated-invalid-planner");
    vi.stubEnv("TP_PLANNER_BASE_URL", "not-a-url");
    try {
      expect(store.projectModelConnection(a, "executor")).toMatchObject({ role: "executor", model: "executor-model", apiKey: "" });
      expect(() => store.projectProfileLayers(b, "planner")).toThrow("invalid_profile (planner)");
    } finally { vi.unstubAllEnvs(); }
  });

  it("starts with env defaults and keeps an explicitly saved project snapshot independent", () => {
    vi.stubEnv("TP_PLANNER_MODEL_NAME", "initial-shared-model");
    vi.stubEnv("TP_PLANNER_BASE_URL", "https://planner.test/v1");
    vi.stubEnv("TP_PLANNER_API_KEY", "env-planner-secret");
    try {
      expect(store.projectModelProfiles(b).planner).toMatchObject({ model: "initial-shared-model", origin: "environment", credentialState: "ok" });
      const saved = store.saveProjectModelProfile(b, "planner", { ...draft("project-planner"), apiKey: "" });
      const captured = store.projectModelConnection(b, "planner");
      vi.stubEnv("TP_PLANNER_MODEL_NAME", "future-planner");
      vi.stubEnv("TP_PLANNER_API_KEY", "future-key");
      expect(store.projectModelProfiles(b).planner).toMatchObject({ id: saved.id, model: "project-planner", origin: "project" });
      expect(captured.apiKey).toBe("env-planner-secret");
      expect(store.projectModelConnection(b, "planner").apiKey).toBe("env-planner-secret");
      expect(JSON.stringify(saved)).not.toContain("env-planner-secret");
    } finally { vi.unstubAllEnvs(); }
  });
});
