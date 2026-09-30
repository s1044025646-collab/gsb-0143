import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { BayesService } from "./service.js";
import { BayesStore } from "./db.js";
import { BayesError } from "./errors.js";
import { FIXTURE_REGISTRY, fixtureNames } from "./fixtures.js";

export interface StartOptions {
  dbPath: string;
  pidFile: string;
  port?: number;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BayesError("VALIDATION", "请求体不是合法 JSON");
  }
}

function paginate(url: URL): { limit: number; offset: number; page: number } {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? "20") || 20));
  return { page, limit, offset: (page - 1) * limit };
}

export async function startServer(opts: StartOptions): Promise<{ server: Server; port: number; service: BayesService; store: BayesStore }> {
  mkdirSync(dirname(opts.pidFile), { recursive: true });
  const store = new BayesStore(opts.dbPath);
  const service = new BayesService(store);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/health") {
        send(res, 200, { status: "ok" });
        return;
      }

      if (method === "GET" && path === "/fixtures") {
        send(
          res,
          200,
          {
            fixtures: fixtureNames().map((key) => {
              const f = FIXTURE_REGISTRY[key]();
              return { name: key, displayName: f.name, description: f.description };
            }),
          },
        );
        return;
      }

      if (method === "GET" && path === "/networks") {
        const { limit, offset, page } = paginate(url);
        const { items, total } = store.listNetworks(limit, offset);
        send(res, 200, { page, limit, total, items });
        return;
      }

      const netMatch = path.match(/^\/networks\/([^/]+)$/);
      if (method === "GET" && netMatch) {
        const networkId = decodeURIComponent(netMatch[1]!);
        const version = url.searchParams.get("version") ? Number(url.searchParams.get("version")) : undefined;
        const loaded = store.loadNetwork(networkId, version);
        send(res, 200, loaded);
        return;
      }
      if (method === "POST" && path === "/networks") {
        const body = await readJson(req);
        const result = service.createNetwork({
          networkId: body.networkId,
          name: body.name,
          description: body.description,
          variables: body.variables,
          baseNetworkId: body.baseNetworkId,
        });
        send(res, 201, result);
        return;
      }

      const fixtureMatch = path.match(/^\/networks\/([^/]+)\/fixture\/([^/]+)$/);
      if (method === "POST" && fixtureMatch) {
        const networkId = decodeURIComponent(fixtureMatch[1]!);
        const name = fixtureMatch[2]! as keyof typeof FIXTURE_REGISTRY;
        if (!(name in FIXTURE_REGISTRY)) throw new BayesError("NOT_FOUND", `未知夹具: ${name}`);
        const fixture = FIXTURE_REGISTRY[name]();
        const result = service.createNetwork({
          networkId,
          name: fixture.name,
          description: fixture.description,
          variables: fixture.variables,
        });
        send(res, 201, result);
        return;
      }

      const versionsMatch = path.match(/^\/networks\/([^/]+)\/versions$/);
      if (method === "GET" && versionsMatch) {
        send(res, 200, { versions: store.listVersions(decodeURIComponent(versionsMatch[1]!)) });
        return;
      }

      const compareMatch = path.match(/^\/networks\/([^/]+)\/compare$/);
      if (method === "GET" && compareMatch) {
        const v1 = Number(url.searchParams.get("v1"));
        const v2 = url.searchParams.get("v2") ? Number(url.searchParams.get("v2")) : undefined;
        if (!Number.isInteger(v1)) throw new BayesError("VALIDATION", "需要整数 v1");
        send(res, 200, service.compareVersions(decodeURIComponent(compareMatch[1]!), v1, v2));
        return;
      }

      if (method === "POST" && path === "/evidence") {
        const body = await readJson(req);
        if (!body.networkId || !body.observations || typeof body.observations !== "object") {
          throw new BayesError("VALIDATION", "需要 networkId 与 observations");
        }
        const id = service.addEvidence(body.evidenceId, body.networkId, body.version, body.observations);
        send(res, 201, { evidenceId: id });
        return;
      }

      if (method === "POST" && path === "/query") {
        const body = await readJson(req);
        if (!body.networkId || !Array.isArray(body.queryVars) || body.queryVars.length === 0) {
          throw new BayesError("VALIDATION", "需要 networkId 与非空 queryVars 数组");
        }
        send(res, 200, service.query(body));
        return;
      }

      const marginalMatch = path.match(/^\/networks\/([^/]+)\/marginal\/([^/]+)$/);
      if (method === "POST" && marginalMatch) {
        const body = await readJson(req);
        send(
          res,
          200,
          service.marginal(
            { ...body, networkId: decodeURIComponent(marginalMatch[1]!) },
            decodeURIComponent(marginalMatch[2]!),
          ),
        );
        return;
      }

      if (method === "POST" && path === "/explain") {
        const body = await readJson(req);
        if (!body.networkId || !Array.isArray(body.queryVars) || body.queryVars.length === 0) {
          throw new BayesError("VALIDATION", "需要 networkId 与非空 queryVars 数组");
        }
        send(res, 200, service.explain(body));
        return;
      }

      if (method === "POST" && path === "/enumerate") {
        const body = await readJson(req);
        if (!body.networkId) throw new BayesError("VALIDATION", "需要 networkId");
        send(res, 200, { rows: service.enumerate(body.networkId, body.version) });
        return;
      }

      const resultsMatch = path.match(/^\/networks\/([^/]+)\/results$/);
      if (method === "GET" && resultsMatch) {
        const { limit, offset, page } = paginate(url);
        const { items, total } = store.listFrozen(decodeURIComponent(resultsMatch[1]!), limit, offset);
        send(res, 200, { page, limit, total, items });
        return;
      }

      if (method === "GET" && path.startsWith("/results/")) {
        const queryId = decodeURIComponent(path.split("/")[2]!);
        const result = store.getFrozenResult(queryId);
        if (!result) throw new BayesError("NOT_FOUND", "冻结结果不存在");
        send(res, 200, result);
        return;
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: `无此路由: ${method} ${path}` } });
    } catch (err) {
      if (err instanceof BayesError) {
        send(res, err.code === "NOT_FOUND" ? 404 : 400, {
          error: { code: err.code, message: err.message, details: err.details },
        });
      } else if ((err as { code?: string }).code === "NOT_FOUND") {
        send(res, 404, { error: { code: "NOT_FOUND", message: (err as Error).message } });
      } else {
        send(res, 500, { error: { code: "VALIDATION", message: (err as Error).message } });
      }
    }
  });

  const port = opts.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  writeFileSync(
    opts.pidFile,
    JSON.stringify({ pid: process.pid, port: address.port, startedAt: new Date().toISOString() }),
  );
  return { server, port: address.port, service, store };
}

export function readPidFile(pidFile: string): { pid: number; port: number } | null {
  if (!existsSync(pidFile)) return null;
  try {
    return JSON.parse(readFileSync(pidFile, "utf8"));
  } catch {
    return null;
  }
}
