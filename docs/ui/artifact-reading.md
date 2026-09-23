# Artifact reading contract

All projects use `RevisionContent` in `src/components/workbench/RevisionViewer.tsx`.
Never dispatch on project IDs, product names, hosts or individual revision IDs.
Keep persisted artifacts immutable; presentation must not rewrite evidence or hashes.

## Renderer selection

- Rule pack: `product-rule-pack.v1`, directly or inside a bound `rulePack`; group rules by module, show exact statements and claim type, search across all rules, disclose applicability, verification and sources.
- Exploration: `exploration-report.v1`; show actual completion, stop reason, coverage and unknowns. Attempted is not passed; absent is not inapplicable.
- Product model: `product-model.v1`; preserve features, verification reasons, claims and conflicts, not just its module tree.
- Existing stories, module plans, cases, gates, execution reports and code retain their dedicated readers.
- Markdown: semantic headings, ordered steps, tables and safe source links.
- Unknown objects: `DocumentFields` recursively groups every field. Unknown names remain visible. Technical references are disclosed separately. Do not stringify the entire object as the primary view or omit unrecognized fields.

Every revision retains its original download and collapsed source/raw-data section.
Use `artifactLabel` for friendly titles. Add localized labels for new known fields and enum values.

## Generation

`ARTIFACT_WRITING_GUIDELINES` is shared by internal story/case/composition prompts and `loadRunInstructions` for host planners. Preserve existing schema fields and mandatory tokens. Human prose contains business meaning, conditions and uncertainty; references and statuses belong in their defined fields. Do not create a parallel display schema or synthesize successful outcomes for readability.
Frozen historical instructions remain unchanged. New instruction revisions receive the guidance automatically after the server loads the new code.

## Validation

Run `pnpm typecheck:app`, `pnpm --filter testpilot-server typecheck`,
`pnpm --filter testpilot-server exec vitest run --config vitest.reading.config.ts`,
and affected harness tests when changing generation prompts.
The reading checks use a library lending fixture rather than the current trading project, cover unknown fields and zero/false, and ensure unverified exploration remains explicit and Markdown links are safe.
