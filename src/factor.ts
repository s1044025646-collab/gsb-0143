import { logAddExp } from "./mathutil.js";

export type Assignment = Record<string, string>;

export interface FactorOptions {
  vars: string[];
  domains: Record<string, string[]>;
  entries: { assign: Assignment; logProb: number }[];
}

export interface VeStep {
  step: number;
  eliminated: string;
  factorsIn: string[];
  multipliedVars: string[];
  intermediateRows: number;
  marginalizedVars: string[];
}

export class Factor {
  readonly vars: string[];
  readonly domains: Record<string, string[]>;
  readonly logTable: Map<string, number>;

  constructor(opts: FactorOptions) {
    this.vars = [...opts.vars];
    this.domains = opts.domains;
    this.logTable = new Map();
    for (const e of opts.entries) {
      const key = this.keyFor(e.assign);
      this.logTable.set(key, e.logProb);
    }
  }

  keyFor(assign: Assignment): string {
    return this.vars.map((v) => assign[v]).join("\u0000");
  }

  static uniform(vars: string[], domains: Record<string, string[]>): Factor {
    const entries: { assign: Assignment; logProb: number }[] = [];
    const combos = cartesian(vars.map((v) => domains[v]!));
    const lp = vars.length === 0 ? 0 : -Math.log(combos.length);
    for (const combo of combos) {
      const assign: Assignment = {};
      vars.forEach((v, i) => (assign[v] = combo[i]!));
      entries.push({ assign, logProb: lp });
    }
    return new Factor({ vars, domains, entries });
  }

  getLog(assign: Assignment): number {
    return this.logTable.get(this.keyFor(assign)) ?? -Infinity;
  }

  rowCount(): number {
    return this.logTable.size;
  }

  tableSize(): number {
    return this.vars.reduce((acc, v) => acc * this.domains[v]!.length, 1);
  }

  restrict(evidence: Assignment): Factor {
    const kept = this.vars.filter((v) => !(v in evidence));
    const entries: { assign: Assignment; logProb: number }[] = [];
    for (const [key, lp] of this.logTable) {
      const parts = key.split("\u0000");
      let match = true;
      const assign: Assignment = {};
      this.vars.forEach((v, i) => {
        const state = parts[i]!;
        if (v in evidence && evidence[v] !== state) match = false;
        assign[v] = state;
      });
      if (match) entries.push({ assign, logProb: lp });
    }
    return new Factor({ vars: kept, domains: this.domains, entries });
  }

  multiply(other: Factor): Factor {
    const vars = unionVars(this.vars, other.vars);
    const entries: { assign: Assignment; logProb: number }[] = [];
    const combos = cartesian(vars.map((v) => this.domains[v] ?? other.domains[v]!));
    for (const combo of combos) {
      const assign: Assignment = {};
      vars.forEach((v, i) => (assign[v] = combo[i]!));
      const lp = this.getLog(assign) + other.getLog(assign);
      entries.push({ assign, logProb: lp });
    }
    return new Factor({ vars, domains: { ...this.domains, ...other.domains }, entries });
  }

  marginalize(variable: string): Factor {
    const vars = this.vars.filter((v) => v !== variable);
    const acc = new Map<string, { assign: Assignment; lp: number }>();
    for (const [key, lp] of this.logTable) {
      const parts = key.split("\u0000");
      const assign: Assignment = {};
      vars.forEach((v) => {
        assign[v] = parts[this.vars.indexOf(v)]!;
      });
      const nk = vars.map((v) => assign[v]).join("\u0000");
      const prev = acc.get(nk);
      if (prev === undefined) acc.set(nk, { assign, lp });
      else prev.lp = logAddExp(prev.lp, lp);
    }
    return new Factor({
      vars,
      domains: this.domains,
      entries: [...acc.values()].map((v) => ({ assign: v.assign, logProb: v.lp })),
    });
  }

  rename(variables: string[]): Factor {
    const entries: { assign: Assignment; logProb: number }[] = [];
    for (const [key, lp] of this.logTable) {
      const parts = key.split("\u0000");
      const assign: Assignment = {};
      this.vars.forEach((v, i) => (assign[v] = parts[i]!));
      entries.push({ assign, logProb: lp });
    }
    return new Factor({ vars: variables, domains: this.domains, entries });
  }

  toRows(): { assign: Assignment; logProb: number }[] {
    const rows: { assign: Assignment; logProb: number }[] = [];
    for (const [key, lp] of this.logTable) {
      const parts = key.split("\u0000");
      const assign: Assignment = {};
      this.vars.forEach((v, i) => (assign[v] = parts[i]!));
      rows.push({ assign, logProb: lp });
    }
    return rows;
  }
}

export function cartesian(states: string[][]): string[][] {
  let out: string[][] = [[]];
  for (const list of states) {
    const next: string[][] = [];
    for (const prefix of out) for (const s of list) next.push([...prefix, s]);
    out = next;
  }
  return out;
}

export function unionVars(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...a, ...b]) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
