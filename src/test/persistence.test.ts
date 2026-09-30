import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFixture, makeService, tempDb } from "./helpers.js";
import { FIXTURE_REGISTRY } from "../fixtures.js";
import { BayesStore } from "../db.js";
import { BayesError } from "../errors.js";

test("事务回滚：非法新版本不影响旧版本", () => {
  const db = tempDb("rollback");
  const { store, svc } = makeService(db, "rb");
  loadFixture(svc, "chain", "net");
  const before = store.listVersions("net").length;
  const broken = FIXTURE_REGISTRY.chain().variables.map((v) =>
    v.id === "B"
      ? { ...v, cpt: { parents: ["A"], rows: [{ parentStates: ["t"], probs: [0.5, 0.5] }] } }
      : v,
  );
  assert.throws(
    () => svc.createNetwork({ baseNetworkId: "net", name: "broken", variables: broken }),
    (e: unknown) => e instanceof BayesError && e.code === "CPT_MISSING_ROW",
  );
  assert.equal(store.listVersions("net").length, before);
  assert.equal(store.latestVersion("net"), 1);
  store.close();
});

test("重启后持久化与旧版本隔离", () => {
  const db = tempDb("restart");
  {
    const { store, svc } = makeService(db, "p1");
    loadFixture(svc, "chain", "net");
    const f = FIXTURE_REGISTRY.chain().variables.map((v) =>
      v.id === "A" ? { ...v, cpt: { parents: [], rows: [{ parentStates: [], probs: [0.9, 0.1] }] } } : v,
    );
    svc.createNetwork({ baseNetworkId: "net", name: "chain v2", variables: f });
    svc.addEvidence(undefined, "net", 1, { B: "t" });
    const r = svc.query({ networkId: "net", version: 1, queryVars: ["A"], evidence: { B: "t" }, idempotencyKey: "k1" });
    assert.ok(r.queryId);
    store.close();
  }
  {
    const store2 = new BayesStore(db);
    const v1 = store2.loadNetwork("net", 1);
    const v2 = store2.loadNetwork("net", 2);
    assert.notDeepEqual(
      JSON.stringify(v1.data.variables.find((x) => x.id === "A")),
      JSON.stringify(v2.data.variables.find((x) => x.id === "A")),
    );
    const paged = store2.listFrozen("net", 10, 0);
    assert.ok(paged.total >= 1);
    const plan = store2.getQueryByIdempotency("net", "k1");
    assert.ok(plan);
    assert.ok(store2.getFrozenResult(plan!.query_id));
    store2.close();
  }
});

test("重复迁移可安全执行", () => {
  const db = tempDb("migrate");
  const store = new BayesStore(db);
  store.migrate();
  store.migrate();
  const rows = store.db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number };
  assert.ok(rows.c >= 1);
  store.close();
});

test("幂等查询：相同 key 返回相同冻结结果", () => {
  const db = tempDb("idempotent");
  const { store, svc } = makeService(db, "id");
  loadFixture(svc, "chain", "net");
  const r1 = svc.query({ networkId: "net", queryVars: ["C"], idempotencyKey: "same" });
  const r2 = svc.query({ networkId: "net", queryVars: ["C"], idempotencyKey: "same" });
  assert.equal(r1.queryId, r2.queryId);
  const all = store.listFrozen("net", 50, 0);
  const matches = all.items.filter((i) => (i as { queryId: string }).queryId === r1.queryId);
  assert.equal(matches.length, 1);
  store.close();
});

test("分页参数正确返回 total/items", () => {
  const db = tempDb("paging");
  const { store, svc } = makeService(db, "pg");
  loadFixture(svc, "chain", "net");
  for (let i = 0; i < 5; i++) svc.query({ networkId: "net", queryVars: ["C"] });
  const p1 = store.listFrozen("net", 2, 0);
  const p2 = store.listFrozen("net", 2, 2);
  assert.equal(p1.total, 5);
  assert.equal(p1.items.length, 2);
  assert.equal(p2.items.length, 2);
  store.close();
});

test("证据跨版本误用被拒绝", () => {
  const db = tempDb("evversion");
  const { store, svc } = makeService(db, "ev");
  loadFixture(svc, "chain", "net");
  const evidenceId = svc.addEvidence(undefined, "net", 1, { B: "t" });
  const f = FIXTURE_REGISTRY.chain().variables;
  svc.createNetwork({ baseNetworkId: "net", name: "v2", variables: f });
  assert.throws(
    () => svc.query({ networkId: "net", version: 2, evidenceId, queryVars: ["C"] }),
    (e: unknown) => e instanceof BayesError && e.code === "VERSION_MISMATCH",
  );
  store.close();
});
