import { AppError } from "./errors.js";
import { BayesianNetwork } from "./inference/network.js";
import { runVariableElimination } from "./inference/elimination.js";
import { enumerateAll } from "./inference/enumeration.js";
import type { Repository, NetworkRecord } from "./repository.js";
import type {
  Evidence,
  InferenceResult,
  NetworkSpec,
  Page,
  QueryPlanInput
} from "./types.js";

export interface CreateNetworkInput {
  id?: string;
  name: string;
  spec: NetworkSpec;
}

export class BayesService {
  constructor(readonly repo: Repository) {}

  createNetwork(input: CreateNetworkInput): NetworkRecord {
    if (!input.name) throw new AppError("VALIDATION", "Network name is required.");
    if (!input.spec?.id) throw new AppError("VALIDATION", "Network spec.id is required.");
    const validated = BayesianNetwork.validate(input.spec);
    void validated;
    return this.repo.transaction(() =>
      this.repo.insertNetwork({
        id: input.id ?? input.spec.id,
        name: input.name,
        spec: input.spec,
        status: "active",
        version: 1
      })
    );
  }

  validateNetwork(id: string): { valid: true; nodeCount: number } {
    const record = this.repo.requireNetwork(id);
    const network = BayesianNetwork.validate(record.spec);
    return { valid: true, nodeCount: network.nodes.size };
  }

  createRevision(
    id: string,
    input: { name: string; spec: NetworkSpec; newId?: string }
  ): NetworkRecord {
    const base = this.repo.requireNetwork(id);
    BayesianNetwork.validate(input.spec);
    return this.repo.transaction(() => {
      this.repo.setNetworkStatus(base.id, "archived");
      return this.repo.insertNetwork({
        id: input.newId ?? `${id}-v${base.version + 1}`,
        name: input.name,
        spec: input.spec,
        parentVersionId: base.id,
        status: "active",
        version: base.version + 1
      });
    });
  }

  compareVersions(idA: string, idB: string): {
    a: { id: string; version: number };
    b: { id: string; version: number };
    addedNodes: string[];
    removedNodes: string[];
    changedNodes: string[];
  } {
    const a = this.repo.requireNetwork(idA);
    const b = this.repo.requireNetwork(idB);
    const nodesA = new Map(a.spec.nodes.map((n) => [n.variable.id, canonicalNode(n)]));
    const nodesB = new Map(b.spec.nodes.map((n) => [n.variable.id, canonicalNode(n)]));
    const addedNodes: string[] = [];
    const removedNodes: string[] = [];
    const changedNodes: string[] = [];
    for (const id of nodesB.keys()) if (!nodesA.has(id)) addedNodes.push(id);
    for (const id of nodesA.keys()) {
      if (!nodesB.has(id)) removedNodes.push(id);
      else if (nodesA.get(id) !== nodesB.get(id)) changedNodes.push(id);
    }
    return {
      a: { id: a.id, version: a.version },
      b: { id: b.id, version: b.version },
      addedNodes: addedNodes.sort(),
      removedNodes: removedNodes.sort(),
      changedNodes: changedNodes.sort()
    };
  }

  setEvidence(networkId: string, name: string, evidence: Evidence): {
    id: string;
    name: string;
    evidence: Evidence;
  } {
    const record = this.repo.requireNetwork(networkId);
    const network = BayesianNetwork.validate(record.spec);
    network.validateEvidence(evidence);
    const existing = this.repo.getEvidenceByName(networkId, name);
    if (existing) {
      return { id: existing.id, name: existing.name, evidence: existing.evidence };
    }
    const saved = this.repo.insertEvidence({ networkId, name, evidence });
    return { id: saved.id, name: saved.name, evidence: saved.evidence };
  }

  listEvidence(networkId: string, page: PageParams): Page<unknown> {
    this.repo.requireNetwork(networkId);
    return this.repo.listEvidence(networkId, normalizePage(page));
  }

