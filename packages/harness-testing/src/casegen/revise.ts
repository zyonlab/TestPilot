import { z } from "zod";
import type { ModelClient } from "@testpilot/harness-core";
import { CASES_SCHEMA, CASES_STABLE, languageDirective } from "./prompts.js";
import { parseJson } from "./nodes.js";
import { TextCaseSchema, type Story, type TextCase } from "./types.js";

/**
 * Rewrite one case that a person, or gate ①, was not happy with.
 *
 * This is the review queue's "regenerate", and it is deliberately one case at a time
 * rather than "run the story again": the reviewer is looking at a specific case with
 * specific findings against it, and re-running the story would replace the cases they
 * already accepted alongside the one they did not.
 *
 * The findings are handed over verbatim. Telling the model "make it better" produces a
 * differently-worded case with the same defect; telling it "this assertion names no
 * observable phenomenon" is a thing it can act on.
 */

const REVISE_STABLE = [
  CASES_STABLE,
  "",
  "REVISION MODE: you are given ONE existing case and what a reviewer objected to.",
  "- Fix exactly what the objections name. Do not rewrite the case into a different case:",
  "  the story it belongs to and the scenario it exercises must stay the same.",
  "- If an objection is about the assertion, the replacement must name an observable",
  "  phenomenon — a literal message, a number, a state — not a rephrasing of the old one.",
  "- If an objection is about a credential written into a step, replace it with a",
  "  ${env.NAME} or ${secret.NAME} placeholder. Never invent a plausible-looking value:",
  "  a made-up credential does not fail honestly, it fails as if the product were broken.",
  "- Return exactly one case.",
].join("\n");

export interface ReviseInput {
  kase: TextCase;
  /** What gate ① said about this case, plus anything the reviewer wrote. */
  objections: string[];
  story?: Story;
  specText?: string;
  lang?: string;
}

export interface ReviseResult {
  kase: TextCase;
  tokens: number;
  ms: number;
}

function variable(input: ReviseInput): string {
  const { kase, story, specText, objections } = input;
  return [
    ...(specText ? ["SPECIFICATION (for context):", "", specText, ""] : []),
    ...(story
      ? [`STORY ${story.id}: ${story.title}`, "ACCEPTANCE CRITERIA:", ...story.acceptance.map((a, i) => `${i + 1}. ${a}`), ""]
      : []),
    "EXISTING CASE:",
    JSON.stringify(
      {
        title: kase.title,
        designMethod: kase.designMethod,
        precondition: kase.precondition,
        steps: kase.steps,
        expected: kase.expected,
        tier: kase.tier,
        key: kase.key,
      },
      null,
      2,
    ),
    "",
    "OBJECTIONS:",
    ...(objections.length ? objections.map((o, i) => `${i + 1}. ${o}`) : ["(none given — improve the assertion's checkability)"]),
    languageDirective(input.lang),
  ].join("\n");
}

export async function reviseCase(model: ModelClient, input: ReviseInput): Promise<ReviseResult> {
  const res = await model.chat({
    stable: REVISE_STABLE,
    variable: variable(input),
    schema: CASES_SCHEMA,
    maxTokens: 1200,
    label: `revise:${input.kase.id}`,
  });
  const shape = z.object({ cases: z.array(TextCaseSchema.omit({ id: true, storyId: true })).min(1) });
  const parsed = parseJson(res.text, shape, `revise:${input.kase.id}`, {
    truncated: res.truncated,
    maxTokens: 1200,
  });
  return {
    // The identity stays put: this is the same case, revised. A new id would detach it from
    // the decision the reviewer is in the middle of making, and from its provenance.
    kase: { ...parsed.cases[0], id: input.kase.id, storyId: input.kase.storyId },
    tokens: res.tokens,
    ms: res.ms,
  };
}
