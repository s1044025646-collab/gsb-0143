import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, closeDatabase } from "./db.js";
import { Repository, systemClock } from "./repository.js";
import { BayesService } from "./service.js";
import { createApiServer, listenLocal } from "./api.js";

const dataDir = process.env.BN_DATA_DIR ?? join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.BN_DB ?? join(dataDir, "bayesnet.sqlite");

const db = openDatabase(dbPath);
const service = new BayesService(new Repository(db, systemClock()));
const server = createApiServer(service);

const port = await listenLocal(server, Number(process.env.BN_PORT ?? 0));
writeFileSync(join(dataDir, "server.port"), String(port), "utf8");

console.log(`BayesNet API listening on http://127.0.0.1:${port}`);
console.log(`Database: ${dbPath}`);

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  console.log(`Received ${signal}, stopping...`);
  server.close(() => {
    closeDatabase(db);
    console.log("Stopped.");
    process.exit(0);
  });
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
