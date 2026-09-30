#!/usr/bin/env node
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { BayesService } from "./service.js";
import { BayesStore } from "./db.js";
import { validateNetwork } from "./network.js";
import { BayesError } from "./errors.js";
import { FIXTURE_REGISTRY, fixtureNames } from "./fixtures.js";
import { startServer, readPidFile } from "./server.js";

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, ".bayes");
const DB_PATH = join(DATA_DIR, "bayes.sqlite");
const PID_FILE = join(DATA_DIR, "server.pid");

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = "true";
      else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function header(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function fail(err: unknown): never {
  if (err instanceof BayesError) {
    console.error(`错误 [${err.code}] ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details));
  } else if ((err as { code?: string }).code === "NOT_FOUND") {
    console.error(`错误 [NOT_FOUND] ${(err as Error).message}`);
  } else {
    console.error("错误", (err as Error).message);
  }
  process.exitCode = 1;
  throw err;
}

function withService<T>(fn: (svc: BayesService, store: BayesStore) => T): T {
  const store = new BayesStore(DB_PATH);
  try {
    return fn(new BayesService(store), store);
  } catch (err) {
    store.close();
    return fail(err);
  }
}

function printState(store: BayesStore): void {
  const { items } = store.listNetworks(50, 0);
  if (items.length === 0) {
    console.log("状态：当前数据库中没有任何网络。");
    return;
  }
  console.log("状态：当前网络列表 ->");
  for (const n of items) console.log(`  - ${n.network_id} @ v${n.version} (${n.name})`);
}

const [, , command, ...rest] = process.argv;
const { positional, flags } = parseArgs(rest);

try {
  switch (command) {
    case "fixtures": {
      console.log("可用虚构网络夹具：");
      for (const name of fixtureNames()) console.log(`  - ${name}: ${FIXTURE_REGISTRY[name]().name}`);
      break;
    }

    case "load-fixture": {
      const networkId = positional[0];
      const fixtureName = positional[1] as keyof typeof FIXTURE_REGISTRY | undefined;
      if (!networkId || !fixtureName || !(fixtureName in FIXTURE_REGISTRY)) {
        throw new BayesError("VALIDATION", "用法: bayes load-fixture <networkId> <fixtureName>");
      }
      withService((svc, store) => {
        header("操作前状态");
        printState(store);
        const fixture = FIXTURE_REGISTRY[fixtureName]();
        const result = svc.createNetwork({
          networkId,
          name: fixture.name,
          description: fixture.description,
          variables: fixture.variables,
        });
        header("操作后状态");
        console.log(`已冻结 ${networkId} @ v${result.version}（${fixture.name}）`);
        printState(store);
      });
      break;
    }

    case "validate": {
      const networkId = positional[0];
      if (!networkId) throw new BayesError("VALIDATION", "用法: bayes validate <networkId> [--version N]");
      withService((_svc, store) => {
        const version = flags.version ? Number(flags.version) : undefined;
        const { data, name } = store.loadNetwork(networkId, version);
        validateNetwork(data);
        console.log(`校验通过：${networkId}@v${data.version}「${name}」，变量 ${data.variables.length} 个，无环且 CPT 全部归一。`);
      });
      break;
    }

    case "evidence": {
      const networkId = positional[0];
      const pairs = positional.slice(1);
      if (!networkId || pairs.length === 0) {
        throw new BayesError("VALIDATION", "用法: bayes evidence <networkId> Var=State [Var=State ...]");
      }
      const observations: Record<string, string> = {};
      for (const p of pairs) {
        const [variable, state] = p.split("=");
        if (!variable || !state) throw new BayesError("VALIDATION", `证据格式错误: ${p}，应为 Var=State`);
        observations[variable] = state;
      }
      withService((svc, store) => {
        header("操作前状态");
        printState(store);
        const id = svc.addEvidence(flags["evidence-id"] || undefined, networkId, flags.version ? Number(flags.version) : undefined, observations);
        header("操作后状态");
        console.log(`证据集 ${id} 已保存：${JSON.stringify(observations)}`);
        console.log("注意：这是观测（条件化），不是 do() 因果干预。");
      });
      break;
    }

    case "query":
    case "marginal":
    case "explain": {
      const networkId = positional[0];
      const vars = positional.slice(1);
      if (!networkId || vars.length === 0) {
        throw new BayesError("VALIDATION", `用法: bayes ${command} <networkId> <Var> [Var ...] [--evidence-id ID] [--order minFill|minDegree|V1,V2] [--budget N]`);
      }
      const evidence: Record<string, string> = {};
      if (flags["evidence-json"]) Object.assign(evidence, JSON.parse(flags["evidence-json"]));
      let ordering: "minFill" | "minDegree" | string[] = flags.order === "minDegree" ? "minDegree" : "minFill";
      if (flags.order && flags.order !== "minFill" && flags.order !== "minDegree") ordering = flags.order.split(",");
      withService((svc) => {
        const common = {
          networkId,
          version: flags.version ? Number(flags.version) : undefined,
          evidenceId: flags["evidence-id"],
          evidence: Object.keys(evidence).length ? evidence : undefined,
          queryVars: vars,
          ordering,
          maxFactorRows: flags.budget ? Number(flags.budget) : undefined,
        };
        if (command === "marginal") {
          const result = svc.marginal(common, vars[0]!);
          header("边缘分布结果");
          console.log(`P(${result.variable}|e) = ${JSON.stringify(result.distribution)}`);
          console.log(`证据概率 P(e) = ${result.evidenceProbability}`);
          if (result.impossible) console.log("事件不可能（P(e)=0），未输出伪造后验。");
        } else if (command === "explain") {
          console.log(JSON.stringify(svc.explain(common), null, 2));
        } else {
          const result = svc.query(common);
          header("联合后验结果");
          for (const row of result.joint) {
            console.log(`P(${JSON.stringify(row.assign)} | e) = ${row.prob.toFixed(6)}  (log ${row.logProb})`);
          }
          console.log(`证据概率 P(e) = ${result.evidenceProbability}`);
          console.log(`消元顺序: ${result.orderUsed.join(" -> ")}；峰值中间行数: ${result.maxRows}`);
          console.log("查询已冻结，queryId =", result.queryId);
          if (result.impossible) console.log("零概率证据：事件不可能。");
        }
      });
      break;
    }

    case "compare": {
      const networkId = positional[0];
      const v1 = Number(positional[1]);
      if (!networkId || !Number.isInteger(v1)) {
        throw new BayesError("VALIDATION", "用法: bayes compare <networkId> <v1> [v2]");
      }
      withService((svc) => {
        console.log(JSON.stringify(svc.compareVersions(networkId, v1, positional[2] ? Number(positional[2]) : undefined), null, 2));
      });
      break;
    }

    case "list": {
      withService((_svc, store) => printState(store));
      break;
    }

    case "enumerate": {
      const networkId = positional[0];
      if (!networkId) throw new BayesError("VALIDATION", "用法: bayes enumerate <networkId>");
      withService((svc) => {
        const rows = svc.enumerate(networkId, flags.version ? Number(flags.version) : undefined);
        for (const r of rows) console.log(`${JSON.stringify(r.assign)}  p=${r.prob}`);
      });
      break;
    }

    case "serve": {
      const existing = readPidFile(PID_FILE);
      if (existing) {
        console.log(`服务已在运行：pid=${existing.pid} port=${existing.port}`);
        break;
      }
      startServer({ dbPath: DB_PATH, pidFile: PID_FILE, port: flags.port ? Number(flags.port) : undefined })
        .then(({ port }) => {
          console.log(`贝叶斯推断后端仅监听 http://127.0.0.1:${port}（本机回环）`);
          console.log(`数据库: ${DB_PATH}`);
          console.log("停止：npm run stop （仅终止本项目 pid 文件记录的进程）");
        })
        .catch(fail);
      break;
    }

    case "stop": {
      const info = readPidFile(PID_FILE);
      if (!info) {
        console.log("没有运行中的本项目服务。");
        break;
      }
      try {
        process.kill(info.pid, "SIGTERM");
        console.log(`已向本项目服务 pid=${info.pid} 发送 SIGTERM。`);
      } catch {
        console.log("进程已不存在，清理 pid 文件。");
      }
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
      break;
    }

    default:
      console.log(`离散贝叶斯网络精确推断后端

用法:
  bayes fixtures
  bayes list
  bayes load-fixture <networkId> <fixtureName>
  bayes validate <networkId> [--version N]
  bayes evidence <networkId> Var=State [...] [--evidence-id ID]
  bayes query <networkId> <Var> [Var ...] [--evidence-id ID] [--evidence-json '{"V":"s"}'] [--order minFill|minDegree|X,Y] [--budget N]
  bayes marginal <networkId> <Var> [同上选项]
  bayes explain <networkId> <Var> [...]
  bayes enumerate <networkId>
  bayes compare <networkId> <v1> [v2]
  bayes serve [--port 0]
  bayes stop

语义边界：观测 = 条件化 P(X|e)，不是因果干预 do(e)。`);
  }
} catch (err) {
  process.exitCode = 1;
  if (err instanceof BayesError) console.error(`错误 [${err.code}] ${err.message}`);
  else console.error((err as Error).message);
}
