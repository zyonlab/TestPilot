# Export contract experiment

This is a controlled component-regression fixture, not a Gold dataset. It has no `gold.json`, no independently annotated holdout, and no claim to replicate a real trading site.

Eight named lifecycle contracts share a two-step visible state machine. Each is exercised on a healthy screen, an intermediate-transition fault, and a final-transition fault. The fixed scorer checks the complete 144-trial matrix, healthy false alarms, unobservable outcomes, stable defect detections and lost detections. Three repeats measure repeatability; they do not create three independent tasks.

The real model generates a frozen structured input once per split. Both exporters receive identical cases. Historical `d2e62ce:server/src/export.ts` and the current exporter share dependency versions. Exported specs and production oracle code execute under real Playwright/Chrome. The exported `tests/ai.ts` is replaced by the same deterministic button adapter in both arms, explicitly isolating export fidelity from model action planning. Defect injection is calibrated by separately clicking the fixture and observing rendered output.

The reserved validation contracts are author-known. Do not describe them as an independent blinded holdout. No optimization loop may change expectations or the scorer to make a candidate pass.

Launch through the product's iteration-evaluation page or `pnpm --filter testpilot-server exec tsx scripts/run-evidence-study.ts`. The local Chrome channel must be installed and planner environment configured. Failed preparations remain in experiment history. Generation and process execution have bounded timeouts; candidates are not automatically published.

Verify a completed evidence directory using:

```sh
pnpm --filter testpilot-server exec tsx scripts/verify-evidence-study.ts <evidence-directory>
```

The verifier checks every sealed file and recomputes scores from raw trials. This provides local integrity, not an independent cryptographic attestation. The application records review provenance separately and refuses review of changed sealed results.
