import { describe, expect, it } from "vitest";
import { verifyCleanEnvironment } from "../src/executionPolicy.js";

// docs/v3/15 阶段 5.4：停批之前让环境的只读核对命令复核。只有退出码 0 才算干净，拿不准就停。
describe("verifyCleanEnvironment", () => {
  const pending = [{ id: "r1", identity: "order.open" }];
  it("is not configured without a command", () => {
    expect(verifyCleanEnvironment(undefined, pending)).toBeNull();
    expect(verifyCleanEnvironment("  ", pending)).toBeNull();
  });
  it("maps exit 0 to clean, 1 to dirty, anything else to unknown", () => {
    expect(verifyCleanEnvironment("exit 0", pending)?.status).toBe("clean");
    expect(verifyCleanEnvironment("exit 1", pending)?.status).toBe("dirty");
    expect(verifyCleanEnvironment("exit 3", pending)?.status).toBe("unknown");
  });
  it("hands the pending resources to the command and redacts secrets from what it prints", () => {
    const v = verifyCleanEnvironment('echo "$TP_PENDING_RESOURCES token=s3cret"', pending, ["s3cret"]);
    expect(v).toEqual({ status: "clean", output: '[{"id":"r1","identity":"order.open"}] token=***' });
  });
});
