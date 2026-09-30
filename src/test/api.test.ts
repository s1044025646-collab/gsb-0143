import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../server.js";
import type { Server } from "node:http";

const dir = join(process.cwd(), ".bayes-test", "api");
rmSync(dir, { recursive: true, force: true });

const started = await startServer({
  dbPath: join(dir, "api.sqlite"),
  pidFile: join(dir, "server.pid"),
  port: 0,
});
const base = `http://127.0.0.1:${started.port}`;

test.after(() => {
  started.server.close();
  started.store.close();
});

async function call(path: string, init?: RequestInit & { json?: unknown }): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
    headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test("健康检查与夹具列表", async () => {
  const h = await call("/health");
  assert.equal(h.status, 200);
  const f = await call("/fixtures");
  assert.ok(f.body.fixtures.length >= 6);
});

test("建网、查询、边缘、解释、冻结全流程", async () => {
  const created = await call("/networks/net1/fixture/chain", { json: {} });
  assert.equal(created.status, 201);
  const bad = await call("/networks", {
    json: { variables: [{ id: "A", states: ["x"], cpt: { parents: [], rows: [] } }] },
  });
  assert.equal(bad.status, 400);

  const q = await call("/query", { json: { networkId: "net1", queryVars: ["C"], evidence: { B: "t" } } });
  assert.equal(q.status, 200);
  assert.ok(Math.abs(q.body.evidenceProbability - 0.55) < 1e-9);

  const m = await call("/networks/net1/marginal/C", { json: { evidence: { B: "t" } } });
  assert.ok(Math.abs(m.body.distribution.t - 0.7) < 1e-9);

  const ex = await call("/explain", { json: { networkId: "net1", queryVars: ["C"] } });
  assert.ok(ex.body.steps.length >= 1);
  assert.match(ex.body.boundary, /do/);

  const results = await call("/networks/net1/results?page=1&limit=1");
  assert.equal(results.body.limit, 1);
  assert.equal(results.body.items.length, 1);
  assert.ok(results.body.total >= 3);
});

test("错误码：非法证据、资源不足、不存在网络", async () => {
  const badEv = await call("/query", { json: { networkId: "net1", queryVars: ["C"], evidence: { B: "zzz" } } });
  assert.equal(badEv.body.error.code, "BAD_EVIDENCE");
  const budget = await call("/query", { json: { networkId: "net1", queryVars: ["C"], maxFactorRows: 1 } });
  assert.equal(budget.body.error.code, "RESOURCE_EXHAUSTED");
  const missing = await call("/networks/ghost");
  assert.equal(missing.status, 404);
});

test("幂等键跨 HTTP 请求稳定", async () => {
  const a = await call("/query", { json: { networkId: "net1", queryVars: ["A"], idempotencyKey: "http-key" } });
  const b = await call("/query", { json: { networkId: "net1", queryVars: ["A"], idempotencyKey: "http-key" } });
  assert.equal(a.body.queryId, b.body.queryId);
});

test("服务仅绑定回环地址", () => {
  const addr = (started.server.address() as { address: string }).address;
  assert.ok(addr === "127.0.0.1" || addr === "::1");
});
