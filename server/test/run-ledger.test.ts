import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunLedger } from "../src/runLedger.js";
import { captureWebModels } from "./helpers/model-snapshot.js";
import type { RunRegistration } from "@testpilot/harness-core/run-contracts";
const dirs: string[] = [], ledgers: RunLedger[] = [];
afterEach(() => { for (const l of ledgers.splice(0)) if (l.db.open) l.close(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const actor = { kind: "agent" as const, id: "host-test" };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tp-ledger-")); dirs.push(dir);
  const open = () => { const l = new RunLedger(join(dir, "workflows.db"), join(dir, "blobs")); ledgers.push(l); return l; };
  return { ledger: open(), dir, open };
}
function input(projectId = "p", externalId = "host-session"): RunRegistration {
  return { projectId, externalId, idempotencyKey: externalId, binding: { schemaVersion: 1, models: captureWebModels().binding,
    skillVersion: "test", loadedDigest: "a".repeat(64), materialsHash: null, inputHash: null, environmentHash: null, materialRevisions: [] } };
}
it("registers once across retries and process restart, and rejects identity conflicts", () => {
  const { ledger, open } = setup();
  const a = ledger.register(input(), actor);
  expect(ledger.register(input(), actor)).toEqual({ ...a, created: false });
  expect(() => ledger.register({ ...input(), parameters: { changed: true } }, actor)).toThrow("run_registration_conflict");
  ledger.close(); const restarted = open();
  expect(restarted.register(input(), actor).runId).toBe(a.runId);
  expect(restarted.listRuns("p")).toHaveLength(1);
  expect(() => restarted.getRun(a.runId, "other-project")).toThrow("run_project_conflict");
});
it("stores immutable revisions, checks optimistic parents and source project scope", () => {
  const { ledger } = setup(); const { runId } = ledger.register(input(), actor);
  const draft = { runId, projectId: "p", name: "requirements", kind: "material" as const, content: { rule: "quantity > 0" } };
  const first = ledger.putRevision(draft, actor);
  expect(ledger.putRevision(draft, actor).id).toBe(first.id);
  expect(() => ledger.putRevision({ ...draft, content: { rule: "quantity >= 0" } }, actor)).toThrow("revision_version_conflict");
  const second = ledger.putRevision({ ...draft, content: { rule: "quantity >= 1" }, parentRevision: first.id }, actor);
  expect(second.revision).toBe(2); expect(ledger.readRevision(first.id, "p").content).toEqual(draft.content);
  const other = ledger.register(input("other"), actor);
  expect(() => ledger.putRevision({ ...draft, runId: other.runId, projectId: "other", sourceRefs: [first.id] }, actor)).toThrow("revision_project_conflict");
  expect(ledger.integrity()).toEqual({ ok: true, issues: [] });
});
it("seals material inputs and detects disk changes instead of trusting mutable paths", () => {
  const { ledger, dir } = setup(); const { runId } = ledger.register(input(), actor);
  const rev = ledger.putRevision({ runId, projectId: "p", name: "spec", kind: "material", content: "Original", mediaType: "text/markdown" }, actor);
  const binding = ledger.sealInputs(runId, "p", [rev.id]);
  expect(binding.inputHash).toHaveLength(64); expect(ledger.sealInputs(runId, "p", [rev.id])).toEqual(binding);
  const changed = ledger.putRevision({ runId, projectId: "p", name: "spec", kind: "material", content: "Changed", mediaType: "text/markdown", parentRevision: rev.id }, actor);
  expect(() => ledger.sealInputs(runId, "p", [changed.id])).toThrow("run_inputs_already_sealed");
  writeFileSync(join(dir, "blobs", rev.contentHash), "tampered");
  expect(() => ledger.readRevision(rev.id, "p")).toThrow("revision_content_changed");
  expect(ledger.integrity().ok).toBe(false);
});
it("projects out-of-order duplicate events deterministically and rebuilds after restart", () => {
  const { ledger, open } = setup(); const { runId } = ledger.register(input(), actor);
  const e = { id: "end", runId, node: "stories", attempt: 0, sequence: 2, phase: "done" as const, at: new Date().toISOString() };
  ledger.appendEvent(e, "p"); ledger.appendEvent({ ...e, id: "start", phase: "running", sequence: 1 }, "p");
  expect(ledger.appendEvent(e, "p").created).toBe(false);
  expect(() => ledger.appendEvent({ ...e, phase: "failed" }, "p")).toThrow("event_identity_conflict");
  expect(ledger.nodeStates(runId)[0].phase).toBe("done");
  ledger.appendEvent({ ...e, id: "retry", attempt: 1, sequence: 0, phase: "running" }, "p");
  ledger.db.prepare("DELETE FROM workflow_node_states").run(); ledger.close();
  const restarted = open(); restarted.rebuild();
  expect(restarted.nodeStates(runId)[0]).toMatchObject({ attempt: 1, phase: "running" });
});
it("migrates alongside old workflow rows without inventing provenance", () => {
  const { ledger, open } = setup();
  ledger.outputs.saveRun({ id: "legacy", graphId: "g1", graphVersion: 1, status: "done", startedAt: "2020-01-01", detail: { target: { projectId: "p" } } });
  ledger.close(); const restarted = open();
  expect(restarted.getRun("legacy", "p")).toMatchObject({ status: "done", provenance: "unknown", binding: null });
  expect(restarted.integrity().ok).toBe(true);
});
