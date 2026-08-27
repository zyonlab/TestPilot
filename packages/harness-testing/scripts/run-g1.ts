/**
 * Run G1 against the real model and score it.
 *
 * This is the stage-one measurement, not a demo: it prints coverage against the human
 * written gold checklist, the gate's view of the batch, and what it cost. Run it with
 *
 *   pnpm --filter @testpilot/harness-testing g1 [--record]
 *
 * `--record` also writes the model's replies to fixtures/recordings/g1.json, so the same
 * run can be replayed later in seconds without an endpoint.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import {
  EventBus,
  MemoryEventStore,
  MemoryOutputStore,
  RecordedModel,
  modelFromEnv,
  runGraph,
  scoreCoverage,
  methodMix,
  type GoldChecklist,
  type Recording,
} from "@testpilot/harness-core";
import { g1 } from "../src/casegen/graph.js";
import type { GatedBundle } from "../src/casegen/types.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const SPEC = readFileSync(`${FIXTURES}mock-spec/acme-portal.md`, "utf8");
const GOLD = JSON.parse(readFileSync(`${FIXTURES}mock-spec/gold-checklist.json`, "utf8")) as GoldChecklist;
const RECORDING = `${FIXTURES}recordings/g1.json`;

const record = process.argv.includes("--record");
const replay = process.argv.includes("--replay");

const live = modelFromEnv();
let recording: Recording = {};
try {
  recording = JSON.parse(readFileSync(RECORDING, "utf8")) as Recording;
} catch {
  /* first run */
}
const model =
  record || replay
    ? new RecordedModel(recording, {
        mode: record ? "record" : "replay",
        upstream: live,
        onRecord: (r) => {
          mkdirSync(`${FIXTURES}recordings`, { recursive: true });
          writeFileSync(RECORDING, JSON.stringify(r, null, 2));
        },
      })
    : live;

const bus = new EventBus(new MemoryEventStore(), { coalesceMs: 0 });
bus.subscribe((e) => {
  if (e.kind === "wf.node.started") console.log(`▶ ${(e.payload as { nodeId: string }).nodeId}`);
  if (e.kind === "wf.node.finished") {
    const p = e.payload as { nodeId: string; status: string; ms: number };
    console.log(`  ${p.status === "done" ? "✓" : "✗"} ${p.nodeId} ${(p.ms / 1000).toFixed(1)}s`);
  }
  if (e.kind === "log") console.log(`  · ${(e.payload as { text: string }).text}`);
});

const langArg = process.argv.find((a) => a.startsWith("--lang="))?.split("=")[1];
const { registry, def } = g1(model, { spec: { text: SPEC }, specText: SPEC, lang: langArg });
const started = Date.now();
const result = await runGraph(def, { registry, bus, store: new MemoryOutputStore() });

if (result.status !== "done") {
  console.error(`\nrun ended as ${result.status}: ${result.error?.message ?? ""}`);
  process.exit(1);
}

const bundle = result.outputs.gate as GatedBundle;
const cov = scoreCoverage(GOLD, bundle.cases);

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
console.log(`\n── stage one ──────────────────────────────`);
console.log(`stories        ${bundle.stories.length}`);
console.log(`cases          ${bundle.cases.length}`);
console.log(`gate score     ${pct(bundle.gate.score)}  (${bundle.gate.findings.length} findings)`);
console.log(`tiers          ${JSON.stringify(bundle.gate.stats.tiers)}`);
console.log(`methods        ${JSON.stringify(bundle.gate.stats.methods)}`);
console.log(`negative ratio ${pct(bundle.gate.stats.negativeRatio)}`);
console.log(`coverage       ${pct(cov.coverage)}  (held-out ${pct(cov.heldOut.coverage)})`);
console.log(`missed         ${cov.misses.map((m) => m.id).join(", ") || "none"}`);
console.log(`unmatched      ${cov.extras.length} case(s) matched no gold item`);
console.log(`method mix     ${JSON.stringify(methodMix(GOLD, cov))}`);
console.log(`cost           ${result.spend.calls} calls, ${result.spend.tokens} tokens, ${((Date.now() - started) / 1000).toFixed(0)}s`);

console.log(`\n── cases ──────────────────────────────────`);
for (const c of bundle.cases)
  console.log(`[${c.storyId}] t${c.tier} ${c.designMethod.padEnd(16)} ${c.title}\n    → ${c.expected}`);

if (bundle.gate.findings.length) {
  console.log(`\n── gate findings ──────────────────────────`);
  for (const f of bundle.gate.findings) console.log(`${f.severity === "warn" ? "!" : "·"} [${f.rule}] ${f.message}`);
}
