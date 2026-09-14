import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { RunPipelineOptions, RunPipelineResult } from "./pipeline.js";
import { RunMetaSchema } from "./contracts.js";
import { RunGateway } from "./run-gateway.js";

/** G2 consumes server-approved revisions; local decisions.json is never an approval authority. */
export async function runApprovedPipeline(opts: RunPipelineOptions, gateway = new RunGateway()): Promise<RunPipelineResult> {
  if (!opts.approvedRunId) throw new Error("g2_approved_run_required");
  if (opts.signal?.aborted) throw new Error("g2_cancelled");
  const outDir = resolve(opts.outDir);
  if (basename(outDir) === opts.approvedRunId) throw new Error("g2_export_must_not_overwrite_generation_run");
  const startedAt = new Date().toISOString(), start = Date.now();
  const compiled = await gateway.call(opts.approvedRunId, "stages/g2", { revisionIds: opts.approvedRevisionIds });
  if (compiled.status !== "ready_to_execute") throw new Error("g2_code_gate_blocked");
  const artifact = await gateway.artifact(opts.approvedRunId, compiled.revision.id);
  const parent = await gateway.registeredRun(opts.approvedRunId);
  const binding = parent.binding, planner = binding.models.planner;
  const meta = RunMetaSchema.parse({ runId: opts.approvedRunId, stage: "g2", runtime: binding.models.runtime,
    skillVersion: binding.skillVersion, promptsDigest: { entries: {}, combined: binding.loadedDigest },
    params: { compiler: artifact.content.compilation, approvedRevisions: artifact.content.approvedRevisions, artifactRevision: artifact.revision.id },
    ablated: [], model: { baseUrl: planner.endpoint ?? "", model: planner.model ?? "unknown", thinking: planner.thinking }, modelRoles: binding.models,
    materialsHash: binding.materialsHash, inputHash: artifact.content.approvalsHash, startedAt, finishedAt: new Date().toISOString(),
    spend: { calls: 0, tokens: 0, ms: Date.now() - start } });
  if (opts.signal?.aborted) throw new Error("g2_cancelled");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "code.json"), JSON.stringify(artifact.content, null, 2));
  writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
  return { runId: opts.approvedRunId, stories: new Set(artifact.content.cases.map((c: { storyId: string }) => c.storyId)).size,
    cases: artifact.content.cases.length, gateScore: compiled.gate.score, outDir, ran: ["g2"], nodes: [], meta };
}
