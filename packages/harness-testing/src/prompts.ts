import { digestTexts, type TextDigest } from "@testpilot/harness-core";
import {
  CASES_STABLE,
  CASES_STABLE_PLAIN,
  ORACLE_STRICT,
  STORIES_STABLE,
} from "./casegen/prompts.js";
import { CODEGEN_STABLE, REPAIR_STABLE } from "./codegen/prompts.js";

/**
 * Every instruction this vertical sends to a model, in one place, so a run can record what
 * it was told and a comparison can tell whether both arms were told the same thing.
 *
 * Listed by hand rather than scanned: a prompt that someone forgets to add here is a
 * prompt that can change without the fingerprint moving, and a fingerprint with holes in
 * it is worse than none — it would be believed.
 */
export function promptSources(): Record<string, string> {
  return {
    "plan.stories": STORIES_STABLE,
    "design.cases": CASES_STABLE,
    "design.cases:no-methods": CASES_STABLE_PLAIN,
    "design.cases:oracle-strict": ORACLE_STRICT,
    "codegen.case": CODEGEN_STABLE,
    "repair.loop": REPAIR_STABLE,
  };
}

export const promptDigest = (): TextDigest => digestTexts(promptSources());
