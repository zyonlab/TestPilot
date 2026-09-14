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

  constructor(path: string | Database.Database) {
    if (typeof path === "string" && path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = typeof path === "string" ? new Database(path) : path;
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
    this.countsMemo = undefined;
  }

  async all(wfRunId: string): Promise<Record<string, unknown>> {
    const rows = this.db
      .prepare("SELECT nodeId, json FROM wf_node_outputs WHERE wfRunId=?")
      .all(wfRunId) as Array<{ nodeId: string; json: string }>;
    return Object.fromEntries(rows.map((r) => [r.nodeId, JSON.parse(r.json) as unknown]));
  }

  /**
   * 每次运行有多少用例 / 多少段代码——**在库里数，不把产物读出来**。
   *
   * 2026-09-12 实测：项目总览为了这两个数字，把每个项目每一次运行的全部产物都读出来解析一遍。
   * 一天跑了 30 多次之后 `/api/projects` 要 27 秒，前端直接超时，界面上写「项目列表加载失败」。
   * 同一批用例会出现在好几个节点的产物里（gate 拿到的就是 design 那一批），所以取最大值不是求和。
   */
  async countsByRun(): Promise<Record<string, { cases: number; code: number }>> {
    // 写产物时失效（见 set）。扫的是整张表，而表里装的是整份 gate bundle——
    // 不记住的话每次总览都要把它们重新 json_extract 一遍（实测 2.9 秒）。
    if (this.countsMemo) return this.countsMemo;
    const rows = this.db.prepare(
      `SELECT wfRunId,
              MAX(COALESCE(json_array_length(json_extract(json, '$.cases')), 0)) AS cases,
              MAX(COALESCE(json_array_length(json_extract(json, '$.code')), 0))  AS code
         FROM wf_node_outputs GROUP BY wfRunId`,
    ).all() as Array<{ wfRunId: string; cases: number; code: number }>;
    this.countsMemo = Object.fromEntries(rows.map((r) => [r.wfRunId, { cases: r.cases, code: r.code }]));
    return this.countsMemo;
  }
  private countsMemo?: Record<string, { cases: number; code: number }>;

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
      /*
       * 列表要的三样：**为哪个项目跑的、打的是哪里、上限用掉多少**。
       *
       * 三样都在 detail 里，而 detail 就是这一行的 json 列——在这儿顺手取出来，
       * 是因为调用方否则要为每一行再发一次详情请求，去拿一个列表本来就要按它排序的事实。
       */
      let extra: Record<string, unknown> = {};
      try {
        const detail = JSON.parse(json ?? "{}") as {
          target?: { projectId?: string };
          targetSnapshot?: { describe?: string; envName?: string };
          budget?: Record<string, number>;
          spend?: Record<string, number>;
          requestedOverrides?: Record<string, unknown>;
          ablate?: string[];
        };
        extra = {
          ...(detail.target?.projectId ? { projectId: detail.target.projectId } : {}),
          ...(detail.targetSnapshot?.describe ? { describe: detail.targetSnapshot.describe } : {}),
          ...(detail.targetSnapshot?.envName ? { envName: detail.targetSnapshot.envName } : {}),
          ...(detail.budget && Object.keys(detail.budget).length ? { budget: detail.budget } : {}),
          ...(detail.spend ? { spend: detail.spend } : {}),
          /*
           * 这次运行动过参数或关掉过组件——**它不是这张图的基线成绩**。
           * 不标出来，一次「把 repair.limit 调到 3」的试跑会和正经运行并排躺在列表里，
           * 而两个月后没人分得出哪个是哪个。
           */
          ...(detail.requestedOverrides && Object.keys(detail.requestedOverrides).length
            ? { overridden: Object.keys(detail.requestedOverrides) }
            : {}),
          ...(detail.ablate?.length ? { ablated: detail.ablate } : {}),
        };
      } catch {
        /* a run whose detail cannot be parsed is still a run; it just has no project */
      }
      return { ...row, ...extra };
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
