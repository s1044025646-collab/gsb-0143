import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { openDatabase, closeDatabase } from "../src/db.js";
import type { DatabaseSync } from "node:sqlite";
import { Repository } from "../src/repository.js";
import { BayesService } from "../src/service.js";
import { createApiServer, listenLocal } from "../src/api.js";
import type { Server } from "node:http";
import { chainFixture } from "../src/fixtures.js";

const dir = join(process.cwd(), "data", "api-test");
const dbPath = join(dir, "api.sqlite");

describe("HTTP API end-to-end", () => {
  let db: DatabaseSync;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    mkdirSync(dir, { recursive: true });
    db = openDatabase(dbPath);
    const service = new BayesService(new Repository(db));
    server = createApiServer(service);
    const port = await listenLocal(server, 0);
    baseUrl = `http://127.0.0.1:${port}`;
    service.createNetwork({ id: "chain", name: "Chain", spec: chainFixture() });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = (await response.json()) as {
      ok: boolean;
      data?: unknown;
      error?: { code: string; message: string };
    };
    return { status: response.status, payload };
  }

  test("health and pagination", async () => {
    const health = await call("GET", "/health");
    expect(health.status).toBe(200);
    const networks = await call("GET", "/networks?limit=10&offset=0");
    expect(networks.payload.ok).toBe(true);
    expect((networks.payload.data as { total: number }).total).toBe(1);
  });

  test("runs a query and validates probability payload", async () => {
    const result = await call("POST", "/networks/chain/queries", {
      name: "wet-given-rain",
      plan: { variables: ["W"], evidence: { R: "r1" }, idempotencyKey: "k-1" }
    });
    expect(result.status).toBe(200);
    const data = result.payload.data as {
      reused: boolean;
      result: { posterior: Array<{ probability: number }>; evidenceProbability: number };
    };
    const total = data.result.posterior.reduce((sum, p) => sum + p.probability, 0);
    expect(total).toBeCloseTo(1, 9);

    const replay = await call("POST", "/networks/chain/queries", {
      name: "wet-given-rain",
      plan: { variables: ["W"], evidence: { R: "r1" }, idempotencyKey: "k-1" }
    });
    expect((replay.payload.data as { reused: boolean }).reused).toBe(true);
  });

  test("returns explicit error code for illegal evidence", async () => {
    const response = await call("POST", "/networks/chain/queries", {
      plan: { variables: ["W"], evidence: { R: "nope" } }
    });
    expect(response.status).toBe(422);
    expect(response.payload.error?.code).toBe("ILLEGAL_EVIDENCE");
  });

  test("returns explicit error code for resource exhaustion", async () => {
    const response = await call("POST", "/networks/chain/queries", {
      plan: {
        variables: ["W"],
        evidence: {},
        factorCellBudget: 1
      }
    });
    expect(response.status).toBe(422);
    expect(response.payload.error?.code).toBe("RESOURCE_EXHAUSTED");
  });

  test("rejects malformed JSON", async () => {
    const response = await fetch(`${baseUrl}/networks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json"
    });
    expect(response.status).toBe(400);
  });

  test("unknown route returns 404", async () => {
    const response = await call("GET", "/nope");
    expect(response.status).toBe(404);
  });
});
