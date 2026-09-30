import { LOG_ZERO, logAddExp, logSumExp } from "../logmath.js";
import type { VariableId } from "../types.js";

export interface FactorScope {
  variable: VariableId;
  states: string[];
}

let factorSeq = 0;
export function nextFactorId(prefix = "f"): string {
  factorSeq += 1;
  return `${prefix}${factorSeq}`;
}
export function resetFactorSeq(): void {
  factorSeq = 0;
}

export class Factor {
  readonly id: string;
  readonly scope: FactorScope[];
  readonly logValues: Float64Array;

  constructor(scope: FactorScope[], logValues: Float64Array, id?: string) {
    this.id = id ?? nextFactorId();
    this.scope = scope;
    const expected = scope.reduce((acc, s) => acc * s.states.length, 1);
    if (logValues.length !== expected) {
      throw new Error(
        `Factor ${this.id}: expected ${expected} cells, got ${logValues.length}`
      );
    }
    this.logValues = logValues;
  }

  get variables(): VariableId[] {
    return this.scope.map((s) => s.variable);
  }

  get cells(): number {
    return this.logValues.length;
  }

  indexOf(variable: VariableId): number {
    return this.scope.findIndex((s) => s.variable === variable);
  }

  stateIndex(variable: VariableId, state: string): number {
    const dim = this.scope[this.indexOf(variable)];
    if (!dim) return -1;
    return dim.states.indexOf(state);
  }

  static constant(value: number, id?: string): Factor {
    return new Factor([], Float64Array.of(value), id);
  }

  getLog(assignment: Record<string, string>): number {
    let index = 0;
    let stride = 1;
    for (let d = this.scope.length - 1; d >= 0; d--) {
      const dim = this.scope[d]!;
      const state = assignment[dim.variable];
      if (state === undefined) {
        throw new Error(`Factor ${this.id}: missing state for '${dim.variable}'`);
      }
      const si = dim.states.indexOf(state);
      if (si < 0) {
        throw new Error(`Factor ${this.id}: illegal state '${state}' for '${dim.variable}'`);
      }
      index += si * stride;
      stride *= dim.states.length;
    }
    return this.logValues[index]!;
  }

  enumerate(): Array<{ assignment: Record<string, string>; logValue: number }> {
    const out: Array<{ assignment: Record<string, string>; logValue: number }> = [];
    const walk = (dim: number, index: number, assignment: Record<string, string>): void => {
      if (dim === this.scope.length) {
        out.push({ assignment: { ...assignment }, logValue: this.logValues[index]! });
        return;
      }
      const s = this.scope[dim]!;
      let stride = 1;
      for (let k = dim + 1; k < this.scope.length; k++) {
        stride *= this.scope[k]!.states.length;
      }
      for (let si = 0; si < s.states.length; si++) {
        assignment[s.variable] = s.states[si]!;
        walk(dim + 1, index + si * stride, assignment);
      }
      delete assignment[s.variable];
    };
    walk(0, 0, {});
    return out;
  }
}

function mergeScope(a: Factor, b: Factor): FactorScope[] {
  const merged: FactorScope[] = a.scope.map((s) => ({ ...s }));
  for (const dim of b.scope) {
    const existing = merged.find((s) => s.variable === dim.variable);
    if (existing) {
      if (existing.states.join("|") !== dim.states.join("|")) {
        throw new Error(`Conflicting state definitions for variable '${dim.variable}'`);
      }
    } else {
      merged.push({ ...dim });
    }
  }
  return merged;
}

export function multiply(a: Factor, b: Factor, id?: string): Factor {
  if (a.scope.length === 0) {
    const c = a.logValues[0]!;
    if (c === 0) return new Factor(b.scope, b.logValues.slice(), id ?? b.id);
    return new Factor(b.scope, b.logValues.map((v) => v + c), id);
  }
  if (b.scope.length === 0) {
    const c = b.logValues[0]!;
    if (c === 0) return new Factor(a.scope, a.logValues.slice(), id ?? a.id);
    return new Factor(a.scope, a.logValues.map((v) => v + c), id);
  }

  const scope = mergeScope(a, b);
  const size = scope.reduce((acc, s) => acc * s.states.length, 1);
  const values = new Float64Array(size);

  const stridesA = stridesFor(scope, a);
  const stridesB = stridesFor(scope, b);
  const outStrides = stridesForScope(scope);

  for (let linear = 0; linear < size; linear++) {
    let rem = linear;
    let ia = 0;
    let ib = 0;
    for (let d = 0; d < scope.length; d++) {
      const stride = outStrides[d]!;
      const stateIdx = Math.floor(rem / stride);
      rem -= stateIdx * stride;
      ia += stateIdx * stridesA[d]!;
      ib += stateIdx * stridesB[d]!;
    }
    values[linear] = a.logValues[ia]! + b.logValues[ib]!;
  }
  return new Factor(scope, values, id);
}

