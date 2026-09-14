import { describe, expect, it } from "vitest";
import { ablateFromEnv } from "../src/pipeline.js";

describe("ablateFromEnv（07 T-12）", () => {
  it("TP_ABLATE 逗号分隔、去空白、空串即无", () => {
    expect(ablateFromEnv({ TP_ABLATE: "domain-perp, dedupe" } as NodeJS.ProcessEnv)).toEqual(["domain-perp", "dedupe"]);
    expect(ablateFromEnv({ TP_ABLATE: "" } as NodeJS.ProcessEnv)).toEqual([]);
    expect(ablateFromEnv({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});
