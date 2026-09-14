import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

/**
 * US-01: a project names the end it is tested on, and web3 is web-only (AC-01.1).
 *
 * The rule the UI enforces by hiding controls has to hold in the data too, or an iOS
 * project could still be carrying a wallet mode that nothing will ever inject. What is
 * tested here is the storage contract the UI reads: the column exists, it defaults to web
 * for every project written before it did, and switching ends is a change that survives.
 */

const dir = resolve(tmpdir(), `tp-platform-${process.pid}`);

let db: typeof import("../src/db.js");

beforeEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  process.env.TP_DATA_DIR = dir;
  db = await import("../src/db.js");
});

afterEach(() => {
  delete process.env.TP_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("a project's target end", () => {
  it("defaults to web, so nothing written before the column changes behaviour", () => {
    const p = db.createProject("web app", "https://example.com");
    expect(p.targetPlatform).toBe("web");
    expect(db.getProject(p.id)?.targetPlatform).toBe("web");
  });

  it("stores the end it was created with", () => {
    const p = db.createProject("native app", "https://example.com", "ios");
    expect(db.getProject(p.id)?.targetPlatform).toBe("ios");
  });

  it("switches ends without touching the rest of the project", () => {
    const p = db.createProject("was web", "https://example.com");
    const next = db.updateProject(p.id, { targetPlatform: "android" });
    expect(next?.targetPlatform).toBe("android");
    const stored = db.getProject(p.id);
    expect(stored?.targetPlatform).toBe("android");
    expect(stored?.name).toBe("was web");
    expect(stored?.targetUrl).toBe("https://example.com");
    expect(stored?.createdAt).toBe(p.createdAt);
  });

  it("returns nothing for a project that does not exist, rather than inventing one", () => {
    expect(db.updateProject("prj-nope", { targetPlatform: "ios" })).toBeUndefined();
  });
});
