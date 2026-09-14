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
  /**
   * Drop all but the newest `keepLast` rows. Returns how many were removed.
   *
   * `protectRuns` 里的那些运行**一行都不删**，不管它们排在多老的位置。
   * 保留窗口是按条数算的（一个忙碌的小时比一个安静的星期产生更多行），
   * 而一次跑三天的运行会在自己还没跑完的时候被挤出窗口——
   * 于是**运行还没读完，证据先没了**。正在跑的那些不该参与这场淘汰。
   */
  prune(keepLast: number, protectRuns?: string[]): number;
  /**
   * 按 kind 单独裁。
   *
   * 血缘和日志挤在同一张表里，而日志赢了：实测 200,014 行里 `log` 占 74.3%、
   * `process.status` 占 20.2%，**真正的工作流血缘只占 1.47%**——
   * 而这张表是「一次运行发生了什么」的唯一记录。按总条数裁没有用：
   * 一个吵闹的子进程会把血缘挤出去，而且是先挤出去最老的那些，也就是**上一次运行的全部**。
   *
   * 所以吵的那几类各自设一个小得多的窗口，剩下的照旧走 `prune`。
   */
  pruneKind?(kind: string, keepLast: number, protectRuns?: string[]): number;
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
  prune(keepLast: number, protectRuns: string[] = []): number {
    const keep = new Set(protectRuns);
    const drop = Math.max(0, this.rows.length - keepLast);
    if (!drop) return 0;
    let removed = 0;
    // 从最老的往下删，但跳过受保护的那些——它们留在原地，不占淘汰名额。
    const next: Envelope[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const runId = (row.scope as { wfRunId?: string }).wfRunId;
      if (removed < drop && !(runId && keep.has(runId))) {
        removed += 1;
        continue;
      }
      next.push(row);
    }
    this.rows = next;
    return removed;
  }
  pruneKind(kind: string, keepLast: number, protectRuns: string[] = []): number {
    const keep = new Set(protectRuns);
    const ofKind = this.rows.filter((r) => r.kind === kind);
    const drop = Math.max(0, ofKind.length - keepLast);
    if (!drop) return 0;
    const doomed = new Set<number>();
    let n = 0;
    for (const r of ofKind) {
      if (n >= drop) break;
      const runId = (r.scope as { wfRunId?: string }).wfRunId;
      if (runId && keep.has(runId)) continue;
      doomed.add(r.id);
      n += 1;
    }
    this.rows = this.rows.filter((r) => !doomed.has(r.id));
    return n;
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
      -- 按运行取事件必须走索引，不能靠"先取一万条再在内存里筛"：
      -- 那样做的结果是 slice(-1000) 永远拿到最旧一万条里的最后一千条，
      -- 于是历史运行的轨迹**永远是空的**，而界面把它说成"这次运行还没有留下轨迹"。
      CREATE INDEX IF NOT EXISTS events_run ON events(json_extract(scopeJson, '$.wfRunId'), id);
    `);
  }

  /**
   * 一次运行的事件，按 id 升序。
   *
   * 这是 `since` 的按运行版本：筛选发生在 SQL 里，所以"最近的一千条"真的是最近的。
   * `since` 那条路上，调用方拿到的是**最旧的一批**——两者的差别不是性能，是对错。
   */
  byRun(wfRunId: string, sinceId = 0, limit = 2000): Envelope[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE json_extract(scopeJson, '$.wfRunId') = ? AND id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(wfRunId, sinceId, limit) as Array<{
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

  /**
   * 这次运行一共有多少条事件。
   *
   * `byRun` 有上限，而**被截断却不说，就是又一次"报告看起来完全正常"**——
   * 调用方拿它和拿到的条数比一下，就知道要不要接着往下取。
   */
  countByRun(wfRunId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE json_extract(scopeJson, '$.wfRunId') = ?")
      .get(wfRunId) as { n: number };
    return row.n;
  }

  /** 最近 N 条（不按运行）。取"最新"要 DESC + 反转，而不是取最旧一批再切尾。 */
  latest(limit = 200): Envelope[] {
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{ id: number; ts: string; kind: string; scopeJson: string; payloadJson: string }>;
    return rows
      .map((r) => ({
        v: PROTOCOL_VERSION,
        id: r.id,
        ts: r.ts,
        kind: r.kind,
        scope: JSON.parse(r.scopeJson) as Scope,
        payload: JSON.parse(r.payloadJson) as unknown,
      }))
      .reverse();
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

  prune(keepLast: number, protectRuns: string[] = []): number {
    /*
     * 没跑完的运行，一行都不删。
     *
     * 保留窗口按条数算，而一次跑三天的运行会在自己还没跑完的时候被挤出去——
     * 那时候「这次运行到底发生了什么」这个问题永远失去了答案，
     * 而界面上看不出任何异常：轨迹只是空的。
     */
    if (!protectRuns.length) {
      const info = this.db
        .prepare("DELETE FROM events WHERE id <= (SELECT COALESCE(MAX(id),0) - ? FROM events)")
        .run(keepLast);
      return info.changes;
    }
    const holes = protectRuns.map(() => "?").join(",");
    const info = this.db
      .prepare(
        `DELETE FROM events
         WHERE id <= (SELECT COALESCE(MAX(id),0) - ? FROM events)
           AND COALESCE(json_extract(scopeJson,'$.wfRunId'), '') NOT IN (${holes})`,
      )
      .run(keepLast, ...protectRuns);
    return info.changes;
  }

  pruneKind(kind: string, keepLast: number, protectRuns: string[] = []): number {
    const holes = protectRuns.length ? protectRuns.map(() => "?").join(",") : "";
    const guard = holes ? ` AND COALESCE(json_extract(scopeJson,'$.wfRunId'), '') NOT IN (${holes})` : "";
    const info = this.db
      .prepare(
        `DELETE FROM events
         WHERE kind = ?
           AND id <= (SELECT COALESCE(MAX(id),0) - ? FROM events WHERE kind = ?)${guard}`,
      )
      .run(kind, keepLast, kind, ...protectRuns);
    return info.changes;
  }

  close(): void {
    this.db.close();
  }
}
