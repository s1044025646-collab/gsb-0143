import { Factor, type Assignment, cartesian } from "./factor.js";
import { BayesError } from "./errors.js";
import { EPS, closeTo } from "./mathutil.js";

export interface CptInput {
  parents: string[];
  rows: { parentStates: (string | null)[]; probs: number[] }[];
}

export interface VariableInput {
  id: string;
  states: string[];
  cpt: CptInput;
}

export interface NetworkData {
  networkId: string;
  version: number;
  variables: VariableInput[];
}

export function validateNetwork(net: NetworkData): void {
  const ids = new Set<string>();
  const states = new Map<string, Set<string>>();
  for (const v of net.variables) {
    if (!/^[A-Za-z0-9_\-]+$/.test(v.id)) {
      throw new BayesError("VALIDATION", `非法变量 id: ${v.id}`);
    }
    if (ids.has(v.id)) {
      throw new BayesError("DUPLICATE_VARIABLE", `变量重复: ${v.id}`);
    }
    ids.add(v.id);
    const set = new Set<string>();
    if (v.states.length < 2) {
      throw new BayesError("VALIDATION", `变量 ${v.id} 至少需要 2 个状态`);
    }
    for (const s of v.states) {
      if (set.has(s)) throw new BayesError("DUPLICATE_STATE", `变量 ${v.id} 状态重复: ${s}`);
      set.add(s);
    }
    states.set(v.id, set);
  }

  for (const v of net.variables) {
    const parents = v.cpt.parents;
    const seen = new Set<string>();
    for (const p of parents) {
      if (!ids.has(p)) throw new BayesError("NOT_FOUND", `变量 ${v.id} 的父变量不存在: ${p}`);
      if (p === v.id) throw new BayesError("CYCLE", `变量 ${v.id} 不能以自身为父`);
      if (seen.has(p)) throw new BayesError("VALIDATION", `变量 ${v.id} 的父变量重复: ${p}`);
      seen.add(p);
    }
  }

  detectCycle(net.variables);

  for (const v of net.variables) {
    validateCpt(v, net.variables);
  }
}

function detectCycle(vars: VariableInput[]): void {
  const adj = new Map<string, string[]>();
  for (const v of vars) adj.set(v.id, v.cpt.parents);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const v of vars) color.set(v.id, WHITE);

  const stack: string[] = [];
  const visit = (id: string): void => {
    color.set(id, GRAY);
    stack.push(id);
    for (const p of adj.get(id)!) {
      const c = color.get(p)!;
      if (c === GRAY) {
        const start = stack.indexOf(p);
        const path = [...stack.slice(start), p].join(" -> ");
        throw new BayesError("CYCLE", `检测到有向环: ${path}`);
      }
      if (c === WHITE) visit(p);
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const v of vars) if (color.get(v.id) === WHITE) visit(v.id);
}

export function validateCpt(v: VariableInput, all: VariableInput[]): void {
  const parents = v.cpt.parents;
  const parentDomains = parents.map((p) => all.find((x) => x.id === p)!.states);
  const expected = cartesian(parentDomains);
  if (v.cpt.rows.length !== expected.length) {
    throw new BayesError(
      "CPT_MISSING_ROW",
      `变量 ${v.id} 的 CPT 行数 ${v.cpt.rows.length} 与父状态组合数 ${expected.length} 不一致`,
    );
  }
  const seen = new Set<string>();
  for (const row of v.cpt.rows) {
    if (row.probs.length !== v.states.length) {
      throw new BayesError("VALIDATION", `变量 ${v.id} 某行概率数量与状态数不一致`);
    }
    for (const p of row.probs) {
      if (typeof p !== "number" || Number.isNaN(p)) {
        throw new BayesError("CPT_NEGATIVE_PROB", `变量 ${v.id} 概率必须是数字`);
      }
      if (p < -EPS) throw new BayesError("CPT_NEGATIVE_PROB", `变量 ${v.id} 存在负概率: ${p}`);
    }
    if (row.parentStates.length !== parents.length) {
      throw new BayesError("VALIDATION", `变量 ${v.id} 某行父状态数量不匹配`);
    }
    row.parentStates.forEach((s, i) => {
      if (s === null || !parentDomains[i]!.includes(s)) {
        throw new BayesError("VALIDATION", `变量 ${v.id} 行中父变量 ${parents[i]} 的状态非法: ${s}`);
      }
    });
    const key = row.parentStates.join("\u0000");
    if (seen.has(key)) throw new BayesError("CPT_MISSING_ROW", `变量 ${v.id} CPT 存在重复父组合: ${key}`);
    seen.add(key);
    const total = row.probs.reduce((a, b) => a + Math.max(0, b), 0);
    if (!closeTo(total, 1, 1e-6)) {
      throw new BayesError("CPT_NOT_NORMALIZED", `变量 ${v.id} 父组合 ${key} 概率和为 ${total}，未归一化`);
    }
  }
}

export function buildFactors(net: NetworkData): Factor[] {
  const domains: Record<string, string[]> = {};
  for (const v of net.variables) domains[v.id] = v.states;
  const factors: Factor[] = [];
  for (const v of net.variables) {
    const vars = [...v.cpt.parents, v.id];
    const entries = v.cpt.rows.map((row) => {
      const assign: Assignment = {};
      v.cpt.parents.forEach((p, i) => (assign[p] = row.parentStates[i] as string));
      return {
        assign,
        probs: row.probs,
      };
    });
    const tableEntries: { assign: Assignment; logProb: number }[] = [];
    for (const e of entries) {
      v.states.forEach((s, i) => {
        const prob = Math.max(0, e.probs[i]!);
        tableEntries.push({
          assign: { ...e.assign, [v.id]: s },
          logProb: prob === 0 ? -Infinity : Math.log(prob),
        });
      });
    }
    factors.push(new Factor({ vars, domains, entries: tableEntries }));
  }
  return factors;
}
