import type { DatabaseSync } from "node:sqlite";
import { AppError } from "./errors.js";
import type {
  Evidence,
  NetworkSpec,
  Page,
  QueryPlanInput
} from "./types.js";

export interface NetworkRecord {
  id: string;
  name: string;
  spec: NetworkSpec;
  version: number;
  parentVersionId: string | null;
  status: "draft" | "active" | "archived";
  createdAt: string;
}

export interface EvidenceRecord {
  id: string;
  networkId: string;
  name: string;
  evidence: Evidence;
  createdAt: string;
}

export interface PlanRecord {
  id: string;
  networkId: string;
  name: string;
  variables: string[];
  evidenceId: string | null;
  ordering: string[] | "min-fill" | "min-degree" | null;
  factorCellBudget: number | null;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface ResultRecord {
  id: string;
  planId: string;
  networkId: string;
  networkVersion: number;
  result: unknown;
  status: "frozen" | "error";
  createdAt: string;
}

export interface Clock {
  now(): Date;
  randomId(): string;
}

export function systemClock(): Clock {
  return {
    now: () => new Date(),
    randomId: () =>
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  };
}

function mapNetwork(row: Record<string, unknown>): NetworkRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    spec: JSON.parse(row.spec_json as string) as NetworkSpec,
    version: Number(row.version),
    parentVersionId: (row.parent_version_id as string | null) ?? null,
    status: row.status as NetworkRecord["status"],
    createdAt: row.created_at as string
  };
}

