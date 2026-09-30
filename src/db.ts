import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { NetworkData, VariableInput } from "./network.js";

export interface VariableRow {
  id: string;
  network_id: string;
  version: number;
  states: string[];
  parents: string[];
  rows: { parentStates: (string | null)[]; probs: number[] }[];
  seq: number;
}

const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS networks (
  network_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (network_id, version)
);
CREATE TABLE IF NOT EXISTS variables (
  network_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  var_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  states TEXT NOT NULL,
  parents TEXT NOT NULL,
  rows TEXT NOT NULL,
  PRIMARY KEY (network_id, version, var_id)
);
CREATE TABLE IF NOT EXISTS evidence_sets (
  evidence_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  observations TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS query_plans (
  query_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  evidence_id TEXT,
  query_vars TEXT NOT NULL,
  ordering TEXT NOT NULL,
  max_factor_rows INTEGER NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (network_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS frozen_results (
  query_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  FOREIGN KEY (query_id) REFERENCES query_plans(query_id)
);
CREATE TABLE IF NOT EXISTS operations_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  network_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_net ON evidence_sets(network_id, version);
CREATE INDEX IF NOT EXISTS idx_queries_net ON query_plans(network_id, version);
`,
  },
];

export class BayesStore {
  readonly db: DatabaseSync;

  constructor(path: string, now: () => string = () => new Date().toISOString()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.now = now;
    this.migrate();
  }

  private now: () => string;

  migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const appliedRows = this.db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[];
    const applied = new Set(appliedRows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (!applied.has(m.id)) {
        this.db.exec(m.sql);
        this.db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, this.now());
      }
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  log(networkId: string | null, action: string, detail: unknown): void {
    this.db
      .prepare("INSERT INTO operations_log (network_id, action, detail, created_at) VALUES (?, ?, ?, ?)")
      .run(networkId, action, JSON.stringify(detail), this.now());
  }

  latestVersion(networkId: string): number | null {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM networks WHERE network_id = ? AND archived = 0")
      .get(networkId) as { v: number | null } | undefined;
    return row?.v ?? null;
  }

  saveNetwork(data: NetworkData, name: string, description: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO networks (network_id, version, name, description, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(data.networkId, data.version, name, description, this.now());
      const stmt = this.db.prepare(
        `INSERT INTO variables (network_id, version, var_id, seq, states, parents, rows)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      data.variables.forEach((v, i) => {
        stmt.run(
          data.networkId,
          data.version,
          v.id,
          i,
          JSON.stringify(v.states),
          JSON.stringify(v.cpt.parents),
          JSON.stringify(v.cpt.rows),
        );
      });
      this.log(data.networkId, "network_saved", { version: data.version, vars: data.variables.length });
    });
  }

  loadNetwork(networkId: string, version?: number): { name: string; description: string; data: NetworkData } {
    const ver = version ?? this.latestVersion(networkId);
    if (ver === null) throw Object.assign(new Error("网络不存在"), { code: "NOT_FOUND" });
    const net = this.db
      .prepare("SELECT name, description FROM networks WHERE network_id = ? AND version = ?")
      .get(networkId, ver) as { name: string; description: string } | undefined;
    if (!net) throw Object.assign(new Error("网络版本不存在"), { code: "NOT_FOUND" });
    const rows = this.db
      .prepare(
        "SELECT var_id, seq, states, parents, rows FROM variables WHERE network_id=? AND version=? ORDER BY seq",
      )
      .all(networkId, ver) as {
      var_id: string;
      seq: number;
      states: string;
      parents: string;
      rows: string;
    }[];
    const variables: VariableInput[] = rows.map((r) => ({
      id: r.var_id,
      states: JSON.parse(r.states),
      cpt: { parents: JSON.parse(r.parents), rows: JSON.parse(r.rows) },
    }));
    return {
      name: net.name,
      description: net.description,
      data: { networkId, version: ver, variables },
    };
  }

  listNetworks(limit: number, offset: number): { items: { network_id: string; version: number; name: string }[]; total: number } {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM networks").get() as { c: number }).c;
    const items = this.db
      .prepare(
        `SELECT n.network_id, n.version, n.name FROM networks n
         INNER JOIN (SELECT network_id, MAX(version) AS mv FROM networks WHERE archived=0 GROUP BY network_id) m
         ON n.network_id=m.network_id AND n.version=m.mv
         ORDER BY n.network_id LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as { network_id: string; version: number; name: string }[];
    return { items, total };
  }

  listVersions(networkId: string): { version: number; name: string; created_at: string }[] {
    return this.db
      .prepare("SELECT version, name, created_at FROM networks WHERE network_id=? ORDER BY version")
      .all(networkId) as { version: number; name: string; created_at: string }[];
  }

  saveEvidence(evidenceId: string, networkId: string, version: number, observations: Record<string, string>): boolean {
    const existing = this.db.prepare("SELECT evidence_id FROM evidence_sets WHERE evidence_id=?").get(evidenceId);
    if (existing) return false;
    this.db
      .prepare(
        "INSERT INTO evidence_sets (evidence_id, network_id, version, observations, created_at) VALUES (?,?,?,?,?)",
      )
      .run(evidenceId, networkId, version, JSON.stringify(observations), this.now());
    this.log(networkId, "evidence_saved", { evidenceId });
    return true;
  }

  getEvidence(evidenceId: string): { network_id: string; version: number; observations: Record<string, string> } | null {
    const row = this.db
      .prepare("SELECT network_id, version, observations FROM evidence_sets WHERE evidence_id=?")
      .get(evidenceId) as { network_id: string; version: number; observations: string } | undefined;
    return row ? { network_id: row.network_id, version: row.version, observations: JSON.parse(row.observations) } : null;
  }

  saveQueryPlan(plan: {
    queryId: string;
    networkId: string;
    version: number;
    evidenceId: string | null;
    queryVars: string[];
    ordering: string;
    maxFactorRows: number;
    idempotencyKey: string | null;
  }): boolean {
    const existing = this.db
      .prepare("SELECT query_id FROM query_plans WHERE idempotency_key=? AND network_id=?")
      .get(plan.idempotencyKey, plan.networkId);
    if (existing) return false;
    this.db
      .prepare(
        `INSERT INTO query_plans (query_id, network_id, version, evidence_id, query_vars, ordering, max_factor_rows, idempotency_key, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        plan.queryId,
        plan.networkId,
        plan.version,
        plan.evidenceId,
        JSON.stringify(plan.queryVars),
        plan.ordering,
        plan.maxFactorRows,
        plan.idempotencyKey,
        this.now(),
      );
    this.log(plan.networkId, "query_planned", { queryId: plan.queryId });
    return true;
  }

  freezeResult(queryId: string, networkId: string, version: number, result: unknown): void {
    this.db
      .prepare("INSERT INTO frozen_results (query_id, network_id, version, result_json, frozen_at) VALUES (?,?,?,?,?)")
      .run(queryId, networkId, version, JSON.stringify(result), this.now());
  }

  getFrozenResult(queryId: string): unknown | null {
    const row = this.db.prepare("SELECT result_json FROM frozen_results WHERE query_id=?").get(queryId) as
      | { result_json: string }
      | undefined;
    return row ? JSON.parse(row.result_json) : null;
  }

  getQueryByIdempotency(networkId: string, key: string): { query_id: string } | null {
    const row = this.db
      .prepare("SELECT query_id FROM query_plans WHERE network_id=? AND idempotency_key=?")
      .get(networkId, key) as { query_id: string } | undefined;
    return row ?? null;
  }

  listFrozen(networkId: string, limit: number, offset: number): { items: unknown[]; total: number } {
    const total = (
      this.db.prepare("SELECT COUNT(*) AS c FROM frozen_results WHERE network_id=?").get(networkId) as {
        c: number;
      }
    ).c;
    const rows = this.db
      .prepare(
        "SELECT query_id, version, result_json, frozen_at FROM frozen_results WHERE network_id=? ORDER BY frozen_at DESC LIMIT ? OFFSET ?",
      )
      .all(networkId, limit, offset) as { query_id: string; version: number; result_json: string; frozen_at: string }[];
    return {
      items: rows.map((r) => ({
        queryId: r.query_id,
        version: r.version,
        frozenAt: r.frozen_at,
        result: JSON.parse(r.result_json),
      })),
      total,
    };
  }

  close(): void {
    this.db.close();
  }
}
