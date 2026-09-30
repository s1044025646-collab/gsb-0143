export const EPS = 1e-12;

export function closeTo(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol;
}

export function logAddExp(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  if (a > b) return a + Math.log1p(Math.exp(b - a));
  return b + Math.log1p(Math.exp(a - b));
}

export function logSumExp(values: number[]): number {
  let acc = -Infinity;
  for (const v of values) acc = logAddExp(acc, v);
  return acc;
}

export function normalizeLogWeights(logs: number[]): number[] {
  const max = logs.reduce((m, v) => (v > m ? v : m), -Infinity);
  if (max === -Infinity) return logs.map(() => 0);
  const weights = logs.map((v) => Math.exp(v - max));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => w / total);
}
