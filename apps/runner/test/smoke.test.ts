import { afterEach, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  EventBus,
  EventKind,
  MemoryEventStore,
  Supervisor,
  type ChildApi,
  type Envelope,
} from "@testpilot/harness-core";

const ENTRY = fileURLToPath(new URL("../src/main.ts", import.meta.url));
let sup: Supervisor | undefined;
afterEach(async () => {
  await sup?.stopAll();
  sup = undefined;
});

it("boots under the supervisor, answers health and beats", async () => {
  const events: Envelope[] = [];
  const bus = new EventBus(new MemoryEventStore(), { coalesceMs: 0 });
  bus.subscribe((e) => events.push(e));
  sup = new Supervisor(bus);
  sup.register({
    id: "runner",
    kind: "node",
    entry: ENTRY,
    execArgv: ["--import", "tsx"], // TypeScript entry in dev; built output later
    restart: "never",
    heartbeatMs: 1000,
    readyTimeoutMs: 20000,
  });
  await sup.start("runner");

  const st = sup.statusOf("runner")!;
  expect(st.state).toBe("alive");
  expect(await sup.rpc<ChildApi>("runner")!.health()).toMatchObject({ ok: true });
  expect(sup.statusOf("runner")!.lastHeartbeat).toBeDefined();
  expect(sup.statusOf("runner")!.currentTask).toBe("idle");
  expect(
    events.some(
      (e) => e.kind === EventKind.log && String((e.payload as { text: string }).text).includes("up"),
    ),
  ).toBe(true);
}, 30000);
