/** Shared by host-run instructions and internal generation prompts. Schema remains authoritative. */
export const ARTIFACT_WRITING_GUIDELINES = [
  'Write human-facing titles, descriptions, acceptance criteria and steps in the language of the supplied product material. Use concise business language and one testable claim per item.',
  'Keep machine identifiers, source references, rule references and statuses in their existing schema fields. Do not paste JSON, hashes, selectors or diagnostic logs into business prose. Preserve exact required schema tokens and citations.',
  'Distinguish observed evidence, requirements, hypotheses and unresolved questions. Never rewrite an attempted interaction as a successful business verification. Explain missing fixtures and uncertainty in plain language without removing required markers.',
  'Follow the existing artifact schema; do not invent display-only fields or duplicate the same content as both JSON and prose. For Markdown documents use descriptive headings, numbered lifecycle steps and linked sources; preserve calculations, units, prerequisites and evidence.',
] as const;
