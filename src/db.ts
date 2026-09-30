import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 1;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS networks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    version INTEGER NOT NULL,
    parent_version_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS evidence_sets (
    id TEXT PRIMARY KEY,
    network_id TEXT NOT NULL,
    name TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(network_id, name)
  );

  CREATE TABLE IF NOT EXISTS query_plans (
    id TEXT PRIMARY KEY,
    network_id TEXT NOT NULL,
    name TEXT NOT NULL,
    variables_json TEXT NOT NULL,
    evidence_id TEXT,
    ordering_json TEXT,
    factor_cell_budget INTEGER,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(network_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS query_results (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    network_id TEXT NOT NULL,
    network_version INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(plan_id)
  );
  `
];

export function openDatabase(filePath: string): DatabaseSync {
  if (filePath !== ":memory:") {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(MIGRATIONS[0]!);
  db.prepare(
    `INSERT INTO schema_meta(key, value) VALUES('version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(SCHEMA_VERSION));
}

export function closeDatabase(db: DatabaseSync): void {
  db.close();
}
