import { LOG_ZERO, logSumExp } from "../logmath.js";
import type { Evidence, InferenceResult, VariableId } from "../types.js";
import { multiply, resetFactorSeq, restrict } from "./factor.js";
import type { BayesianNetwork } from "./network.js";

export interface EnumerationOptions {
  query: VariableId[];
  evidence: Evidence;
}

export function enumerateAll(
  network: BayesianNetwork,
  options: EnumerationOptions
): InferenceResult {
  resetFactorSeq();
  network.validateEvidence(options.evidence);
  for (const q of options.query) {
    if (!network.nodes.has(q)) {
      throw new Error(`Unknown query variable '${q}'`);
    }
    if (q in options.evidence) {
      throw new Error(`Variable '${q}' both queried and observed`);
    }
  }

  const factors = network.topologicalOrder().map((id) => network.buildCptFactor(id));
  let full = factors[0]!;
  for (let i = 1; i < factors.length; i++) full = multiply(full, factors[i]!);
  const restricted = restrict(full, options.evidence).factor;

  const logZ = logSumExp(Array.from(restricted.logValues));
  const impossible = logZ === LOG_ZERO;

  const entries = restricted.enumerate().map((entry) => {
    const assignment: Record<string, string> = {};
    for (const q of options.query) assignment[q] = entry.assignment[q]!;
    return {
      assignment,
      logProbability: impossible ? LOG_ZERO : entry.logValue - logZ,
      probability: impossible ? 0 : Math.exp(entry.logValue - logZ),
      hidden: Object.fromEntries(
        Object.entries(entry.assignment).filter(([v]) => !options.query.includes(v as VariableId))
      )
    };
  });

  const aggregate = new Map<string, { assignment: Record<string, string>; logValue: number }>();
  for (const entry of entries) {
    const key = JSON.stringify(entry.assignment);
    const prior = aggregate.get(key);
    if (prior) {
      prior.logValue = logAdd(prior.logValue, (impossible ? LOG_ZERO : entry.logProbability + logZ));
    } else {
      aggregate.set(key, {
        assignment: entry.assignment,
        logValue: impossible ? LOG_ZERO : entry.logProbability + logZ
      });
    }
  }

  const posterior = [...aggregate.values()]
    .map((v) => ({
      assignment: v.assignment,
      logProbability: impossible ? LOG_ZERO : v.logValue - logZ,
      probability: impossible ? 0 : Math.exp(v.logValue - logZ)
    }))
    .sort((a, b) => JSON.stringify(a.assignment).localeCompare(JSON.stringify(b.assignment)));

  return {
    query: [...options.query],
    evidence: { ...options.evidence },
    posterior,
    logEvidenceProbability: logZ,
    evidenceProbability: impossible ? 0 : Math.exp(logZ),
    impossible,
    eliminationSteps: [],
    ordering: [],
    peakCells: full.cells,
    note: "Independent verification by exhaustive enumeration over the full joint distribution."
  };
}

function logAdd(a: number, b: number): number {
  if (a === LOG_ZERO) return b;
  if (b === LOG_ZERO) return a;
  if (a < b) {
    const t = a;
    a = b;
    b = t;
  }
  return a + Math.log1p(Math.exp(b - a));
}
