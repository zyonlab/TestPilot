import { describe, expect, it } from "vitest";
import { OpenAIModel } from "../src/index.js";

/**
 * The local model legitimately takes minutes on a long prompt, so timeouts here are a
 * normal operating condition rather than a bug — which makes the *message* the thing that
 * matters: it has to say which call ran out and against what limit, or the reader is left
 * guessing whether to raise a budget or rewrite a prompt.
 */

describe("a call that runs out of time", () => {
  it("names the call and the limit instead of 'operation aborted'", async () => {
    const model = new OpenAIModel({
      // A black-holed address: the connection hangs rather than being refused, which is
      // what makes the abort fire instead of a connection error.
      baseUrl: "http://10.255.255.1:8000/v1",
      apiKey: "x",
      model: "m",
      timeoutMs: 50,
    });
    await expect(
      model.chat({ stable: "s", variable: "v", maxTokens: 4321, label: "plan.stories" }),
    ).rejects.toThrow(/plan\.stories.*4321 tokens.*TP_MODEL_TIMEOUT_MS/s);
  });
});
