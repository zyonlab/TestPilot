import { create } from "zustand";
import type { EventEnvelope, LogLine, ProcStatus } from "./types";
import { connectEvents, type WsState } from "./ws";
import { API_BASE } from "./base";

/** Log tail kept in memory. Full logs live in lineage on the server, not here. */
const LOG_CAP = 400;

interface ProcsState {
  processes: ProcStatus[];
  logs: LogLine[];
  ws: WsState;
  loaded: boolean;
  error: string;

  load: () => Promise<void>;
  hydrateLogs: () => Promise<void>;
  act: (id: string, action: "start" | "stop" | "restart" | "cancel-work") => Promise<void>;
  connect: () => void;
  disconnect: () => void;
}

let close: (() => void) | null = null;

export const useProcs = create<ProcsState>((set, get) => ({
  processes: [],
  logs: [],
  ws: "closed",
  loaded: false,
  error: "",

  load: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/processes`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { processes } = (await res.json()) as { processes: ProcStatus[] };
      set({ processes, loaded: true, error: "" });
      await get().hydrateLogs();
    } catch (e) {
      set({ error: (e as Error).message, loaded: true });
    }
  },

  // The WS only carries what happens after you connect, so the tail comes from lineage.
  hydrateLogs: async () => {
    try {
      const res = await fetch(`${API_BASE}/api/events?kind=log&limit=${LOG_CAP}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const { events } = (await res.json()) as { events: EventEnvelope[] };
      const lines = events.map(toLine).filter((l): l is LogLine => l !== null);
      // Merge, not replace: events may already have streamed in while this was in flight.
      const seen = new Set(get().logs.map((l) => l.id));
      set({
        logs: [...lines.filter((l) => !seen.has(l.id)), ...get().logs]
          .sort((a, b) => a.id - b.id)
          .slice(-LOG_CAP),
      });
    } catch {
      /* the tail is a nicety — never let it break the page */
    }
  },

  act: async (id, action) => {
    try {
      const res = await fetch(`${API_BASE}/api/processes/${id}/${action}`, { method: "POST" });
      const body = (await res.json()) as { process?: ProcStatus; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      // The authoritative update still arrives as a process.status event; this just
      // keeps the button from feeling dead while that round-trips.
      if (body.process) upsert(set, get, body.process);
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  connect: () => {
    if (close) return; // one connection per tab, shared by every page
    close = connectEvents({
      onState: (ws) => set({ ws }),
      onResync: () => void get().load(),
      onProtocolMismatch: (message) => set({ error: message, ws: "closed" }),
      onEvent: (e) => handle(set, get, e),
    });
  },

  disconnect: () => {
    close?.();
    close = null;
  },
}));

type Set = (partial: Partial<ProcsState>) => void;
type Get = () => ProcsState;

function upsert(set: Set, get: Get, p: ProcStatus): void {
  const list = get().processes;
  const i = list.findIndex((x) => x.id === p.id);
  set({ processes: i === -1 ? [...list, p] : list.map((x, j) => (j === i ? p : x)) });
}

function toLine(e: EventEnvelope): LogLine | null {
  const p = e.payload as { stream?: string; text?: string };
  const processId = e.scope.processId;
  if (!processId || !p?.text) return null;
  return { id: e.id, ts: e.ts, processId, stream: p.stream ?? "stdout", text: p.text };
}

function handle(set: Set, get: Get, e: EventEnvelope): void {
  if (e.kind === "process.status") {
    upsert(set, get, e.payload as ProcStatus);
    return;
  }
  if (e.kind === "log") {
    const line = toLine(e);
    if (line) set({ logs: [...get().logs, line].slice(-LOG_CAP) });
  }
}
