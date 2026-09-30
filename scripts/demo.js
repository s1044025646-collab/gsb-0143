import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(root, "data", "demo");
rmSync(dataDir, { recursive: true, force: true });

const env = { ...process.env, BN_DATA_DIR: dataDir, BN_DB: join(dataDir, "demo.sqlite") };
const cli = join(root, "dist", "cli", "index.js");

function run(label, args, allowFailure = false) {
  console.log(`\n=== ${label} ===`);
  console.log(`$ bn ${args.join(" ")}`);
  const result = spawnSync(process.execPath, ["--no-warnings", cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8"
  });
  process.stdout.write(result.stdout);
  if (result.status !== 0 && !allowFailure) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  if (result.status !== 0) {
    process.stderr.write(`(expected failure, exit ${result.status})\n`);
  }
}

run("load fixtures", ["init-fixture", "--name", "chain"]);
run("show network", ["show", "--id", "chain"]);
run("validate", ["validate", "--id", "chain"]);
run("store evidence (before/after)", [
  "evidence",
  "--id",
  "chain",
  "--name",
  "rained",
  "--set",
  "R=r1"
]);
run("marginal query", ["query", "--id", "chain", "--vars", "W", "--set", "R=r1"]);
run("step-by-step explanation", [
  "explain",
  "--id",
  "chain",
  "--vars",
  "W",
  "--set",
  "R=r1",
  "--ordering",
  "min-fill"
]);
run("idempotent replay", [
  "query",
  "--id",
  "chain",
  "--vars",
  "W",
  "--set",
  "R=r1",
  "--key",
  "demo-1"
]);
run("idempotent replay again", [
  "query",
  "--id",
  "chain",
  "--vars",
  "W",
  "--set",
  "R=r1",
  "--key",
  "demo-1"
]);
run("resource exhaustion (not impossibility)", [
  "query",
  "--id",
  "chain",
  "--vars",
  "W",
  "--budget",
  "1"
], true);
