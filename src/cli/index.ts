#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, closeDatabase } from "../db.js";
import { Repository, systemClock } from "../repository.js";
import { BayesService } from "../service.js";
import { AppError } from "../errors.js";
import { BayesianNetwork } from "../inference/network.js";
import {
  chainFixture,
  colliderFixture,
  commonCauseFixture,
  deterministicFixture,
  independentFixture
} from "../fixtures.js";
import type { NetworkSpec, QueryPlanInput } from "../types.js";

const dataDir = process.env.BN_DATA_DIR ?? join(process.cwd(), "data");
const dbPath = process.env.BN_DB ?? join(dataDir, "bayesnet.sqlite");

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Map<string, string> } {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function loadSpec(path: string): NetworkSpec {
  if (!existsSync(path)) {
    throw new AppError("NOT_FOUND", `Spec file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as NetworkSpec;
}

function parseEvidence(text: string | undefined): Record<string, string> {
  if (!text) return {};
  const evidence: Record<string, string> = {};
  for (const pair of text.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new AppError("VALIDATION", `Evidence pair '${trimmed}' must look like Var=state.`);
    }
    evidence[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return evidence;
}

function parseOrdering(text: string | undefined): QueryPlanInput["ordering"] {
  if (!text) return undefined;
  if (text === "min-fill" || text === "min-degree") return text;
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

const HELP = `
bn - discrete Bayesian network exact inference CLI

Usage:
  bn init-fixture --name independent|chain|common-cause|collider|deterministic
  bn create --file network.json
  bn validate --id <network-id>
  bn show --id <network-id>
  bn list [--limit 50] [--offset 0]
  bn evidence --id <network-id> --name ev1 --set R=r1,W=w1
  bn query --id <network-id> --vars R,W --set R=r1 [--ordering min-fill] [--budget 1000000] [--key idem-1]
  bn explain --id <network-id> --vars W --set R=r1
  bn revise --id <network-id> --file network-v2.json
  bn compare --a <id-a> --b <id-b>
  bn help

All data is stored under ./data (override with BN_DATA_DIR / BN_DB).
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = openDatabase(dbPath);
  try {
    const service = new BayesService(new Repository(db, systemClock()));

    switch (args.command) {
      case "help":
      case "--help":
      case "-h":
        console.log(HELP);
        break;

      case "init-fixture": {
        const fixtures: Record<string, () => NetworkSpec> = {
          independent: independentFixture,
          chain: chainFixture,
          "common-cause": commonCauseFixture,
          collider: colliderFixture,
          deterministic: deterministicFixture
        };
        const name = args.flags.get("name") ?? args.positional[0];
        const factory = name ? fixtures[name] : undefined;
        if (!factory) {
          throw new AppError("VALIDATION", `Choose one of: ${Object.keys(fixtures).join(", ")}`);
        }
        const spec = factory();
        const before = service.listNetworks({ limit: 1, offset: 0 }).total;
        const record = service.createNetwork({ id: spec.id, name: spec.name, spec });
        const after = service.listNetworks({ limit: 200, offset: 0 }).total;
        console.log(`Networks before: ${before}, after: ${after}`);
        console.log(`Created fixture network '${record.id}' version ${record.version}.`);
        break;
      }

      case "create": {
        const spec = loadSpec(requireFlag(args, "file"));
        const before = service.listNetworks({ limit: 200, offset: 0 }).total;
        const record = service.createNetwork({
          id: args.flags.get("id") ?? spec.id,
          name: spec.name ?? args.flags.get("name") ?? spec.id,
          spec
        });
        const after = service.listNetworks({ limit: 200, offset: 0 }).total;
        console.log(`Networks before: ${before}, after: ${after}`);
        console.log(`Created network '${record.id}' (version ${record.version}).`);
        break;
      }

      case "validate": {
        const id = requireFlag(args, "id");
        const before = service.repo.requireNetwork(id).status;
        const result = service.validateNetwork(id);
        const after = service.repo.requireNetwork(id).status;
        console.log(`Status: ${before} -> ${after}`);
        console.log(`Network '${id}' is valid with ${result.nodeCount} node(s).`);
        break;
      }

      case "show": {
        const id = requireFlag(args, "id");
        const record = service.repo.requireNetwork(id);
        const network = BayesianNetwork.validate(record.spec);
        console.log(`Network '${record.id}' v${record.version} [${record.status}] - ${record.name}`);
        for (const node of network.topologicalOrder()) {
          const def = network.nodes.get(node)!;
          console.log(
            `  ${node} states=[${def.states.join(", ")}] parents=[${def.parents.join(", ")}] cptRows=${def.cpt.size}`
          );
        }
        break;
      }

      case "list": {
        const page = service.listNetworks({
          limit: args.flags.has("limit") ? Number(args.flags.get("limit")) : undefined,
          offset: args.flags.has("offset") ? Number(args.flags.get("offset")) : undefined
        });
        console.log(`Networks ${page.offset + 1}-${page.offset + page.items.length} of ${page.total}:`);
        for (const n of page.items) {
          console.log(`  ${n.id} v${n.version} [${n.status}] ${n.name}`);
        }
        break;
      }

      case "evidence": {
        const id = requireFlag(args, "id");
        const name = requireFlag(args, "name");
        const evidence = parseEvidence(args.flags.get("set"));
        const before = service.listEvidence(id, { limit: 200, offset: 0 }).total;
        const saved = service.setEvidence(id, name, evidence);
        const after = service.listEvidence(id, { limit: 200, offset: 0 }).total;
        console.log(`Evidence sets before: ${before}, after: ${after}`);
        console.log(`Stored evidence '${saved.name}' (${saved.id}): ${formatEvidence(saved.evidence)}`);
        break;
      }

      case "query":
      case "explain": {
        const id = requireFlag(args, "id");
        const variables = requireFlag(args, "vars")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        let evidence = parseEvidence(args.flags.get("set"));
        const evidenceRef = args.flags.get("evidence-name");
        if (evidenceRef) {
          const saved = service.repo.getEvidenceByName(id, evidenceRef);
          if (!saved) {
            throw new AppError("NOT_FOUND", `Evidence set '${evidenceRef}' not found.`);
          }
          evidence = { ...saved.evidence, ...evidence };
          console.log(`Using stored evidence '${saved.name}': ${formatEvidence(saved.evidence)}`);
        }
        const plan: QueryPlanInput = {
          variables,
          evidence,
          ordering: parseOrdering(args.flags.get("ordering")),
          factorCellBudget: args.flags.has("budget")
            ? Number(args.flags.get("budget"))
            : undefined,
          idempotencyKey: args.flags.get("key")
        };
        const before = service.listResults(id, { limit: 200, offset: 0 }).total;
        const queryResult = service.runQuery(id, "cli-query", plan);
        const after = service.listResults(id, { limit: 200, offset: 0 }).total;
        console.log(
          `Frozen results before: ${before}, after: ${after}${queryResult.reused ? " (idempotent replay)" : ""}`
        );
        const { result } = queryResult;
        console.log(`Evidence: ${formatEvidence(result.evidence)}`);
        console.log(
          `P(evidence) = ${result.evidenceProbability.toExponential(6)} (log = ${result.logEvidenceProbability.toFixed(6)})`
        );
        if (result.impossible) {
          console.log("IMPOSSIBLE EVENT: evidence has probability 0; no posterior is fabricated.");
        } else {
          console.log(`Joint posterior P(${variables.join(",")} | evidence):`);
          for (const entry of result.posterior) {
            console.log(
              `  ${formatAssignment(entry.assignment)}  p=${entry.probability.toFixed(6)}  logP=${entry.logProbability.toFixed(6)}`
            );
          }
        }
        console.log(result.note);
        if (args.command === "explain") {
          console.log("\nStep-by-step variable elimination:");
          if (result.eliminationSteps.length === 0) {
            console.log("  (no hidden variables to eliminate)");
          }
          for (const step of result.eliminationSteps) {
            console.log(
              `  ${step.step}. eliminate ${step.eliminated}: join [${step.factorsIn.join(", ")}] ` +
                `(${step.factorCellsBefore} cells) -> ${step.factorOut} (${step.factorCellsAfter} cells)`
            );
          }
          console.log(`Ordering used: ${result.ordering.join(", ") || "(none)"}`);
          console.log(`Peak factor size: ${result.peakCells} cells`);
        }
        break;
      }

      case "revise": {
        const id = requireFlag(args, "id");
        const spec = loadSpec(requireFlag(args, "file"));
        const before = service.repo.requireNetwork(id);
        const revision = service.createRevision(id, {
          name: spec.name ?? before.name,
          spec,
          newId: args.flags.get("new-id")
        });
        const afterOld = service.repo.requireNetwork(id);
        console.log(`'${id}' status: ${before.status} -> ${afterOld.status}`);
        console.log(
          `Created revision '${revision.id}' v${revision.version} (parent ${id} v${before.version}).`
        );
        break;
      }

      case "compare": {
        const diff = service.compareVersions(requireFlag(args, "a"), requireFlag(args, "b"));
        console.log(
          `Comparing ${diff.a.id} v${diff.a.version} with ${diff.b.id} v${diff.b.version}:`
        );
        console.log(`  added nodes   : ${diff.addedNodes.join(", ") || "-"}`);
        console.log(`  removed nodes : ${diff.removedNodes.join(", ") || "-"}`);
        console.log(`  changed nodes : ${diff.changedNodes.join(", ") || "-"}`);
        break;
      }

      default:
        throw new AppError("VALIDATION", `Unknown command '${args.command}'. Run 'bn help'.`);
    }
  } finally {
    closeDatabase(db);
  }
}

function requireFlag(args: ReturnType<typeof parseArgs>, name: string): string {
  const value = args.flags.get(name);
  if (value === undefined) {
    throw new AppError("VALIDATION", `Missing required flag --${name}.`);
  }
  return value;
}

function formatEvidence(evidence: Record<string, string>): string {
  const text = Object.entries(evidence)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return text || "(none)";
}

function formatAssignment(assignment: Record<string, string>): string {
  return Object.entries(assignment)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

main().catch((error: unknown) => {
  if (error instanceof AppError) {
    console.error(`Error [${error.code}]: ${error.message}`);
    if (error.details !== undefined) {
      console.error(JSON.stringify(error.details));
    }
  } else {
    console.error("Error:", error instanceof Error ? error.message : error);
  }
  process.exit(1);
});
