import type { EventEnvelope } from "./types";
import { WS_URL } from "./base";

// The single event connection. Commands go over REST (lib/api); every fact — workflow
// progress, run progress, process status, logs — arrives here.
//
// Two things this has to get right, both of them about reconnects:
//   * resume from `lastEventId` so a dropped connection doesn't lose events, and
//   * accept a `resync` when we fell further behind than the server's replay window —
//     in that case the client refetches state over REST instead of pretending it is caught up.

/** Protocol version this build speaks; the gateway refuses anything else (docs/spec/06 §7). */
const PROTOCOL_VERSION = 1;

export type WsState = "connecting" | "open" | "closed";

interface Handlers {
  onEvent: (e: EventEnvelope) => void;
  onState?: (s: WsState) => void;
  /** Server told us we are too far behind: reload state from REST, then keep streaming. */
  onResync?: () => void;
  /** The gateway speaks another protocol version — stop reconnecting and say so. */
  onProtocolMismatch?: (message: string) => void;
}

type Inbound =
  | { type: "hello"; v: number; head: number; replayedFrom: number }
  | { type: "event"; event: EventEnvelope }
  | { type: "resync"; head: number; reason: string }
  | { type: "error"; code: string; message: string };

export function connectEvents(h: Handlers): () => void {
  let socket: WebSocket | null = null;
  let closedByUs = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let lastEventId = 0;

  const open = () => {
    h.onState?.("connecting");
    const url = `${WS_URL}?v=${PROTOCOL_VERSION}${lastEventId ? `&lastEventId=${lastEventId}` : ""}`;
    const ws = new WebSocket(url);
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      h.onState?.("open");
    };
    ws.onmessage = (ev) => {
      let msg: Inbound;
      try {
        msg = JSON.parse(String(ev.data)) as Inbound;
      } catch {
        return; // a malformed frame is not worth tearing the connection down for
      }
      if (msg.type === "event") {
        lastEventId = Math.max(lastEventId, msg.event.id);
        h.onEvent(msg.event);
      } else if (msg.type === "resync") {
        lastEventId = msg.head;
        h.onResync?.();
      } else if (msg.type === "error" && msg.code === "WIRE_VERSION") {
        // Reconnecting would loop forever against a gateway we cannot talk to.
        closedByUs = true;
        h.onProtocolMismatch?.(msg.message);
      }
    };
    ws.onclose = () => {
      h.onState?.("closed");
      if (closedByUs) return;
      // Backoff, capped: the gateway restarting shouldn't turn into a reconnect storm.
      const delay = Math.min(10_000, 500 * 2 ** attempt++);
      retry = setTimeout(open, delay);
    };
    ws.onerror = () => ws.close();
  };

  open();
  return () => {
    closedByUs = true;
    if (retry) clearTimeout(retry);
    socket?.close();
  };
}
