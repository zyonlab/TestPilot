import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string, a: string, b: string;
let db: typeof import("../src/db.js");
let profiles: typeof import("../src/modelProfiles.js");
let snapshots: typeof import("../src/modelSnapshots.js");
const draft = (role: string, version = 0) => ({ expectedVersion: version, provider: "test", endpoint: `https://${role}.test/v1`, model: role,
  apiKey: `${role}-private-key-${version}`, thinking: false, capabilities: { vision: "unknown", toolUse: "unknown" } });
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tp-snapshots-")); writeFileSync(join(dir, ".env"), "");
  vi.stubEnv("TP_DATA_DIR", dir); vi.stubEnv("DOTENV_CONFIG_PATH", join(dir, ".env"));
  db = await import("../src/db.js"); profiles = await import("../src/modelProfiles.js"); snapshots = await import("../src/modelSnapshots.js");
  a = db.createProject("A", "http://sut.test").id; b = db.createProject("B", "http://sut.test").id;
  for (const role of ["planner", "executor"] as const) profiles.saveProjectModelProfile(a, role, draft(role));
});
afterAll(() => { db?.db.close(); vi.unstubAllEnvs(); if (dir) rmSync(dir, { recursive: true, force: true }); });

it("captures both roles atomically and encrypts the private runtime snapshot", () => {
  const snap = snapshots.captureWebModels("run-a", a, "penguin");
  expect(snap.binding).toMatchObject({ entry: "web", runtime: "penguin", planner: { profileVersion: 1 }, executor: { profileVersion: 1 } });
  expect(JSON.stringify(db.db.prepare("SELECT * FROM run_model_snapshots").all())).not.toContain("private-key");
  expect(JSON.stringify(snap.binding)).not.toMatch(/private-key|apiKey|secretRef/);
});

it("keeps original model, credentials and version across edits and resume", () => {
  for (const role of ["planner", "executor"] as const) profiles.saveProjectModelProfile(a, role, { ...draft(role, 1), model: `${role}-new` });
  expect(snapshots.captureWebModels("run-a", a, "penguin").planner).toMatchObject({ model: "planner", apiKey: "planner-private-key-0" });
  expect(snapshots.snapshotExecutor("run-a", a)).toMatchObject({ model: "executor", apiKey: "executor-private-key-0" });
  expect(snapshots.captureWebModels("run-new", a, "penguin").executor).toMatchObject({ model: "executor-new", apiKey: "executor-private-key-1" });
});

it("rejects project/runtime mismatches and missing roles without partial snapshots", () => {
  expect(() => snapshots.readModelSnapshot("run-a", b)).toThrow("run_model_scope_conflict");
  expect(() => snapshots.captureWebModels("run-a", a, "pipeline")).toThrow("run_model_binding_conflict");
  expect(() => snapshots.captureWebModels("missing-roles", b, "penguin")).toThrow("missing_profile");
  expect(snapshots.readModelSnapshot("missing-roles", b)).toBeUndefined();
});

it("fails closed if a stored snapshot cannot be decrypted", () => {
  db.db.prepare("UPDATE run_model_snapshots SET connectionsEnc=? WHERE runId=?").run("invalid-ciphertext", "run-new");
  expect(() => snapshots.snapshotExecutor("run-new", a)).toThrow("run_model_snapshot_unreadable");
});
