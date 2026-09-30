import { AppError } from "../errors.js";
import { LOG_ZERO, logSumExp } from "../logmath.js";
import type {
  EliminationStep,
  Evidence,
  InferenceResult,
  VariableId
} from "../types.js";
import {
  Factor,
  multiply,
  resetFactorSeq,
  restrict,
  sumOut
} from "./factor.js";
import type { BayesianNetwork } from "./network.js";

export const DEFAULT_CELL_BUDGET = 1_000_000;

export interface EliminationOptions {
  query: VariableId[];
  evidence: Evidence;
  ordering?: VariableId[] | "min-fill" | "min-degree";
  factorCellBudget?: number;
}

export function runVariableElimination(
  network: BayesianNetwork,
  options: EliminationOptions
): InferenceResult {
  resetFactorSeq();
  const budget = options.factorCellBudget ?? DEFAULT_CELL_BUDGET;
  if (!Array.isArray(options.query) || options.query.length === 0) {
    throw new AppError("VALIDATION", "At least one query variable is required.");
  }
  const querySet = new Set<VariableId>();
  for (const q of options.query) {
    if (!network.nodes.has(q)) {
      throw new AppError("NOT_FOUND", `Query references unknown variable '${q}'.`);
    }
    if (querySet.has(q)) {
      throw new AppError("VALIDATION", `Query lists variable '${q}' more than once.`);
    }
    querySet.add(q);
  }
  network.validateEvidence(options.evidence);
  for (const q of querySet) {
    if (q in options.evidence) {
      throw new AppError(
        "ILLEGAL_EVIDENCE",
        `Variable '${q}' cannot be both queried and observed.`
      );
    }
  }

  const factors: Factor[] = [];
  let peakCells = 0;
  const consider = (cells: number): void => {
    if (cells > budget) {
      throw new AppError(
        "RESOURCE_EXHAUSTED",
        `Factor table would need ${cells} cells, exceeding budget ${budget}. ` +
          `This is a resource limit, not an impossible event; try a different ordering or raise the budget.`,
        { requiredCells: cells, budget }
      );
    }
    peakCells = Math.max(peakCells, cells);
  };

  for (const id of network.topologicalOrder()) {
    const factor = network.buildCptFactor(id);
    consider(factor.cells);
    const restricted = restrict(factor, options.evidence);
    factors.push(restricted.factor);
    peakCells = Math.max(peakCells, restricted.factor.cells);
  }

  const hidden = network
    .topologicalOrder()
    .filter((v) => !querySet.has(v) && !(v in options.evidence));
  const ordering = resolveOrdering(network, options.ordering, hidden, factors);

  const eliminationSteps: EliminationStep[] = [];
  ordering.forEach((variable, index) => {
    const involved = factors.filter((f) => f.variables.includes(variable));
    if (involved.length === 0) return;
    const rest = factors.filter((f) => !f.variables.includes(variable));

    let product = involved[0]!;
    consider(product.cells);
    for (let i = 1; i < involved.length; i++) {
      product = multiply(product, involved[i]!);
      consider(product.cells);
    }
    const summed = sumOut(product, variable, `tau${index + 1}`);
    consider(summed.cells);

    eliminationSteps.push({
      step: index + 1,
      eliminated: variable,
      factorsIn: involved.map((f) => f.id),
      factorOut: summed.id,
      factorCellsBefore: product.cells,
      factorCellsAfter: summed.cells
    });

    factors.length = 0;
    factors.push(...rest, summed);
    peakCells = Math.max(peakCells, ...factors.map((f) => f.cells));
  });

  let joint = factors[0] ?? Factor.constant(0, "joint");
  for (let i = 1; i < factors.length; i++) {
    joint = multiply(joint, factors[i]!, "joint");
    consider(joint.cells);
  }
  for (const q of options.query) {
    if (!joint.variables.includes(q)) {
      throw new AppError("INTERNAL", `Query variable '${q}' missing from final factor.`);
    }
  }

  const logZ = logSumExp(Array.from(joint.logValues));
  const impossible = logZ === LOG_ZERO;
  const posterior = joint.enumerate().map((entry) => ({
    assignment: options.query.reduce<Record<string, string>>((acc, q) => {
      acc[q] = entry.assignment[q]!;
      return acc;
    }, {}),
    logProbability: impossible ? LOG_ZERO : entry.logValue - logZ,
    probability: impossible ? 0 : Math.exp(entry.logValue - logZ)
  }));
  posterior.sort((a, b) => {
    for (const q of options.query) {
      if (a.assignment[q]! < b.assignment[q]!) return -1;
      if (a.assignment[q]! > b.assignment[q]!) return 1;
    }
    return 0;
  });

  return {
    query: [...options.query],
    evidence: { ...options.evidence },
    posterior,
    logEvidenceProbability: logZ,
    evidenceProbability: impossible ? 0 : Math.exp(logZ),
    impossible,
    eliminationSteps,
    ordering,
    peakCells,
    note:
      "Evidence is observational conditioning P(query|evidence), not a causal intervention " +
      "do(evidence); graph edges and CPTs are not modified by the observation."
  };
}

