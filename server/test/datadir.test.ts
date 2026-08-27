import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, rmSync } from "node:fs";

/**
 * Two gateways run at once during a self-test: the one doing the testing and the one being
 * tested. They must not share a database, or a case that deletes a project would be
 * deleting a real one. `TP_DATA_DIR` is the whole of that separation, so it gets a test.
 */

const load = async () => {
  vi.resetModules();
  return import("../src/datadir.js");
};

afterEach(() => {
  delete process.env.TP_DATA_DIR;
  delete process.env.TP_INSTANCE;
});

describe("where an instance keeps its state", () => {
  it("defaults to the gateway's own .data, so nothing changes for a normal run", async () => {
    const { DATA_DIR } = await load();
    expect(DATA_DIR.endsWith("/.data")).toBe(true);
  });

  it("moves everything when TP_DATA_DIR is set, and creates it", async () => {
    const dir = resolve(tmpdir(), `tp-datadir-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    process.env.TP_DATA_DIR = dir;
    const { DATA_DIR, dataPath } = await load();
    expect(DATA_DIR).toBe(dir);
    expect(dataPath("workflows.db")).toBe(resolve(dir, "workflows.db"));
    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("names itself so a screenshot of the wrong instance is recognisable", async () => {
    process.env.TP_INSTANCE = "sut";
    const { INSTANCE } = await load();
    expect(INSTANCE).toBe("sut");
  });
});