function stridesForScope(scope: FactorScope[]): number[] {
  const strides = new Array<number>(scope.length).fill(0);
  let stride = 1;
  for (let d = scope.length - 1; d >= 0; d--) {
    strides[d] = stride;
    stride *= scope[d]!.states.length;
  }
  return strides;
}

function stridesFor(scope: FactorScope[], factor: Factor): number[] {
  return scope.map((dim) => {
    const idx = factor.indexOf(dim.variable);
    if (idx < 0) return 0;
    let stride = 1;
    for (let k = idx + 1; k < factor.scope.length; k++) {
      stride *= factor.scope[k]!.states.length;
    }
    return stride;
  });
}

export function restrict(
  factor: Factor,
  evidence: Record<string, string>,
  id?: string
): { factor: Factor; applied: string[] } {
  const applied: string[] = [];
  const keep: Array<{ dim: FactorScope; sourceDim: number }> = [];
  const fixed: Array<{ dimIdx: number; stateIdx: number }> = [];

  factor.scope.forEach((dim, dimIdx) => {
    const state = evidence[dim.variable];
    if (state !== undefined) {
      const si = dim.states.indexOf(state);
      if (si < 0) {
        throw new Error(`Illegal evidence state '${state}' for variable '${dim.variable}'`);
      }
      fixed.push({ dimIdx, stateIdx: si });
      applied.push(dim.variable);
    } else {
      keep.push({ dim: { ...dim }, sourceDim: dimIdx });
    }
  });

  if (fixed.length === 0) {
    return { factor: new Factor(factor.scope, factor.logValues.slice(), id ?? factor.id), applied };
  }

  const newScope = keep.map((k) => k.dim);
  const newSize = newScope.reduce((acc, s) => acc * s.states.length, 1);
  const values = new Float64Array(newSize);

  const oldStrides = stridesForScope(factor.scope);
  let fixedOffset = 0;
  for (const f of fixed) {
    fixedOffset += f.stateIdx * oldStrides[f.dimIdx]!;
  }

  const newStrides = stridesForScope(newScope);
  for (let linear = 0; linear < newSize; linear++) {
    let rem = linear;
    let oldIndex = fixedOffset;
    for (let d = 0; d < newScope.length; d++) {
      const strideN = newStrides[d]!;
      const stateIdx = Math.floor(rem / strideN);
      rem -= stateIdx * strideN;
      const sourceDim = keep[d]!.sourceDim;
      oldIndex += stateIdx * oldStrides[sourceDim]!;
    }
    values[linear] = factor.logValues[oldIndex]!;
  }
  return { factor: new Factor(newScope, values, id), applied };
}

export function sumOut(factor: Factor, variable: string, id?: string): Factor {
  const dimIdx = factor.indexOf(variable);
  if (dimIdx < 0) return factor;
  const card = factor.scope[dimIdx]!.states.length;
  const newScope = factor.scope.filter((_, i) => i !== dimIdx).map((s) => ({ ...s }));
  const newSize = newScope.reduce((acc, s) => acc * s.states.length, 1);
  const values = new Float64Array(newSize).fill(LOG_ZERO);

  const oldStrides = stridesForScope(factor.scope);
  const dimStride = oldStrides[dimIdx]!;
  const newStrides = newScope.length > 0 ? stridesForScope(newScope) : [];

  for (let linear = 0; linear < factor.logValues.length; linear++) {
    let target = 0;
    for (let d = 0; d < newScope.length; d++) {
      const sourceDim = d >= dimIdx ? d + 1 : d;
      const stride = oldStrides[sourceDim]!;
      const stateIdx = Math.floor(linear / stride) % factor.scope[sourceDim]!.states.length;
      target += stateIdx * newStrides[d]!;
    }
    const stateIdx = Math.floor(linear / dimStride) % card;
    void stateIdx;
    values[target] = logAddExp(values[target]!, factor.logValues[linear]!);
  }
  return new Factor(newScope, values, id);
}

export function totalLogMass(factor: Factor): number {
  return logSumExp(Array.from(factor.logValues));
}