function resolveOrdering(
  network: BayesianNetwork,
  requested: VariableId[] | "min-fill" | "min-degree" | undefined,
  hidden: VariableId[],
  initialFactors: Factor[]
): VariableId[] {
  if (Array.isArray(requested)) {
    const list = [...requested];
    const given = new Set(list);
    if (list.length !== hidden.length || hidden.some((h) => !given.has(h))) {
      throw new AppError(
        "VALIDATION",
        `Custom ordering must be a permutation of hidden variables [${hidden.join(", ")}].`
      );
    }
    if (new Set(list).size !== list.length) {
      throw new AppError("VALIDATION", "Elimination ordering contains a duplicate variable.");
    }
    for (const v of list) {
      if (!network.nodes.has(v)) {
        throw new AppError("VALIDATION", `Ordering references unknown variable '${v}'.`);
      }
    }
    return list;
  }

  const mode = requested ?? "min-fill";
  return greedyOrder(hidden, initialFactors, mode);
}

function greedyOrder(
  hidden: VariableId[],
  factors: Factor[],
  mode: "min-fill" | "min-degree"
): VariableId[] {
  const remaining = new Set(hidden);
  const scopes = factors.map((f) => new Set(f.variables));
  const result: VariableId[] = [];

  while (remaining.size > 0) {
    let best: VariableId | undefined;
    let bestScore = Infinity;
    for (const v of remaining) {
      const neighbors = new Set<VariableId>();
      for (const scope of scopes) {
        if (scope.has(v)) for (const other of scope) if (other !== v) neighbors.add(other);
      }
      const score =
        mode === "min-degree"
          ? neighbors.size
          : fillEdgeCount(neighbors, scopes);
      if (score < bestScore || (score === bestScore && (best === undefined || v < best))) {
        best = v;
        bestScore = score;
      }
    }
    const chosen = best!;
    result.push(chosen);
    remaining.delete(chosen);

    const merged = new Set<VariableId>();
    const kept: Set<VariableId>[] = [];
    for (const scope of scopes) {
      if (scope.has(chosen)) {
        for (const other of scope) if (other !== chosen) merged.add(other);
      } else {
        kept.push(scope);
      }
    }
    scopes.length = 0;
    scopes.push(...kept);
    if (merged.size > 0) scopes.push(merged);
  }
  return result;
}

function fillEdgeCount(
  neighbors: Set<VariableId>,
  scopes: Set<VariableId>[]
): number {
  const list = [...neighbors];
  let edges = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const u = list[i]!;
      const w = list[j]!;
      const alreadyConnected = scopes.some((scope) => scope.has(u) && scope.has(w));
      if (!alreadyConnected) edges += 1;
    }
  }
  return edges;
}
