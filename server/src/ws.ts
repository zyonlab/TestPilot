// The single WS channel the UI subscribes to: workflow progress, run progress, process
// status, logs. Commands go over REST; facts come back over here.
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, type EventBus, type Envelope } from "@testpilot/harness-core";

/** How far back a reconnecting client may replay before we tell it to refetch state. */
const REPLAY_LIMIT = 500;
const PING_MS = 15_000;

type Outbound =
  | { type: "hello"; v: number; head: number; replayedFrom: number }
  | { type: "error"; code: string; message: string }
  | { type: "event"; event: Envelope }
  /** The client fell further behind than the replay window — refetch via REST, then resume. */
  | { type: "resync"; head: number; reason: string };

export function attachWs(server: Server, bus: EventBus, log: (msg: string) => void): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket: WebSocket, req) => {
    const url = new URL(req.url ?? "/ws", "http://localhost");

    // Version first: a client from another build must be told, not fed events it will
    // misread. Omitting `v` is treated as current — old clients predate the parameter.
    const clientV = url.searchParams.get("v");
    if (clientV !== null && Number(clientV) !== PROTOCOL_VERSION) {
      send(socket, {
        type: "error",
        code: "WIRE_VERSION",
        message: `this gateway speaks protocol v${PROTOCOL_VERSION}, the client asked for v${clientV}`,
      });
      socket.close(4400, "protocol version mismatch");
      return;
    }

    const raw = Number(url.searchParams.get("lastEventId"));
    const lastEventId = Number.isFinite(raw) && raw > 0 ? raw : 0;
    const head = bus.head();

    // A fresh client (no lastEventId) starts at the head: it loads current state over
    // REST and only needs what happens next. Replaying the whole log would be wrong AND slow.
    let sinceId = lastEventId || head;
    if (lastEventId && head - lastEventId > REPLAY_LIMIT) {
      send(socket, { type: "resync", head, reason: `behind by ${head - lastEventId} events` });
      sinceId = head;
    }
    send(socket, { type: "hello", v: PROTOCOL_VERSION, head, replayedFrom: sinceId });

    const sub = bus.subscribe((event) => send(socket, { type: "event", event }), {
      sinceId,
      limit: REPLAY_LIMIT,
    });

    // Liveness: a half-open TCP connection looks alive to Node but delivers nothing.
    let alive = true;
    socket.on("pong", () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, PING_MS);

    socket.on("close", () => {
      clearInterval(ping);
      sub.close();
    });
    socket.on("error", () => socket.terminate());
  });

  wss.on("error", (e) => log(`ws server error: ${e.message}`));
  return wss;
}

function send(socket: WebSocket, msg: Outbound): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}
