import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { PROTOCOL_VERSION, type Envelope, type Scope } from "./envelope.js";

/** What the bus needs from a backing store. Two impls: memory (tests) and sqlite (real). */
export interface EventStore {
  /** Assigns the monotonic id and persists. Returns the completed envelope. */
  append(e: { ts: string; kind: string; scope: Scope; payload: unknown }): Envelope;
  /** Everything strictly AFTER `id`, oldest first. `limit` caps a resync burst. */
  since(id: number, limit?: number): Envelope[];
  /** Highest id currently stored (0 when empty). */
  head(): number;
  /** Drop all but the newest `keepLast` rows. Returns how many were removed. */
  prune(keepLast: number): number;
  close(): void;
}

export class MemoryEventStore implements EventStore {
  private rows: Envelope[] = [];
  private nextId = 1;

  append(e: { ts: string; kind: string; scope: Scope; payload: unknown }): Envelope {
    const env: Envelope = { v: PROTOCOL_VERSION, id: this.nextId++, ...e };
    this.rows.push(env);
    return env;
  }
  since(id: number, limit = 1000): Envelope[] {
    return this.rows.filter((r) => r.id > id).slice(0, limit);
  }
  head(): number {
    return this.rows.length ? this.rows[this.rows.length - 1].id : 0;
  }
  prune(keepLast: number): number {
    const drop = Math.max(0, this.rows.length - keepLast);
    this.rows.splice(0, drop);
    return drop;
  }
  close(): void {
    /* nothing to release */
  }
}

/**
 * The durable one. This table IS the lineage: node inputs/outputs, prompts, costs and
 * process transitions all land here, which is what makes `replay` and paired evaluation
 * possible later. Ids come from AUTOINCREMENT so they stay monotonic across restarts
 * even after pruning (plain rowid reuse would break resume-from-lastEventId).
 */
export class SqliteEventStore implements EventStore {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        scopeJson TEXT NOT NULL,
        payloadJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_kind ON events(kind);
    `);
  }

  append(e: { ts: string; kind: string; scope: Scope; payload: unknown }): Envelope {
    const info = this.db
      .prepare("INSERT INTO events (ts, kind, scopeJson, payloadJson) VALUES (?, ?, ?, ?)")
      .run(e.ts, e.kind, JSON.stringify(e.scope), JSON.stringify(e.payload ?? null));
    return { v: PROTOCOL_VERSION, id: Number(info.lastInsertRowid), ...e };
  }

  since(id: number, limit = 1000): Envelope[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(id, limit) as Array<{
      id: number;
      ts: string;
      kind: string;
      scopeJson: string;
      payloadJson: string;
    }>;
    return rows.map((r) => ({
      v: PROTOCOL_VERSION,
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      scope: JSON.parse(r.scopeJson) as Scope,
      payload: JSON.parse(r.payloadJson) as unknown,
    }));
  }

  head(): number {
    const row = this.db.prepare("SELECT MAX(id) AS m FROM events").get() as { m: number | null };
    return row.m ?? 0;
  }

  prune(keepLast: number): number {
    const info = this.db
      .prepare(
        "DELETE FROM events WHERE id <= (SELECT COALESCE(MAX(id),0) - ? FROM events)",
      )
      .run(keepLast);
    return info.changes;
  }

  close(): void {
    this.db.close();
  }
}
