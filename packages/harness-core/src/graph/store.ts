import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { OutputStore } from "./runtime.js";
import type { GraphDef } from "./graph.js";

/**
 * Node outputs on disk.
 *
 * Two things depend on these surviving a restart: "run only this node" (which reads its
 * upstream's last output rather than recomputing a chain that cost minutes of model time),
 * and the canvas (clicking a node shows what it produced). Keeping them in memory would
 * mean a gateway restart quietly turns both into "run everything again".
 */
export class SqliteOutputStore implements OutputStore {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wf_node_outputs (
        wfRunId TEXT NOT NULL,
        nodeId TEXT NOT NULL,
        json TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (wfRunId, nodeId)
      );
      CREATE TABLE IF NOT EXISTS wf_runs (
        id TEXT PRIMARY KEY,
        graphId TEXT NOT NULL,
        graphVersion INTEGER NOT NULL,
        status TEXT NOT NULL,
        startedAt TEXT NOT NULL,
        finishedAt TEXT,
        json TEXT NOT NULL
      );
    `);
  }

  async get(wfRunId: string, nodeId: string): Promise<unknown | undefined> {
    const row = this.db
      .prepare("SELECT json FROM wf_node_outputs WHERE wfRunId=? AND nodeId=?")
      .get(wfRunId, nodeId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as unknown) : undefined;
  }

  async set(wfRunId: string, nodeId: string, value: unknown): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO wf_node_outputs (wfRunId, nodeId, json, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(wfRunId, nodeId) DO UPDATE SET json=excluded.json, updatedAt=excluded.updatedAt`,
      )
      .run(wfRunId, nodeId, JSON.stringify(value ?? null), new Date().toISOString());
  }

  async all(wfRunId: string): Promise<Record<string, unknown>> {
    const rows = this.db
      .prepare("SELECT nodeId, json FROM wf_node_outputs WHERE wfRunId=?")
      .all(wfRunId) as Array<{ nodeId: string; json: string }>;
    return Object.fromEntries(rows.map((r) => [r.nodeId, JSON.parse(r.json) as unknown]));
  }

  /** Run-level bookkeeping, so the UI can list past runs without replaying lineage. */
  saveRun(run: {
    id: string;
    graphId: string;
    graphVersion: number;
    status: string;
    startedAt: string;
    finishedAt?: string;
    detail: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO wf_runs (id, graphId, graphVersion, status, startedAt, finishedAt, json)
         VALUES (@id, @graphId, @graphVersion, @status, @startedAt, @finishedAt, @json)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, finishedAt=excluded.finishedAt, json=excluded.json`,
      )
      .run({ ...run, finishedAt: run.finishedAt ?? null, json: JSON.stringify(run.detail ?? null) });
  }

  /**
   * Recent runs, each carrying the project it was started for.
   *
   * The project lives inside the run's stored detail, so a caller that wanted to group runs
   * by project had to fetch every run in full to find out. That is one request per row for
   * a fact the list is expected to sort by.
   */
  listRuns(limit = 50): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare("SELECT id, graphId, graphVersion, status, startedAt, finishedAt, json FROM wf_runs ORDER BY startedAt DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown> & { json?: string }>;
    return rows.map(({ json, ...row }) => {
      let projectId: string | undefined;
      try {
        projectId = (JSON.parse(json ?? "{}") as { target?: { projectId?: string } }).target?.projectId;
      } catch {
        /* a run whose detail cannot be parsed is still a run; it just has no project */
      }
      return projectId ? { ...row, projectId } : row;
    });
  }

  getRun(id: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT * FROM wf_runs WHERE id=?").get(id) as
      | { json: string; [k: string]: unknown }
      | undefined;
    return row ? { ...row, detail: JSON.parse(row.json) as unknown } : undefined;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Every version of every graph, kept.
 *
 * A run pins the version it used; without the definitions, that pin points at a number and
 * not at a shape. Saving is append-only for the same reason a run's outputs are: rewriting
 * history would let today's edit quietly change what yesterday's result meant.
 */
export class SqliteGraphStore {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_versions (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        json TEXT NOT NULL,
        savedAt TEXT NOT NULL,
        note TEXT,
        PRIMARY KEY (id, version)
      );
    `);
  }

  save(def: GraphDef, note?: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO graph_versions (id, version, json, savedAt, note) VALUES (?,?,?,?,?)")
      .run(def.id, def.version, JSON.stringify(def), new Date().toISOString(), note ?? null);
  }

  get(id: string, version: number): GraphDef | undefined {
    const row = this.db
      .prepare("SELECT json FROM graph_versions WHERE id=? AND version=?")
      .get(id, version) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as GraphDef) : undefined;
  }

  /** Newest first, without the definitions: a picker needs the list, not the payloads. */
  versions(id: string): Array<{ version: number; savedAt: string; note?: string }> {
    return this.db
      .prepare("SELECT version, savedAt, note FROM graph_versions WHERE id=? ORDER BY version DESC")
      .all(id) as Array<{ version: number; savedAt: string; note?: string }>;
  }

  latest(id: string): GraphDef | undefined {
    const row = this.db
      .prepare("SELECT json FROM graph_versions WHERE id=? ORDER BY version DESC LIMIT 1")
      .get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as GraphDef) : undefined;
  }

  /** Every graph that has at least one saved version, at its newest. */
  all(): GraphDef[] {
    const rows = this.db
      .prepare(
        "SELECT json FROM graph_versions WHERE (id, version) IN (SELECT id, MAX(version) FROM graph_versions GROUP BY id)",
      )
      .all() as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as GraphDef);
  }
}
