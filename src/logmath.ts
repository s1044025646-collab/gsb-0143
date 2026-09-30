export const LOG_ZERO = -Infinity;
export const ZERO_TOLERANCE = 1e-9;

export function logAddExp(a: number, b: number): number {
  if (a === LOG_ZERO) return b;
  if (b === LOG_ZERO) return a;
  if (a < b) {
    const t = a;
    a = b;
    b = t;
  }
  return a + Math.log1p(Math.exp(b - a));
}

export function logSumExp(values: number[]): number {
  let acc = LOG_ZERO;
  for (const v of values) acc = logAddExp(acc, v);
  return acc;
}

export function logProb(p: number): number {
  if (p < 0) {
    return NaN;
  }
  if (p === 0) return LOG_ZERO;
  return Math.log(p);
}

export function expLog(lp: number): number {
  if (lp === LOG_ZERO) return 0;
  return Math.exp(lp);
}

export function normalizedLogProbs(logProbs: number[]): number[] {
  const total = logSumExp(logProbs);
  if (total === LOG_ZERO || Number.isNaN(total)) {
    return logProbs.map(() => 0);
  }
  return logProbs.map((lp) => (lp === LOG_ZERO ? 0 : Math.exp(lp - total)));
}

export function approxEqual(a: number, b: number, tol = 1e-7): boolean {
  if (Math.abs(a - b) <= tol) return true;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= tol * scale;
}