  runQuery(
    networkId: string,
    planName: string,
    plan: QueryPlanInput
  ): { planId: string; resultId: string; result: InferenceResult; reused: boolean } {
    const record = this.repo.requireNetwork(networkId);
    if (record.status !== "active") {
      throw new AppError(
        "VERSION_ARCHIVED",
        `Network version '${networkId}' is archived; run queries against its active revision.`
      );
    }
    validatePlanShape(plan);
    const network = BayesianNetwork.validate(record.spec);

    const execute = (): { planId: string; resultId: string; result: InferenceResult; reused: boolean } => {
      if (plan.idempotencyKey) {
        const existingPlan = this.repo.findPlanByIdempotencyKey(
          networkId,
          plan.idempotencyKey
        );
        if (existingPlan) {
          const existingResult = this.repo.getResultByPlan(existingPlan.id);
          if (!existingResult || existingResult.status !== "frozen") {
            throw new AppError(
              "INTERNAL",
              "Idempotent plan exists without a frozen result."
            );
          }
          return {
            planId: existingPlan.id,
            resultId: existingResult.id,
            result: existingResult.result as InferenceResult,
            reused: true
          };
        }
      }

      let evidence = plan.evidence;
      let evidenceId: string | null = null;
      const saved = this.repo.transaction(() => {
        const planRecord = this.repo.insertPlan({
          networkId,
          name: planName,
          plan,
          evidenceId
        });
        evidenceId = null;
        const result = runVariableElimination(network, {
          query: plan.variables,
          evidence,
          ordering: plan.ordering,
          factorCellBudget: plan.factorCellBudget
        });
        const resultRecord = this.repo.insertResult({
          planId: planRecord.id,
          networkId,
          networkVersion: record.version,
          result,
          status: "frozen"
        });
        return { planRecord, resultRecord, result };
      });
      return {
        planId: saved.planRecord.id,
        resultId: saved.resultRecord.id,
        result: saved.result,
        reused: false
      };
    };

    try {
      return execute();
    } catch (error) {
      if (error instanceof AppError && error.code === "DUPLICATE" && plan.idempotencyKey) {
        const existingPlan = this.repo.findPlanByIdempotencyKey(
          networkId,
          plan.idempotencyKey
        )!;
        const existingResult = this.repo.getResultByPlan(existingPlan.id)!;
        return {
          planId: existingPlan.id,
          resultId: existingResult.id,
          result: existingResult.result as InferenceResult,
          reused: true
        };
      }
      throw error;
    }
  }

  verifyByEnumeration(networkId: string, plan: QueryPlanInput): InferenceResult {
    const record = this.repo.requireNetwork(networkId);
    const network = BayesianNetwork.validate(record.spec);
    validatePlanShape(plan);
    return enumerateAll(network, {
      query: plan.variables,
      evidence: plan.evidence
    });
  }

  listNetworks(page: PageParams): Page<NetworkRecord> {
    return this.repo.listNetworks(normalizePage(page));
  }

  listPlans(networkId: string, page: PageParams): Page<unknown> {
    this.repo.requireNetwork(networkId);
    return this.repo.listPlans(networkId, normalizePage(page));
  }

  listResults(networkId: string, page: PageParams): Page<unknown> {
    this.repo.requireNetwork(networkId);
    return this.repo.listResults(networkId, normalizePage(page));
  }
}

export interface PageParams {
  limit?: number;
  offset?: number;
}

export function normalizePage(page: PageParams): { limit: number; offset: number } {
  const limit = page.limit ?? 50;
  const offset = page.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new AppError("VALIDATION", "limit must be an integer between 1 and 200.");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new AppError("VALIDATION", "offset must be a non-negative integer.");
  }
  return { limit, offset };
}

function validatePlanShape(plan: QueryPlanInput): void {
  if (!plan || typeof plan !== "object") {
    throw new AppError("VALIDATION", "Query plan must be an object.");
  }
  if (!Array.isArray(plan.variables) || plan.variables.length === 0) {
    throw new AppError("VALIDATION", "Query plan requires a non-empty variables array.");
  }
  for (const v of plan.variables) {
    if (typeof v !== "string") {
      throw new AppError("VALIDATION", "Query variables must be strings.");
    }
  }
  if (plan.evidence !== undefined && (typeof plan.evidence !== "object" || plan.evidence === null)) {
    throw new AppError("VALIDATION", "Evidence must be an object of variable -> state.");
  }
  if (plan.factorCellBudget !== undefined) {
    if (!Number.isInteger(plan.factorCellBudget) || plan.factorCellBudget < 1) {
      throw new AppError("VALIDATION", "factorCellBudget must be a positive integer.");
    }
  }
}

function canonicalNode(node: NetworkSpec["nodes"][number]): string {
  return JSON.stringify({
    states: node.variable.states,
    parents: node.parents,
    cpt: node.cpt
      .map((row) => ({
        parentStates: row.parentStates,
        probabilities: row.probabilities
      }))
      .sort((a, b) => JSON.stringify(a.parentStates).localeCompare(JSON.stringify(b.parentStates)))
  });
}
