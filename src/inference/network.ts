import { AppError } from "../errors.js";
import { logProb } from "../logmath.js";
import type {
  Evidence,
  NetworkSpec,
  NodeSpec,
  VariableId
} from "../types.js";
import { Factor, type FactorScope } from "./factor.js";

export interface ValidatedNode {
  id: VariableId;
  states: string[];
  parents: VariableId[];
  children: VariableId[];
  cpt: Map<string, number[]>;
}

const NORMALIZE_TOLERANCE = 1e-6;

export class BayesianNetwork {
  readonly spec: NetworkSpec;
  readonly nodes = new Map<VariableId, ValidatedNode>();
  readonly order: VariableId[];

  private constructor(spec: NetworkSpec) {
    this.spec = spec;
    this.order = spec.nodes.map((n) => n.variable.id);
    for (const node of spec.nodes) {
      const states = node.variable.states;
      this.nodes.set(node.variable.id, {
        id: node.variable.id,
        states,
        parents: [...node.parents],
        children: [],
        cpt: new Map()
      });
    }
    for (const node of spec.nodes) {
      for (const p of node.parents) {
        const parent = this.nodes.get(p);
        if (!parent) {
          throw new AppError(
            "MISSING_PARENT",
            `Node '${node.variable.id}' references unknown parent '${p}'.`
          );
        }
        parent.children.push(node.variable.id);
      }
    }
  }

  static validate(spec: NetworkSpec): BayesianNetwork {
    if (!spec || typeof spec !== "object") {
      throw new AppError("VALIDATION", "Network spec must be an object.");
    }
    if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) {
      throw new AppError("VALIDATION", "Network must contain at least one node.");
    }

    const network = new BayesianNetwork(spec);
    validateStates(network);
    validateAcyclic(network);
    validateCpts(network, spec.nodes);
    return network;
  }

  scopes(): Map<VariableId, FactorScope> {
    const map = new Map<VariableId, FactorScope>();
    for (const [id, node] of this.nodes) {
      map.set(id, { variable: id, states: node.states });
    }
    return map;
  }

  scope(variable: VariableId): FactorScope {
    const node = this.nodes.get(variable);
    if (!node) {
      throw new AppError("NOT_FOUND", `Unknown variable '${variable}'.`);
    }
    return { variable, states: node.states };
  }

  topologicalOrder(): VariableId[] {
    return [...this.order];
  }

  buildCptFactor(variable: VariableId): Factor {
    const node = this.nodes.get(variable);
    if (!node) throw new AppError("NOT_FOUND", `Unknown variable '${variable}'.`);

    const scopeDefs: FactorScope[] = node.parents.map((p) => this.scope(p));
    scopeDefs.push(this.scope(variable));
    const size = scopeDefs.reduce((acc, s) => acc * s.states.length, 1);
    const values = new Float64Array(size);

    const childCard = node.states.length;
    const parentRows = Math.floor(size / childCard);
    for (let row = 0; row < parentRows; row++) {
      const key = this.parentKeyFromIndex(node, row);
      const probs = node.cpt.get(key);
      if (!probs) {
        throw new AppError(
          "CPT_MISSING_ROW",
          `CPT for '${variable}' is missing row for ${key}.`
        );
      }
      for (let c = 0; c < childCard; c++) {
        values[row * childCard + c] = logProb(probs[c]!);
      }
    }
    return new Factor(scopeDefs, values, `cpt:${variable}`);
  }

  parentKeyFromIndex(node: ValidatedNode, index: number): string {
    const parts: string[] = [];
    let rem = index;
    const cards = node.parents.map((p) => this.nodes.get(p)!.states.length);
    for (let d = node.parents.length - 1; d >= 0; d--) {
      const card = cards[d]!;
      const stateIdx = rem % card;
      rem = Math.floor(rem / card);
      parts.unshift(`${node.parents[d]}=${this.nodes.get(node.parents[d]!)!.states[stateIdx]}`);
    }
    return parts.join(";");
  }

  parentKey(node: ValidatedNode, parentStates: Record<string, string>): string {
    return node.parents
      .map((p) => {
        const state = parentStates[p];
        if (state === undefined) {
          throw new AppError(
            "CPT_MISSING_ROW",
            `CPT row for '${node.id}' is missing parent '${p}'.`
          );
        }
        return `${p}=${state}`;
      })
      .join(";");
  }

  validateEvidence(evidence: Evidence): void {
    for (const [variable, state] of Object.entries(evidence)) {
      const node = this.nodes.get(variable);
      if (!node) {
        throw new AppError("ILLEGAL_EVIDENCE", `Evidence references unknown variable '${variable}'.`);
      }
      if (!node.states.includes(state)) {
        throw new AppError(
          "ILLEGAL_EVIDENCE",
          `Variable '${variable}' has no state '${state}'. Valid states: ${node.states.join(", ")}.`
        );
      }
    }
  }
}

function validateStates(network: BayesianNetwork): void {
  for (const node of network.nodes.values()) {
    if (node.states.length === 0) {
      throw new AppError("VALIDATION", `Variable '${node.id}' must have at least one state.`);
    }
    const seen = new Set<string>();
    for (const state of node.states) {
      if (typeof state !== "string" || state.length === 0) {
        throw new AppError("VALIDATION", `Variable '${node.id}' has an empty state name.`);
      }
      if (seen.has(state)) {
        throw new AppError(
          "DUPLICATE_STATE",
          `Variable '${node.id}' lists duplicate state '${state}'.`
        );
      }
      seen.add(state);
    }
  }
}

