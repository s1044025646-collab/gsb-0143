import { randomUUID } from "node:crypto";
import { BayesStore } from "./db.js";
import { buildFactors, validateNetwork, type NetworkData, type VariableInput } from "./network.js";
import { enumerateAll, runInference, type InferenceResult } from "./inference.js";
import { BayesError } from "./errors.js";
import type { Assignment } from "./factor.js";

export interface CreateNetworkRequest {
  networkId?: string;
  name: string;
  description?: string;
  variables: VariableInput[];
  baseNetworkId?: string;
}

export interface QueryRequest {
  networkId: string;
  version?: number;
  evidenceId?: string;
  evidence?: Record<string, string>;
  queryVars: string[];
  ordering?: "minFill" | "minDegree" | string[];
  maxFactorRows?: number;
  idempotencyKey?: string;
}

export class BayesService {
  constructor(
    private store: BayesStore,
    private idGen: () => string = randomUUID,
  ) {}

  createNetwork(req: CreateNetworkRequest): { networkId: string; version: number } {
    const networkId = req.networkId ?? req.baseNetworkId ?? this.idGen();
    const nextVersion =
      req.baseNetworkId !== undefined
        ? (this.store.latestVersion(req.baseNetworkId) ?? 0) + 1
        : (this.store.latestVersion(networkId) ?? 0) + 1;
    const targetId = req.baseNetworkId ?? networkId;
    const data: NetworkData = { networkId: targetId, version: nextVersion, variables: req.variables };
    validateNetwork(data);
    this.store.saveNetwork(data, req.name, req.description ?? "");
    return { networkId: targetId, version: nextVersion };
  }

  private prepareQuery(req: QueryRequest): {
    queryId: string;
    version: number;
    result: InferenceResult;
    evidence: Assignment;
  } {
    const version = req.version ?? this.store.latestVersion(req.networkId);
    if (version === null) throw new BayesError("NOT_FOUND", `网络不存在: ${req.networkId}`);
    if (req.idempotencyKey) {
      const existing = this.store.getQueryByIdempotency(req.networkId, req.idempotencyKey);
      if (existing) {
        const frozen = this.store.getFrozenResult(existing.query_id) as
          | (InferenceResult & { evidence: Assignment })
          | null;
        if (frozen) {
          return { queryId: existing.query_id, version, result: frozen, evidence: frozen.evidence };
        }
      }
    }
    const { data } = this.store.loadNetwork(req.networkId, version);
    let evidence: Assignment = {};
    let evidenceId: string | null = null;
    if (req.evidenceId) {
      const saved = this.store.getEvidence(req.evidenceId);
      if (!saved) throw new BayesError("NOT_FOUND", `证据集不存在: ${req.evidenceId}`);
      if (saved.network_id !== req.networkId || saved.version !== version) {
        throw new BayesError("VERSION_MISMATCH", "证据集所属网络版本与查询目标不一致");
      }
      evidence = saved.observations;
      evidenceId = req.evidenceId;
    }
    if (req.evidence) evidence = { ...evidence, ...req.evidence };

    const queryId = this.idGen();
    const factors = buildFactors(data);
    const domains = Object.fromEntries(data.variables.map((v) => [v.id, v.states]));
    const result = runInference({
      factors,
      domains,
      queryVars: req.queryVars,
      evidence,
      order: req.ordering ?? "minFill",
      budget: { maxFactorRows: req.maxFactorRows ?? 100_000 },
    });
    const created = this.store.saveQueryPlan({
        queryId,
        networkId: req.networkId,
        version,
        evidenceId,
        queryVars: req.queryVars,
        ordering: JSON.stringify(req.ordering ?? "minFill"),
        maxFactorRows: req.maxFactorRows ?? 100_000,
        idempotencyKey: req.idempotencyKey ?? null,
    });
    if (!created && req.idempotencyKey) {
      const existing = this.store.getQueryByIdempotency(req.networkId, req.idempotencyKey)!;
      const frozen = this.store.getFrozenResult(existing.query_id) as InferenceResult & { evidence: Assignment };
      return { queryId: existing.query_id, version, result: frozen, evidence: frozen.evidence };
    }
    this.store.freezeResult(queryId, req.networkId, version, {
      queryVars: req.queryVars,
      evidence,
      ...result,
      boundary:
        "证据观察 P(X|e) 是条件化，不是因果干预 do(e)；本后端不执行干预演算，也不改变网络结构。",
    });
    return { queryId, version, result, evidence };
  }

