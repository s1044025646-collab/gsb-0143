import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AppError, httpStatusFor } from "./errors.js";
import { BayesService, normalizePage } from "./service.js";
import type { NetworkSpec, QueryPlanInput } from "./types.js";

interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (ctx: RouteContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const paramNames: string[] = [];
  const regex = new RegExp(
    `^${path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
      paramNames.push(name);
      return "([^/]+)";
    })}$`
  );
  return { method, pattern: regex, paramNames, handler };
}

export function createApiServer(service: BayesService): Server {
  const routes: Route[] = [
    route("GET", "/health", () => ({ status: "ok" })),
    route("GET", "/networks", (ctx) =>
      service.listNetworks(pageFromQuery(ctx.query))
    ),
    route("POST", "/networks", (ctx) => {
      const body = ctx.body as { id?: string; name: string; spec: NetworkSpec };
      if (!body || typeof body !== "object") {
        throw new AppError("VALIDATION", "JSON body is required.");
      }
      return service.createNetwork({ id: body.id, name: body.name, spec: body.spec });
    }),
    route("GET", "/networks/:id", (ctx) => service.repo.requireNetwork(ctx.params.id!)),
    route("POST", "/networks/:id/validate", (ctx) =>
      service.validateNetwork(ctx.params.id!)
    ),
    route("GET", "/networks/:id/versions", (ctx) =>
      service.repo.listNetworkVersions(ctx.params.id!, normalizePage(pageFromQuery(ctx.query)))
    ),
    route("POST", "/networks/:id/revisions", (ctx) => {
      const body = ctx.body as { name: string; spec: NetworkSpec; newId?: string };
      return service.createRevision(ctx.params.id!, {
        name: body.name,
        spec: body.spec,
        newId: body.newId
      });
    }),
    route("POST", "/compare", (ctx) => {
      const body = ctx.body as { a: string; b: string };
      if (!body?.a || !body?.b) {
        throw new AppError("VALIDATION", "Body requires network ids 'a' and 'b'.");
      }
      return service.compareVersions(body.a, body.b);
    }),
    route("GET", "/networks/:id/evidence", (ctx) =>
      service.listEvidence(ctx.params.id!, pageFromQuery(ctx.query))
    ),
    route("POST", "/networks/:id/evidence", (ctx) => {
      const body = ctx.body as { name: string; evidence: Record<string, string> };
      if (!body?.name) throw new AppError("VALIDATION", "Evidence name is required.");
      return service.setEvidence(ctx.params.id!, body.name, body.evidence ?? {});
    }),
    route("GET", "/networks/:id/plans", (ctx) =>
      service.listPlans(ctx.params.id!, pageFromQuery(ctx.query))
    ),
    route("GET", "/networks/:id/results", (ctx) =>
      service.listResults(ctx.params.id!, pageFromQuery(ctx.query))
    ),
    route("POST", "/networks/:id/queries", (ctx) => {
      const body = ctx.body as { name?: string; plan: QueryPlanInput };
      if (!body?.plan) throw new AppError("VALIDATION", "Field 'plan' is required.");
      return service.runQuery(ctx.params.id!, body.name ?? "query", body.plan);
    }),
    route("POST", "/networks/:id/verify", (ctx) => {
      const body = ctx.body as { plan: QueryPlanInput };
      if (!body?.plan) throw new AppError("VALIDATION", "Field 'plan' is required.");
      return service.verifyByEnumeration(ctx.params.id!, body.plan);
    })
  ];

  return createServer((req, res) => {
    void handleRequest(req, res, routes);
  });
}

function pageFromQuery(query: URLSearchParams): { limit: number; offset: number } {
  return normalizePage({
    limit: query.has("limit") ? Number(query.get("limit")) : undefined,
    offset: query.has("offset") ? Number(query.get("offset")) : undefined
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  routes: Route[]
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body: unknown = undefined;
    if (req.method === "POST") {
      body = await readJson(req);
    }
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match![i + 1]!);
      });
      const data = await route.handler({ params, query: url.searchParams, body });
      sendJson(res, 200, { ok: true, data });
      return;
    }
    sendJson(res, 404, {
      ok: false,
      error: { code: "NOT_FOUND", message: `No route for ${req.method} ${url.pathname}` }
    });
  } catch (error) {
    if (error instanceof AppError) {
      sendJson(res, httpStatusFor(error.code), {
        ok: false,
        error: { code: error.code, message: error.message, details: error.details ?? null }
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 400, {
      ok: false,
      error: { code: "VALIDATION", message: `Malformed request: ${message}` }
    });
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new AppError("VALIDATION", "Request body exceeds 4 MiB limit."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError("VALIDATION", "Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

export interface ListenResult {
  port: number;
  server: Server;
}

export function listenLocal(server: Server, preferredPort = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve(address.port);
      } else {
        reject(new Error("Failed to acquire local port."));
      }
    });
  });
}