function validateAcyclic(network: BayesianNetwork): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<VariableId, number>();
  for (const id of network.nodes.keys()) color.set(id, WHITE);

  const visit = (id: VariableId, stack: VariableId[]): void => {
    color.set(id, GRAY);
    const node = network.nodes.get(id)!;
    for (const child of node.children) {
      const c = color.get(child)!;
      if (c === GRAY) {
        throw new AppError(
          "CYCLE",
          `Directed cycle detected: ${[...stack, id, child].join(" -> ")}.`
        );
      }
      if (c === WHITE) visit(child, [...stack, id]);
    }
    color.set(id, BLACK);
  };

  for (const id of network.nodes.keys()) {
    if (color.get(id) === WHITE) visit(id, []);
  }

  const sorted: VariableId[] = [];
  const remaining = new Set(network.nodes.keys());
  const indegree = new Map<VariableId, number>();
  for (const [id, node] of network.nodes) {
    indegree.set(id, node.parents.length);
  }
  while (remaining.size > 0) {
    let progressed = false;
    for (const id of [...remaining]) {
      if (indegree.get(id) === 0) {
        sorted.push(id);
        remaining.delete(id);
        for (const child of network.nodes.get(id)!.children) {
          indegree.set(child, (indegree.get(child) ?? 0) - 1);
        }
        progressed = true;
      }
    }
    if (!progressed) {
      throw new AppError("CYCLE", "Directed cycle detected during topological sort.");
    }
  }
  network.order.length = 0;
  network.order.push(...sorted);
}

function validateCpts(network: BayesianNetwork, rawNodes: NodeSpec[]): void {
  for (const raw of rawNodes) {
    const node = network.nodes.get(raw.variable.id)!;
    const seenRows = new Set<string>();

    for (const row of raw.cpt) {
      for (const p of node.parents) {
        if (!(p in row.parentStates)) {
          throw new AppError(
            "CPT_MISSING_ROW",
            `CPT row for '${node.id}' is missing parent value for '${p}'.`
          );
        }
      }
      for (const [p, state] of Object.entries(row.parentStates)) {
        if (!node.parents.includes(p)) {
          throw new AppError(
            "CPT_EXTRA_ROW",
            `CPT row for '${node.id}' assigns non-parent variable '${p}'.`
          );
        }
        const parentNode = network.nodes.get(p)!;
        if (!parentNode.states.includes(state)) {
          throw new AppError(
            "CPT_EXTRA_ROW",
            `CPT row for '${node.id}' uses illegal state '${state}' for parent '${p}'.`
          );
        }
      }

      const key = network.parentKey(node, row.parentStates);
      if (seenRows.has(key)) {
        throw new AppError(
          "CPT_EXTRA_ROW",
          `CPT for '${node.id}' has duplicate row for ${key}.`
        );
      }
      seenRows.add(key);

      const probs: number[] = [];
      let sum = 0;
      const knownStates = new Set<string>();
      for (const [state, p] of Object.entries(row.probabilities)) {
        if (!node.states.includes(state)) {
          throw new AppError(
            "CPT_EXTRA_ROW",
            `CPT row for '${node.id}' (${key}) assigns unknown state '${state}'.`
          );
        }
        if (knownStates.has(state)) {
          throw new AppError(
            "CPT_EXTRA_ROW",
            `CPT row for '${node.id}' (${key}) repeats state '${state}'.`
          );
        }
        knownStates.add(state);
        if (typeof p !== "number" || Number.isNaN(p)) {
          throw new AppError(
            "NEGATIVE_PROBABILITY",
            `CPT probability for '${node.id}' (${key}, ${state}) must be a number.`
          );
        }
        if (p < 0) {
          throw new AppError(
            "NEGATIVE_PROBABILITY",
            `Negative probability ${p} for '${node.id}' (${key}, ${state}).`
          );
        }
        probs.push(p);
        sum += p;
      }

      if (knownStates.size !== node.states.length) {
        throw new AppError(
          "CPT_MISSING_ROW",
          `CPT row for '${node.id}' (${key}) does not provide every child state.`
        );
      }
      if (sum <= 0) {
        throw new AppError(
          "CPT_NOT_NORMALIZED",
          `CPT row for '${node.id}' (${key}) sums to zero; cannot normalize.`
        );
      }
      if (Math.abs(sum - 1) > NORMALIZE_TOLERANCE) {
        throw new AppError(
          "CPT_NOT_NORMALIZED",
          `CPT row for '${node.id}' (${key}) sums to ${sum}, expected 1.`
        );
      }

      const ordered = node.states.map((s) => row.probabilities[s]!);
      node.cpt.set(key, ordered);
    }

    const expectedRows = node.parents.reduce(
      (acc, p) => acc * network.nodes.get(p)!.states.length,
      1
    );
    if (node.cpt.size !== expectedRows) {
      throw new AppError(
        "CPT_MISSING_ROW",
        `CPT for '${node.id}' has ${node.cpt.size} rows, expected ${expectedRows}.`
      );
    }
  }
}
