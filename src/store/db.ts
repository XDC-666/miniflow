import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RunRecord, Workflow } from "../engine/types.js";

interface WorkflowRow {
  id: string;
  name: string;
  definition: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  workflow_id: string;
  record: string;
  created_at: string;
}

export class Store {
  private readonly db: Database.Database;

  constructor(file: string) {
    const path = resolve(file);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        definition TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id          TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        record      TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runs_workflow
        ON runs(workflow_id, created_at DESC);
    `);
  }

  // ---------- 工作流 ----------

  listWorkflows(): Workflow[] {
    const rows = this.db
      .prepare(`SELECT * FROM workflows ORDER BY updated_at DESC`)
      .all() as WorkflowRow[];
    return rows.map((row) => this.toWorkflow(row));
  }

  getWorkflow(id: string): Workflow | null {
    const row = this.db
      .prepare(`SELECT * FROM workflows WHERE id = ?`)
      .get(id) as WorkflowRow | undefined;
    return row ? this.toWorkflow(row) : null;
  }

  createWorkflow(definition: Workflow): Workflow {
    const id = definition.id || `wf_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const record: Workflow = { ...definition, id };
    this.db
      .prepare(
        `INSERT INTO workflows (id, name, definition, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        record.name,
        JSON.stringify(record),
        record.enabled ? 1 : 0,
        now,
        now,
      );
    return record;
  }

  updateWorkflow(id: string, definition: Workflow): Workflow | null {
    if (!this.getWorkflow(id)) return null;
    const record: Workflow = { ...definition, id };
    this.db
      .prepare(
        `UPDATE workflows SET name = ?, definition = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        record.name,
        JSON.stringify(record),
        record.enabled ? 1 : 0,
        new Date().toISOString(),
        id,
      );
    return record;
  }

  deleteWorkflow(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM workflows WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM runs WHERE workflow_id = ?`).run(id);
    return result.changes > 0;
  }

  // ---------- 运行记录 ----------

  saveRun(record: RunRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO runs (id, workflow_id, record, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(record.id, record.workflowId, JSON.stringify(record), record.startedAt);
  }

  listRuns(workflowId?: string, limit = 50): RunRecord[] {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const rows = workflowId
      ? (this.db
          .prepare(
            `SELECT * FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(workflowId, safeLimit) as RunRow[])
      : (this.db
          .prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`)
          .all(safeLimit) as RunRow[]);
    return rows.map((row) => JSON.parse(row.record) as RunRecord);
  }

  getRun(id: string): RunRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE id = ?`)
      .get(id) as RunRow | undefined;
    return row ? (JSON.parse(row.record) as RunRecord) : null;
  }

  /** 清空运行记录；传 workflowId 则只清该工作流的 */
  clearRuns(workflowId?: string): number {
    const result = workflowId
      ? this.db.prepare(`DELETE FROM runs WHERE workflow_id = ?`).run(workflowId)
      : this.db.prepare(`DELETE FROM runs`).run();
    return result.changes;
  }

  /**
   * 保留每个工作流最近 keep 条运行记录，其余删除。
   * 长期运行时 runs 表会持续增长（每条含完整节点输入输出），需要能定期瘦身。
   */
  pruneRuns(keep: number, workflowId?: string): number {
    const limit = Math.max(1, Math.floor(keep) || 1);
    const rows = workflowId
      ? (this.db
          .prepare(
            `SELECT id FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
          )
          .all(workflowId, limit) as { id: string }[])
      : (this.db
          .prepare(`SELECT id FROM runs ORDER BY created_at DESC LIMIT -1 OFFSET ?`)
          .all(limit) as { id: string }[]);

    if (rows.length === 0) return 0;
    const del = this.db.prepare(`DELETE FROM runs WHERE id = ?`);
    let removed = 0;
    for (const { id } of rows) removed += del.run(id).changes;
    return removed;
  }

  close(): void {
    this.db.close();
  }

  private toWorkflow(row: WorkflowRow): Workflow {
    const parsed = JSON.parse(row.definition) as Workflow;
    return { ...parsed, id: row.id, enabled: row.enabled === 1 };
  }
}
