import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import WebSocket from "ws";
import { EventBus, EventKind, MemoryEventStore } from "@testpilot/harness-core";
import { attachWs } from "../src/ws.js";

// The UI depends on exactly three behaviours here, so they get pinned:
//   * a fresh client starts at the head (it loads state over REST, not by replaying history)
//   * a reconnecting client resumes from lastEventId with nothing missing
//   * a client that fell further behind than the replay window is told to resync
//     instead of being handed a partial, silently-wrong stream

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

type Msg = { type: string; [k: string]: unknown };

function boot(bus: EventBus): Promise<number> {
  server = createServer();
  attachWs(server, bus, () => {});
  return new Promise((resolve) =>
    server!.listen(0, () => resolve((server!.address() as AddressInfo).port)),
  );
}

function listen(url: string, ms: number): Promise<Msg[]> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const msgs: Msg[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d)) as Msg));
    setTimeout(() => {
      ws.close();
      resolve(msgs);
    }, ms);
  });
}

const bus = () => new EventBus(new MemoryEventStore(), { coalesceMs: 0 });

describe("/ws", () => {
  it("starts a fresh client at the head — history is fetched over REST, not replayed", async () => {
    const b = bus();
    b.publish(EventKind.log, { text: "before" });
    const port = await boot(b);

    const p = listen(`ws://127.0.0.1:${port}/ws`, 300);
    await new Promise((r) => setTimeout(r, 100));
    b.publish(EventKind.log, { text: "after" });
    const msgs = await p;

    expect(msgs[0]).toMatchObject({ type: "hello", head: 1, replayedFrom: 1 });
    const texts = msgs
      .filter((m) => m.type === "event")
      .map((m) => ((m.event as { payload: { text: string } }).payload.text));
    expect(texts).toEqual(["after"]);
  });

  it("resumes from lastEventId with no gap", async () => {
    const b = bus();
    for (let i = 1; i <= 5; i++) b.publish(EventKind.log, { n: i });
    const port = await boot(b);

    const msgs = await listen(`ws://127.0.0.1:${port}/ws?lastEventId=2`, 300);
    const ids = msgs.filter((m) => m.type === "event").map((m) => (m.event as { id: number }).id);
    expect(ids).toEqual([3, 4, 5]);
  });

  it("asks a far-behind client to resync rather than serving a partial stream", async () => {
    const b = bus();
    for (let i = 0; i < 700; i++) b.publish(EventKind.log, { n: i });
    const port = await boot(b);

    const msgs = await listen(`ws://127.0.0.1:${port}/ws?lastEventId=1`, 300);
    expect(msgs[0]).toMatchObject({ type: "resync", head: 700 });
    // …and it then streams from the head, so the client is live while it refetches.
    expect(msgs[1]).toMatchObject({ type: "hello", replayedFrom: 700 });
  });

  it("refuses a client speaking another protocol version", async () => {
    const b = bus();
    const port = await boot(b);
    const msgs = await listen(`ws://127.0.0.1:${port}/ws?v=99`, 300);
    expect(msgs[0]).toMatchObject({ type: "error", code: "WIRE_VERSION" });
    expect(msgs.find((m) => m.type === "hello")).toBeUndefined();
  });

  it("accepts a client that declares the current version, and says which one it speaks", async () => {
    const b = bus();
    const port = await boot(b);
    const msgs = await listen(`ws://127.0.0.1:${port}/ws?v=1`, 300);
    expect(msgs[0]).toMatchObject({ type: "hello", v: 1 });
  });

  it("drops its subscription when the socket closes", async () => {
    const b = bus();
    const port = await boot(b);
    await listen(`ws://127.0.0.1:${port}/ws`, 150);
    await new Promise((r) => setTimeout(r, 50));
    expect(() => b.publish(EventKind.log, { text: "after close" })).not.toThrow();
  });
});
