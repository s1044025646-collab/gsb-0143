import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, closeDatabase, migrate } from "../src/db.js";
import { Repository, type Clock } from "../src/repository.js";
import { BayesService } from "../src/service.js";
import { AppError } from "../src/errors.js";
import { chainFixture } from "../src/fixtures.js";
import type { NetworkSpec } from "../src/types.js";

function deterministicClock(start = "2026-01-01T00:00:00.000Z"): Clock & {
  tick(ms: number): void;
} {
  let current = new Date(start).getTime();
  let counter = 0;
  return {
    now: () => new Date(current),
    randomId: () => `id-${(counter++).toString(16).padStart(4, "0")}`,
    tick(ms: number) {
      current += ms;
    }
  };
}

describe("service persistence", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    mkdirSync(join(process.cwd(), "data"), { recursive: true });
    dir = mkdtempSync(join(process.cwd(), "data", "test-"));
    dbPath = join(dir, "test.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeService() {
    const db = openDatabase(dbPath);
    return {
      db,
      service: new BayesService(new Repository(db, deterministicClock()))
    };
  }

  test("network and query survive a restart", () => {
    {
      const { db, service } = makeService();
      service.createNetwork({ id: "chain", name: "Chain", spec: chainFixture() });
      const result = service.runQuery("chain", "q", {
        variables: ["W"],
        evidence: { R: "r1" }
      });
      expect(result.result.evidenceProbability).toBeGreaterThan(0);
      closeDatabase(db);
    }
    {
      const { db, service } = makeService();
      const page = service.listNetworks({ limit: 10, offset: 0 });
      expect(page.total).toBe(1);
      const results = service.listResults("chain", { limit: 10, offset: 0 });
      expect(results.total).toBe(1);
      const frozen = (results.items[0] as { result: { posterior: unknown[] } }).result;
      expect(frozen.posterior).toHaveLength(2);
      closeDatabase(db);
    }
  });

  test("migrations are repeatable", () => {
    const db = openDatabase(dbPath);
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();
    closeDatabase(db);
  });

  test("duplicate submission with idempotency key replays the frozen result", () => {
    const { db, service } = makeService();
    service.createNetwork({ id: "chain", name: "Chain", spec: chainFixture() });
    const plan = {
      variables: ["W"],
      evidence: { R: "r1" },
      idempotencyKey: "run-1"
    };
    const first = service.runQuery("chain", "q", plan);
    const second = service.runQuery("chain", "q", plan);
    expect(second.reused).toBe(true);
    expect(second.planId).toBe(first.planId);
    expect(second.resultId).toBe(first.resultId);
    expect(service.listResults("chain", { limit: 100, offset: 0 }).total).toBe(1);
    closeDatabase(db);
  });

  test("rollback occurs when inference fails after plan insert", () => {
    const { db, service } = makeService();
    service.createNetwork({ id: "chain", name: "Chain", spec: chainFixture() });
    expect(() =>
      service.runQuery("chain", "bad", {
        variables: ["W"],
        evidence: { R: "r1" },
        factorCellBudget: 1
      })
    ).toThrow(AppError);
    expect(service.listPlans("chain", { limit: 100, offset: 0 }).total).toBe(0);
    expect(service.listResults("chain", { limit: 100, offset: 0 }).total).toBe(0);
    closeDatabase(db);
  });

  test("old version is isolated and archived after revision", () => {
    const { db, service } = makeService();
    service.createNetwork({ id: "chain", name: "Chain", spec: chainFixture() });
    service.runQuery("chain", "old", { variables: ["W"], evidence: {} });

    const modified: NetworkSpec = JSON.parse(JSON.stringify(chainFixture()));
    modified.nodes[0]!.cpt[0]!.probabilities = { r0: 0.5, r1: 0.5 };
    const revision = service.createRevision("chain", { name: "Chain v2", spec: modified });

    expect(service.repo.requireNetwork("chain").status).toBe("archived");
    expect(revision.status).toBe("active");
    expect(() =>
      service.runQuery("chain", "should-fail", { variables: ["W"], evidence: {} })
    ).toThrow(AppError);

    const fresh = service.runQuery(revision.id, "new", { variables: ["W"], evidence: {} });
    const oldResults = service.listResults("chain", { limit: 100, offset: 0 });
    const newResults = service.listResults(revision.id, { limit: 100, offset: 0 });
    expect(oldResults.total).toBe(1);
    expect(newResults.total).toBe(1);
    const frozen = service.repo.getResultByPlan(fresh.planId)!;
    expect(frozen.networkVersion).toBe(revision.version);

    const diff = service.compareVersions("chain", revision.id);
    expect(diff.changedNodes).toContain("R");
    closeDatabase(db);
  });

  test("pagination enforces bounds", () => {
    const { db, service } = makeService();
    service.createNetwork({ id: "chain", name: "Chain", spec: chainFixture() });
    const page = service.listNetworks({ limit: 1, offset: 0 });
    expect(page.limit).toBe(1);
    expect(page.total).toBe(1);
    expectCode(() => service.listNetworks({ limit: 0 }), "VALIDATION");
    expectCode(() => service.listNetworks({ limit: 201 }), "VALIDATION");
    expectCode(() => service.listNetworks({ offset: -1 }), "VALIDATION");
    closeDatabase(db);
  });

  test("invalid evidence is rejected before persistence", () => {
    const { db, service } = makeService();
    service.createNetwork({ id: "chain", name: "Chain", spec: chainFixture() });
    expectCode(() => service.setEvidence("chain", "bad", { R: "ghost" }), "ILLEGAL_EVIDENCE");
    expect(service.listEvidence("chain", { limit: 10, offset: 0 }).total).toBe(0);
    closeDatabase(db);
  });

  test("data file is created inside the requested project directory", () => {
    const { db } = makeService();
    closeDatabase(db);
    expect(existsSync(dbPath)).toBe(true);
  });
});

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`Expected AppError with code ${code}`);
}

