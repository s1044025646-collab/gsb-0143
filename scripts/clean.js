import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.BN_DATA_DIR ?? join(root, "data");
const portFile = join(dataDir, "server.port");

if (existsSync(portFile)) {
  const port = readFileSync(portFile, "utf8").trim();
  console.log(`Stopping BayesNet server on port ${port}...`);
  const result = spawnSync("powershell", [
    "-NoProfile",
    "-Command",
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`
  ]);
  if (result.status !== 0) {
    console.log("No listener found or already stopped.");
  } else {
    console.log("Stop signal sent.");
  }
} else {
  console.log("No server.port file; nothing to stop.");
}

for (const name of ["demo", "api-test"]) {
  const target = join(dataDir, name);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}
for (const entry of ["test-"]) {
  const { readdirSync } = await import("node:fs");
  if (existsSync(dataDir)) {
    for (const child of readdirSync(dataDir)) {
      if (child.startsWith(entry)) {
        rmSync(join(dataDir, child), { recursive: true, force: true });
      }
    }
  }
}
console.log("Project-local temporary data cleaned.");