  query(req: QueryRequest): {
    queryId: string;
    version: number;
    impossible: boolean;
    evidenceProbability: number;
    joint: InferenceResult["joint"];
    steps: InferenceResult["steps"];
    orderUsed: string[];
    maxRows: number;
  } {
    const { queryId, version, result } = this.prepareQuery(req);
    return {
      queryId,
      version,
      impossible: result.impossible,
      evidenceProbability: result.evidenceProbability,
      joint: result.joint,
      steps: result.steps,
      orderUsed: result.orderUsed,
      maxRows: result.maxRows,
    };
  }

  marginal(req: QueryRequest, variable: string): {
    queryId: string;
    variable: string;
    distribution: Record<string, number>;
    evidenceProbability: number;
    impossible: boolean;
  } {
    const full = this.query({ ...req, queryVars: [variable] });
    const distribution: Record<string, number> = {};
    for (const row of full.joint) distribution[row.assign[variable]!] = row.prob;
    return {
      queryId: full.queryId,
      variable,
      distribution,
      evidenceProbability: full.evidenceProbability,
      impossible: full.impossible,
    };
  }

  explain(req: QueryRequest): unknown {
    const { queryId, result, evidence } = this.prepareQuery(req);
    return {
      queryId,
      evidence,
      orderUsed: result.orderUsed,
      evidenceProbability: result.evidenceProbability,
      impossible: result.impossible,
      steps: result.steps,
      joint: result.joint,
      strategy:
        "所有因子以自然对数概率存储；乘法变为加法，求和使用 log-sum-exp，零概率为 -Infinity，绝不用 epsilon 平滑伪造后验。",
      boundary:
        "观测证据仅做条件化（evidence restriction），不等价于 do() 干预；干预会切断入边，本系统不提供该语义。",
    };
  }

  addEvidence(
    evidenceId: string | undefined,
    networkId: string,
    version: number | undefined,
    observations: Record<string, string>,
  ): string {
    const ver = version ?? this.store.latestVersion(networkId);
    if (ver === null) throw new BayesError("NOT_FOUND", `网络不存在: ${networkId}`);
    const { data } = this.store.loadNetwork(networkId, ver);
    const domains = Object.fromEntries(data.variables.map((v) => [v.id, v.states]));
    const known = new Set(data.variables.map((v) => v.id));
    for (const [variable, state] of Object.entries(observations)) {
      if (!known.has(variable)) throw new BayesError("BAD_EVIDENCE", `证据变量不存在: ${variable}`);
      if (!domains[variable]!.includes(state)) {
        throw new BayesError("BAD_EVIDENCE", `变量 ${variable} 的观测状态非法: ${state}`);
      }
    }
    const id = evidenceId ?? this.idGen();
    this.store.saveEvidence(id, networkId, ver, observations);
    return id;
  }

  enumerate(networkId: string, version?: number) {
    const ver = version ?? this.store.latestVersion(networkId);
    if (ver === null) throw new BayesError("NOT_FOUND", `网络不存在: ${networkId}`);
    const { data } = this.store.loadNetwork(networkId, ver);
    const factors = buildFactors(data);
    const domains = Object.fromEntries(data.variables.map((v) => [v.id, v.states]));
    return enumerateAll(factors, domains);
  }

  compareVersions(networkId: string, v1: number, v2?: number): {
    versions: number[];
    onlyInV1: string[];
    onlyInV2: string[];
    changed: string[];
  } {
    const b = v2 ?? this.store.latestVersion(networkId);
    if (b === null) throw new BayesError("NOT_FOUND", "网络不存在");
    const a = this.store.loadNetwork(networkId, v1).data;
    const bb = this.store.loadNetwork(networkId, b).data;
    const mapA = new Map(a.variables.map((v) => [v.id, v]));
    const mapB = new Map(bb.variables.map((v) => [v.id, v]));
    const onlyInV1: string[] = [];
    const onlyInV2: string[] = [];
    const changed: string[] = [];
    for (const [id, va] of mapA) {
      const vb = mapB.get(id);
      if (!vb) onlyInV1.push(id);
      else if (JSON.stringify(va) !== JSON.stringify(vb)) changed.push(id);
    }
    for (const id of mapB.keys()) if (!mapA.has(id)) onlyInV2.push(id);
    return { versions: [v1, b], onlyInV1, onlyInV2, changed };
  }
}