export class Repository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock()
  ) {}

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  insertNetwork(input: {
    id?: string;
    name: string;
    spec: NetworkSpec;
    parentVersionId?: string | null;
    status?: NetworkRecord["status"];
    version?: number;
  }): NetworkRecord {
    const id = input.id ?? this.clock.randomId();
    const createdAt = this.clock.now().toISOString();
    const version = input.version ?? 1;
    const status = input.status ?? "draft";
    try {
      this.db
        .prepare(
          `INSERT INTO networks(id, name, spec_json, version, parent_version_id, status, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.name,
          JSON.stringify(input.spec),
          version,
          input.parentVersionId ?? null,
          status,
          createdAt
        );
    } catch (error) {
      throw mapSqliteError(error, "network", id);
    }
    return this.getNetwork(id)!;
  }

  setNetworkStatus(id: string, status: NetworkRecord["status"]): void {
    const result = this.db
      .prepare("UPDATE networks SET status = ? WHERE id = ?")
      .run(status, id);
    if (Number(result.changes) === 0) {
      throw new AppError("NOT_FOUND", `Network '${id}' not found.`);
    }
  }

  getNetwork(id: string): NetworkRecord | null {
    const row = this.db
      .prepare("SELECT * FROM networks WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapNetwork(row) : null;
  }

  requireNetwork(id: string): NetworkRecord {
    const record = this.getNetwork(id);
    if (!record) throw new AppError("NOT_FOUND", `Network '${id}' not found.`);
    return record;
  }

  listNetworks(page: { limit: number; offset: number }): Page<NetworkRecord> {
    const total = Number(
      (this.db.prepare("SELECT COUNT(*) AS c FROM networks").get() as Record<string, unknown>)
        .c
    );
    const rows = this.db
      .prepare(
        "SELECT * FROM networks ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?"
      )
      .all(page.limit, page.offset) as Record<string, unknown>[];
    return { items: rows.map(mapNetwork), total, limit: page.limit, offset: page.offset };
  }

  listNetworkVersions(
    networkId: string,
    page: { limit: number; offset: number }
  ): Page<NetworkRecord> {
    const total = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS c FROM networks WHERE id = ? OR parent_version_id = ?")
          .get(networkId, networkId) as Record<string, unknown>
      ).c
    );
    const rows = this.db
      .prepare(
        `SELECT * FROM networks
         WHERE id = ? OR parent_version_id = ?
         ORDER BY version ASC LIMIT ? OFFSET ?`
      )
      .all(networkId, networkId, page.limit, page.offset) as Record<string, unknown>[];
    return { items: rows.map(mapNetwork), total, limit: page.limit, offset: page.offset };
  }

  insertEvidence(input: {
    networkId: string;
    name: string;
    evidence: Evidence;
  }): EvidenceRecord {
    this.requireNetwork(input.networkId);
    const id = this.clock.randomId();
    const createdAt = this.clock.now().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO evidence_sets(id, network_id, name, evidence_json, created_at)
           VALUES(?, ?, ?, ?, ?)`
        )
        .run(id, input.networkId, input.name, JSON.stringify(input.evidence), createdAt);
    } catch (error) {
      throw mapSqliteError(error, "evidence", input.name);
    }
    return this.getEvidenceByName(input.networkId, input.name)!;
  }

  getEvidenceByName(networkId: string, name: string): EvidenceRecord | null {
    const row = this.db
      .prepare("SELECT * FROM evidence_sets WHERE network_id = ? AND name = ?")
      .get(networkId, name) as Record<string, unknown> | undefined;
    return row ? mapEvidence(row) : null;
  }

  listEvidence(
    networkId: string,
    page: { limit: number; offset: number }
  ): Page<EvidenceRecord> {
    const total = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS c FROM evidence_sets WHERE network_id = ?")
          .get(networkId) as Record<string, unknown>
      ).c
    );
    const rows = this.db
      .prepare(
        `SELECT * FROM evidence_sets WHERE network_id = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(networkId, page.limit, page.offset) as Record<string, unknown>[];
    return { items: rows.map(mapEvidence), total, limit: page.limit, offset: page.offset };
  }

  insertPlan(input: {
    networkId: string;
    name: string;
    plan: QueryPlanInput;
    evidenceId?: string | null;
  }): PlanRecord {
    this.requireNetwork(input.networkId);
    const id = this.clock.randomId();
    const createdAt = this.clock.now().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO query_plans(
             id, network_id, name, variables_json, evidence_id,
             ordering_json, factor_cell_budget, idempotency_key, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.networkId,
          input.name,
          JSON.stringify(input.plan.variables),
          input.evidenceId ?? null,
          JSON.stringify(input.plan.ordering ?? null),
          input.plan.factorCellBudget ?? null,
          input.plan.idempotencyKey ?? null,
          createdAt
        );
    } catch (error) {
      throw mapSqliteError(error, "plan", input.name);
    }
    return this.getPlan(id)!;
  }

  findPlanByIdempotencyKey(networkId: string, key: string): PlanRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM query_plans WHERE network_id = ? AND idempotency_key = ?"
      )
      .get(networkId, key) as Record<string, unknown> | undefined;
    return row ? mapPlan(row) : null;
  }

  getPlan(id: string): PlanRecord | null {
    const row = this.db
      .prepare("SELECT * FROM query_plans WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapPlan(row) : null;
  }

  requirePlan(id: string): PlanRecord {
    const record = this.getPlan(id);
    if (!record) throw new AppError("NOT_FOUND", `Query plan '${id}' not found.`);
    return record;
  }

  listPlans(
    networkId: string,
    page: { limit: number; offset: number }
  ): Page<PlanRecord> {
    const total = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS c FROM query_plans WHERE network_id = ?")
          .get(networkId) as Record<string, unknown>
      ).c
    );
    const rows = this.db
      .prepare(
        `SELECT * FROM query_plans WHERE network_id = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(networkId, page.limit, page.offset) as Record<string, unknown>[];
    return { items: rows.map(mapPlan), total, limit: page.limit, offset: page.offset };
  }

  insertResult(input: {
    planId: string;
    networkId: string;
    networkVersion: number;
    result: unknown;
    status: ResultRecord["status"];
  }): ResultRecord {
    const id = this.clock.randomId();
    const createdAt = this.clock.now().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO query_results(
             id, plan_id, network_id, network_version, result_json, status, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.planId,
          input.networkId,
          input.networkVersion,
          JSON.stringify(input.result),
          input.status,
          createdAt
        );
    } catch (error) {
      throw mapSqliteError(error, "result", input.planId);
    }
    return this.requireResult(id);
  }

  getResultByPlan(planId: string): ResultRecord | null {
    const row = this.db
      .prepare("SELECT * FROM query_results WHERE plan_id = ?")
      .get(planId) as Record<string, unknown> | undefined;
    return row ? mapResult(row) : null;
  }

  requireResult(id: string): ResultRecord {
    const row = this.db
      .prepare("SELECT * FROM query_results WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new AppError("NOT_FOUND", `Result '${id}' not found.`);
    return mapResult(row);
  }

  listResults(
    networkId: string,
    page: { limit: number; offset: number }
  ): Page<ResultRecord> {
    const total = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS c FROM query_results WHERE network_id = ?")
          .get(networkId) as Record<string, unknown>
      ).c
    );
    const rows = this.db
      .prepare(
        `SELECT * FROM query_results WHERE network_id = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(networkId, page.limit, page.offset) as Record<string, unknown>[];
    return { items: rows.map(mapResult), total, limit: page.limit, offset: page.offset };
  }
}

function mapEvidence(row: Record<string, unknown>): EvidenceRecord {
  return {
    id: row.id as string,
    networkId: row.network_id as string,
    name: row.name as string,
    evidence: JSON.parse(row.evidence_json as string) as Evidence,
    createdAt: row.created_at as string
  };
}

function mapPlan(row: Record<string, unknown>): PlanRecord {
  return {
    id: row.id as string,
    networkId: row.network_id as string,
    name: row.name as string,
    variables: JSON.parse(row.variables_json as string) as string[],
    evidenceId: (row.evidence_id as string | null) ?? null,
    ordering: JSON.parse(row.ordering_json as string) as PlanRecord["ordering"],
    factorCellBudget:
      row.factor_cell_budget === null ? null : Number(row.factor_cell_budget),
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    createdAt: row.created_at as string
  };
}

function mapResult(row: Record<string, unknown>): ResultRecord {
  return {
    id: row.id as string,
    planId: row.plan_id as string,
    networkId: row.network_id as string,
    networkVersion: Number(row.network_version),
    result: JSON.parse(row.result_json as string),
    status: row.status as ResultRecord["status"],
    createdAt: row.created_at as string
  };
}

function mapSqliteError(error: unknown, kind: string, key: string): AppError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE")) {
    return new AppError(
      "DUPLICATE",
      `${kind} '${key}' already exists (idempotent resubmissions return the stored record).`,
      { kind, key }
    );
  }
  if (message.includes("FOREIGN KEY")) {
    return new AppError("NOT_FOUND", `Referenced record for ${kind} '${key}' is missing.`);
  }
  throw error;
}
