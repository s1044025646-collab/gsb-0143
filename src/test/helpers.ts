import { rmSync } from "node:fs";
import { join } from "node:path";
import { BayesService } from "../service.js";
import { BayesStore } from "../db.js";
import { FIXTURE_REGISTRY } from "../fixtures.js";

export function tempDb(name: string): string {
  const dir = join(process.cwd(), ".bayes-test", name);
  rmSync(dir, { recursive: true, force: true });
  return join(dir, "test.sqlite");
}

export function makeService(dbPath: string, idPrefix = "q"): { store: BayesStore; svc: BayesService } {
  let n = 0;
  const store = new BayesStore(dbPath, () => "2026-01-01T00:00:00.000Z");
  const svc = new BayesService(store, () => `${idPrefix}-${(++n).toString().padStart(3, "0")}`);
  return { store, svc };
}

export function loadFixture(
  svc: BayesService,
  name: keyof typeof FIXTURE_REGISTRY,
  networkId: string = name,
): number {
  const f = FIXTURE_REGISTRY[name]();
  return svc
    .createNetwork({ networkId, name: f.name, description: f.description, variables: f.variables })
    .version;
}

export function approxEqual(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol;
}

export function distOf(rows: { assign: Record<string, string>; prob: number }[], key: string): number {
  return rows.find((r) => Object.values(r.assign)[0] === key)!.prob;
}
