import { expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveHarnessConfig } from "../src/config/resolve.js";

it("falls back to defaults when neither file nor env says anything", () => {
  expect(resolveHarnessConfig({}, {})).toEqual(DEFAULT_CONFIG);
});

it("lets the file override defaults and env override the file", () => {
  const cfg = resolveHarnessConfig(
    { model: { concurrency: 2 }, events: { keepLast: 10 } },
    { MODEL_CONCURRENCY: "4" },
  );
  expect(cfg.model.concurrency).toBe(4); // env wins
  expect(cfg.events.keepLast).toBe(10); // file wins over default
  expect(cfg.events.trimMs).toBe(DEFAULT_CONFIG.events.trimMs); // untouched
});

it("keeps runners tracking the queue unless told otherwise", () => {
  // A runner executes one case at a time: raising the queue alone would just make dispatch wait.
  expect(resolveHarnessConfig({}, { RUN_CONCURRENCY: "3" }).execution).toEqual({
    queueConcurrency: 3,
    runnerCount: 3,
  });
  expect(resolveHarnessConfig({}, { RUN_CONCURRENCY: "3", RUNNER_COUNT: "1" }).execution).toEqual({
    queueConcurrency: 3,
    runnerCount: 1,
  });
});

it("ignores nonsense values rather than propagating a zero", () => {
  const cfg = resolveHarnessConfig({}, { MODEL_CONCURRENCY: "0", RUN_CONCURRENCY: "not-a-number" });
  expect(cfg.model.concurrency).toBe(1);
  expect(cfg.execution.queueConcurrency).toBe(1);
});

it("adds denied hosts from the environment instead of replacing the configured ones", () => {
  const cfg = resolveHarnessConfig({ guard: { denyHosts: ["prod.example.com"] } }, { DENY_HOSTS: "live.example.com, pay.example.com" });
  expect(cfg.guard.denyHosts).toEqual(["prod.example.com", "live.example.com", "pay.example.com"]);
});

it("reads the ablation list from the environment, empty string meaning none", () => {
  expect(resolveHarnessConfig({}, { ABLATE: "memory,oracle" }).ablate).toEqual(["memory", "oracle"]);
  expect(resolveHarnessConfig({ ablate: ["memory"] }, { ABLATE: "" }).ablate).toEqual([]);
});
