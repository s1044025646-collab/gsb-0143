import { Factor, type Assignment, type VeStep } from "./factor.js";
import { logSumExp, normalizeLogWeights } from "./mathutil.js";
import { BayesError } from "./errors.js";

export interface InferenceBudget {
  maxFactorRows: number;
}

export interface InferenceRequest {
  factors: Factor[];
  domains: Record<string, string[]>;
  queryVars: string[];
  evidence: Assignment;
  order: "minFill" | "minDegree" | string[];
  budget: InferenceBudget;
}

export interface InferenceResult {
  joint: { assign: Assignment; prob: number; logProb: number }[];
  logEvidence: number;
  evidenceProbability: number;
  impossible: boolean;
  steps: VeStep[];
  orderUsed: string[];
  maxRows: number;
}

export function validateEvidence(
  evidence: Assignment,
  domains: Record<string, string[]>,
  knownVars: Set<string>,
): void {
  for (const [variable, state] of Object.entries(evidence)) {
    if (!knownVars.has(variable)) {
      throw new BayesError("BAD_EVIDENCE", `证据变量不存在: ${variable}`);
    }
    if (!domains[variable]!.includes(state)) {
      throw new BayesError("BAD_EVIDENCE", `变量 ${variable} 的观测状态非法: ${state}`);
    }
  }
}

function minFillOrder(factors: Factor[], hidden: string[]): string[] {
  const remaining = new Set(hidden);
  const order: string[] = [];
  const scopes = factors.map((f) => new Set(f.vars.filter((v) => remaining.has(v))));
  while (remaining.size > 0) {
    let best: string | null = null;
    let bestCost = Infinity;
    for (const v of remaining) {
      const neighbors = new Set<string>();
      for (const scope of scopes) {
        if (scope.has(v)) for (const u of scope) if (u !== v) neighbors.add(u);
      }
      let fill = 0;
      const ns = [...neighbors];
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          if (!scopes.some((s) => s.has(ns[i]!) && s.has(ns[j]!))) fill++;
        }
      }
      const cost = fill * 1000 + ns.length;
      if (cost < bestCost) {
        bestCost = cost;
        best = v;
      }
    }
    const chosen = best!;
    order.push(chosen);
    remaining.delete(chosen);
    for (const scope of scopes) scope.delete(chosen);
  }
  return order;
}

function minDegreeOrder(factors: Factor[], hidden: string[]): string[] {
  const remaining = new Set(hidden);
  const order: string[] = [];
  while (remaining.size > 0) {
    let best: string | null = null;
    let bestDegree = Infinity;
    for (const v of remaining) {
      const neighbors = new Set<string>();
      for (const f of factors) {
        if (f.vars.includes(v)) for (const u of f.vars) if (remaining.has(u) && u !== v) neighbors.add(u);
      }
      if (neighbors.size < bestDegree) {
        bestDegree = neighbors.size;
        best = v;
      }
    }
    const chosen = best!;
    order.push(chosen);
    remaining.delete(chosen);
  }
  return order;
}

export function runInference(req: InferenceRequest): InferenceResult {
  const allVars = new Set(Object.keys(req.domains));
  validateEvidence(req.evidence, req.domains, allVars);
  for (const q of req.queryVars) {
    if (!allVars.has(q)) throw new BayesError("NOT_FOUND", `查询变量不存在: ${q}`);
    if (q in req.evidence) throw new BayesError("VALIDATION", `变量 ${q} 已被观测，不能同时查询`);
  }

  let factors = req.factors.map((f) => f.restrict(req.evidence));
  const hidden = [...allVars].filter((v) => !req.queryVars.includes(v) && !(v in req.evidence));

  let orderUsed: string[];
  if (Array.isArray(req.order)) {
    const set = new Set(req.order);
    if (req.order.length !== hidden.length || hidden.some((h) => !set.has(h))) {
      throw new BayesError("VALIDATION", "自定义消元顺序必须恰好包含所有隐藏变量");
    }
    orderUsed = [...req.order];
  } else if (req.order === "minDegree") {
    orderUsed = minDegreeOrder(req.factors, hidden);
  } else {
    orderUsed = minFillOrder(req.factors.map((f) => f.restrict(req.evidence)), hidden);
  }

  const steps: VeStep[] = [];
  let maxRows = factors.reduce((m, f) => Math.max(m, f.rowCount()), 0);
  let stepNo = 0;

  for (const variable of orderUsed) {
    const involved = factors.filter((f) => f.vars.includes(variable));
    const others = factors.filter((f) => !f.vars.includes(variable));
    let product = new Factor({ vars: [], domains: req.domains, entries: [{ assign: {}, logProb: 0 }] });
    for (const f of involved) product = product.multiply(f);
    const intermediateRows = product.rowCount();
    if (intermediateRows > req.budget.maxFactorRows) {
      throw new BayesError(
        "RESOURCE_EXHAUSTED",
        `消元 ${variable} 时中间因子规模 ${intermediateRows} 超过预算 ${req.budget.maxFactorRows}`,
        { eliminated: variable, rows: intermediateRows, budget: req.budget.maxFactorRows },
      );
    }
    maxRows = Math.max(maxRows, intermediateRows);
    const marginal = product.marginalize(variable);
    steps.push({
      step: ++stepNo,
      eliminated: variable,
      factorsIn: involved.map((f) => f.vars.join(",") || "(常量)"),
      multipliedVars: product.vars,
      intermediateRows,
      marginalizedVars: marginal.vars,
    });
    factors = [...others, marginal];
  }

  let joint = new Factor({ vars: [], domains: req.domains, entries: [{ assign: {}, logProb: 0 }] });
  for (const f of factors) joint = joint.multiply(f);

  if (joint.rowCount() > req.budget.maxFactorRows) {
    throw new BayesError(
      "RESOURCE_EXHAUSTED",
      `最终联合因子规模 ${joint.rowCount()} 超过预算`,
    );
  }

  const rows = joint.toRows();
  const logs = rows.map((r) => r.logProb);
  const logEvidence = logSumExp(logs);
  const impossible = logEvidence === -Infinity;
  const normalized = impossible ? logs.map(() => -Infinity) : logs.map((v) => v - logEvidence);
  const probs = impossible ? logs.map(() => 0) : normalizeLogWeights(logs);

  return {
    joint: rows.map((r, i) => ({
      assign: Object.fromEntries(req.queryVars.map((q) => [q, r.assign[q]!])),
      prob: probs[i]!,
      logProb: normalized[i]!,
    })),
    logEvidence,
    evidenceProbability: impossible ? 0 : Math.exp(logEvidence),
    impossible,
    steps,
    orderUsed,
    maxRows,
  };
}

export function enumerateAll(
  factors: Factor[],
  domains: Record<string, string[]>,
): { assign: Assignment; prob: number; logProb: number }[] {
  const vars = Object.keys(domains);
  const combos: Assignment[] = [{}];
  for (const v of vars) {
    const next: Assignment[] = [];
    for (const prefix of combos) for (const s of domains[v]!) next.push({ ...prefix, [v]: s });
    combos.length = 0;
    combos.push(...next);
  }
  const rows = combos.map((assign) => {
    let lp = 0;
    for (const f of factors) lp += f.getLog(assign);
    return { assign, logProb: lp, prob: lp === -Infinity ? 0 : Math.exp(lp) };
  });
  return rows;
}
