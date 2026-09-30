import { rmSync } from "node:fs";
import { join } from "node:path";
import { BayesService } from "./service.js";
import { BayesStore } from "./db.js";
import { FIXTURE_REGISTRY } from "./fixtures.js";
import { BayesError } from "./errors.js";

const dataDir = join(process.cwd(), ".bayes-demo");
rmSync(dataDir, { recursive: true, force: true });

let counter = 0;
const fixedIds = () => `id-${(++counter).toString().padStart(4, "0")}`;
const store = new BayesStore(join(dataDir, "demo.sqlite"));
const svc = new BayesService(store, fixedIds);

function section(title: string): void {
  console.log(`\n----- ${title} -----`);
}

for (const [name, factory] of Object.entries(FIXTURE_REGISTRY)) {
  const f = factory();
  const { networkId, version } = svc.createNetwork({
    networkId: name,
    name: f.name,
    description: f.description,
    variables: f.variables,
  });
  section(`载入夹具 ${networkId} @ v${version}: ${f.name}`);
}

section("链网：先验边缘 P(C)");
console.log(svc.marginal({ networkId: "chain", queryVars: ["C"] }, "C"));

section("链网：观测 B=t 后 P(C|Bt) 与 P(e)");
console.log(svc.marginal({ networkId: "chain", evidence: { B: "t" }, queryVars: ["C"] }, "C"));

section("证据顺序不变性：{B=t,A=f} 与 {A=f,B=t}");
const o1 = svc.query({ networkId: "chain", evidence: { B: "t", A: "f" }, queryVars: ["C"] });
const o2 = svc.query({ networkId: "chain", evidence: { A: "f", B: "t" }, queryVars: ["C"] });
console.log("顺序1", o1.joint.map((r) => r.prob));
console.log("顺序2", o2.joint.map((r) => r.prob));

section("消元顺序一致性：minFill vs minDegree vs 自定义");
const q1 = svc.query({ networkId: "commonCause", queryVars: ["WetGrass"], evidence: { Rain: "yes" }, ordering: "minFill" });
const q2 = svc.query({ networkId: "commonCause", queryVars: ["WetGrass"], evidence: { Rain: "yes" }, ordering: "minDegree" });
const q3 = svc.query({ networkId: "commonCause", queryVars: ["WetGrass"], evidence: { Rain: "yes" }, ordering: ["Sprinkler"] });
console.log(q1.joint, q2.joint, q3.joint);

section("碰撞点：解释 P(Burglary|Alarm=t)（含逐步消元）");
console.log(JSON.stringify(svc.explain({ networkId: "collider", evidence: { Alarm: "t" }, queryVars: ["Burglary"] }), null, 2));

section("确定性 XOR：观测 C=0 后 A、B 必须一致");
console.log(svc.query({ networkId: "deterministic", evidence: { C: "0" }, queryVars: ["A", "B"] }));

section("不可能证据：P(B=t|A=t)=0，应报告 impossible，不伪造后验");
const imp = svc.query({ networkId: "impossible", evidence: { A: "t", B: "t" }, queryVars: ["C"] });
console.log({ impossible: imp.impossible, evidenceProbability: imp.evidenceProbability, joint: imp.joint });

section("非法证据应拒绝（B=不存在状态）");
try {
  svc.query({ networkId: "chain", evidence: { B: "nope" }, queryVars: ["C"] });
} catch (e) {
  console.log((e as BayesError).code, (e as Error).message);
}

section("资源预算：maxFactorRows=1 应报告 RESOURCE_EXHAUSTED，而非不可能");
try {
  svc.query({ networkId: "commonCause", queryVars: ["WetGrass"], maxFactorRows: 1 });
} catch (e) {
  console.log((e as BayesError).code, (e as BayesError).details);
}

section("版本比较：commonCause 修改为新版本");
const v2 = svc.createNetwork({
  baseNetworkId: "commonCause",
  name: "共同原因 v2（改 Rain 先验）",
  variables: (() => {
    const { data } = store.loadNetwork("commonCause", 1);
    return data.variables.map((v) =>
      v.id === "Rain"
        ? { ...v, cpt: { parents: [], rows: [{ parentStates: [], probs: [0.5, 0.5] }] } }
        : v,
    );
  })(),
});
console.log(v2, svc.compareVersions("commonCause", 1, v2.version));

section("幂等：相同 idempotencyKey 重复提交返回同一 queryId");
const r1 = svc.query({ networkId: "chain", queryVars: ["A"], idempotencyKey: "demo-key-1" });
const r2 = svc.query({ networkId: "chain", queryVars: ["A"], idempotencyKey: "demo-key-1" });
console.log({ first: r1.queryId, second: r2.queryId, same: r1.queryId === r2.queryId });

section("冻结结果分页");
const page1 = store.listFrozen("chain", 2, 0);
console.log({ total: page1.total, returned: page1.items.length });

section("观测 vs 干预边界声明");
console.log("观测改变概率分布；do() 干预会删除入边，本系统不执行干预演算。");

store.close();
console.log("\n演示完成，数据全部保留在", dataDir, "（可用后直接删除该目录清理）。");
