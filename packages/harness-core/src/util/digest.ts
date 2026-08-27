import { createHash } from "node:crypto";

/**
 * Short, stable fingerprints for the text a run depended on.
 *
 * A run pins the graph version it used, which fixes the shape of the work and every
 * parameter — and says nothing about the prompts, because those live in source and in
 * settings. So two runs can pin the same version, have been produced by different
 * instructions, and be compared as though only the arm differed. That is the one way a
 * paired evaluation can lie while every number in it is correct.
 *
 * A digest is not the prompt: it cannot tell you what changed. It can tell you THAT
 * something changed, which is the part a comparison needs in order to refuse.
 */
export const sha8 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 8);

export interface TextDigest {
  /** One fingerprint per named text, so a difference points at which one moved. */
  entries: Record<string, string>;
  /** One fingerprint over all of them, for a cheap equality check. */
  combined: string;
}

export function digestTexts(texts: Record<string, string>): TextDigest {
  const entries: Record<string, string> = {};
  for (const name of Object.keys(texts).sort()) entries[name] = sha8(texts[name] ?? "");
  return {
    entries,
    combined: sha8(Object.entries(entries).map(([k, v]) => `${k}:${v}`).join("|")),
  };
}

/** Which named texts differ between two digests. Empty means the two are interchangeable. */
export function digestDiff(a: TextDigest, b: TextDigest): string[] {
  const names = new Set([...Object.keys(a.entries), ...Object.keys(b.entries)]);
  return [...names].filter((n) => a.entries[n] !== b.entries[n]).sort();
}
