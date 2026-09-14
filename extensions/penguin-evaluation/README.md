# Penguin TestPilot Evaluation Extension

Penguin 0.2.9 (commit f8e795f) exposes workflow registration, but no native HTTP/page mounting hook. This extension starts a clearly identified companion UI at `http://127.0.0.1:7365` and registers the `testpilot-evaluation` workflow returning its location. It does not modify the native frontend, run Penguin's automatic-accept optimizer, or create an optimizer screen inside TestPilot.

## Install in an existing Penguin data root

Merge the absolute path to this directory's `index.mjs` into `<PENGUIN_HOME>/extensions.json`:

```json
{"extensions":["/absolute/path/to/testpilot/extensions/penguin-evaluation/index.mjs"]}
```

Keep other entries. Start Penguin normally with Node 24+ and the TestPilot dependencies installed. The extension uses the project's `server/.env`; host planners used to generate tests still inherit their own host models. Evaluation uses the configured Web planning role. `TP_EVOLUTION_PORT` changes the companion port; `TP_EVOLUTION_DIR` changes its private state directory. Default: `server/.data/penguin-evaluation`. TestPilot must use the same directory to display and freeze the active policy version.

Open the companion UI and log in with the `review-token` file from that directory. `TP_EVOLUTION_REVIEW_TOKEN` can supply an operator-managed credential. Neither token goes to candidate processes. The native Penguin login and this local approval session are separate; the extension SDK does not expose native session authentication. Existing Penguin settings and default agents are not changed by installation.

A candidate changes only `contextPolicy.memory` (`scoped` / `off`). Default is `scoped`. Every new TestPilot run captures `agentVersion` and `contextPolicy`; instruction delivery captures `memoryDigest`. Existing instruction snapshots are immutable. Promotion never edits a skill or gold file. Future changes to other skill/reference bytes require their own verified adapter and versioned asset bundle.

## Evaluation and isolation

The development probe has three repetitions per arm. Budget: one candidate, seven forwarded HTTP calls, ten minutes, and at most 7,168 output tokens. Truncated requests do not grow their budget. The optimizer sees development feedback only. External deterministic code computes scores; invalid model output is unobservable, not a fabricated P0 product failure. No statistical gain is implied by this small sequential experiment.

Candidates have no shell/file tools. Their actual model request runs in a macOS `sandbox-exec` child: private evaluator state, repository benchmark answers and `server/.env` are unreadable; writes outside a temporary workspace are denied; networking is restricted to one ephemeral model proxy port. Read/write denial is actively probed before each model call. Real provider keys stay in the parent proxy. Other operating systems fail closed until an equivalent sandbox adapter is implemented and verified.

## Human release gates

Development improvement only creates `awaiting_review`. Promotion requires a comparable, non-regressing held-out result, matching candidate policy hashes, P0/observation checks and a bound cross-host regression receipt. One held-out attempt per candidate is consumed atomically, including failed or interrupted attempts. Active version updates and rollback use generation-based compare-and-swap and retain version history.

The default installation deliberately has no held-out release adapter: the local-perp draft has not received actual human review/freeze. The UI shows the missing gates. An operator can set `TP_EVOLUTION_GATE_MODULE` to a reviewed module exporting `createGates({store,repoRoot})`, returning the `TrustedGates` callbacks defined in `server/src/evolution/http.ts`. These callbacks must run trusted scoring/host execution, return source-bound `Score` records, and keep all held-out details inside the service. There is no HTTP route to upload scores or install evaluator code. This adapter is a deployment trust boundary, not an agent-facing tool. The bundled release adapter is described below; actual promotion and frozen domain runs remain pending human gold review; a synthetic callback is only a test fixture.

## Reproduce

```bash
pnpm --filter testpilot-server exec tsx scripts/verify-penguin-evolution.ts --real
pnpm --filter testpilot-server exec tsx scripts/verify-evolution-review.ts
pnpm --filter testpilot-server exec vitest run test/evolution.test.ts
```

The first command launches an isolated actual Penguin server, loads this extension and operates its companion in a real browser with the configured model. The second uses explicitly marked synthetic gate results to verify real UI approval, rollback and TestPilot version snapshots. It is never evidence of user approval or quality improvement. Lab servers stop after verification; evidence and private state remain available.

### Built-in release receipt adapter

`TP_EVOLUTION_RELEASE_MANIFEST=/absolute/path/to/private/release-runs.json` enables the bundled production adapter. It reads human-frozen `individual-v1` gold and immutable workflow artifacts directly; it does not accept precomputed scores. Example shape (replace IDs with actual evaluated runs):

```json
{
  "schemaVersion": 1,
  "capability": "local-perp",
  "candidates": {
    "candidate-ID": {
      "heldout": {
        "baseline": [{"dataDir":"/private/baseline","projectId":"PROJECT","runId":"RUN"}],
        "candidate": [{"dataDir":"/private/candidate","projectId":"PROJECT","runId":"RUN"}]
      },
      "hosts": {
        "codex": {"baseline":[],"candidate":[]},
        "claude-code": {"baseline":[],"candidate":[]},
        "penguin": {"baseline":[],"candidate":[]}
      }
    }
  }
}
```

Every arm requires at least **three unique runs**; the abbreviated example is intentionally ineligible. Run the candidate in an isolated evaluation instance configured with its candidate context policy; do not switch the production active pointer to test it. Run registration must capture the expected `contextPolicy`/`agentVersion`; instruction delivery must match `loadedDigest` and `memoryDigest`; all case oracles must match the original generated cases, and execution must include every generated case. Missing, partial, changed or unobserved receipts fail closed. The adapter reads each artifact by its content hash and returns held-out aggregate coverage only. Gold matches/answers are never returned to the optimizer. Host gates require matching frozen input/model for each pair across all three runtimes and fully passing executions. Conservatively, any execution failure blocks the host gate; this is not a claim that every failing case has P0 priority.

Optional custom gate modules remain available for a different professional domain. The default local-perp release remains pending actual human gold review and corresponding real candidate runs; synthetic UI tests do not satisfy these requirements.

Prepare the isolated candidate instance before collecting release receipts:

```bash
TP_EVOLUTION_DIR=/private/source-evaluator pnpm --filter testpilot-server exec tsx scripts/prepare-candidate-instance.ts candidate-ID
```

The command creates a fresh temporary data root, prints its `TP_DATA_DIR` / `TP_EVOLUTION_DIR` / `TP_INSTANCE` settings and records `evaluationOnly:true`. Start a separate TestPilot server using those settings (and a different service port); register native host runs against it using the same frozen material, SUT URL and generation parameters as baseline. It does not activate the candidate in the source evaluator. After actual runs, place their data roots/project IDs/run IDs in the private release manifest. The production adapter verifies their captured policy and actual consumption before using them.
