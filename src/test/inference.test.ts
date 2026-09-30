import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFactors } from "../network.js";
import { runInference, enumerateAll } from "../inference.js";
import { FIXTURE_REGISTRY } from "../fixtures.js";
import { BayesError } from "../errors.js";
import type { NetworkData } from "../network.js";

function prepare(name: keyof typeof FIXTURE_REGISTRY) {
  const f = FIXTURE_REGISTRY[name]();
  const net: NetworkData = { networkId: name, version: 1, variables: f.variables };
  const factors = buildFactors(net);
  const domains = Object.fromEntries(f.variables.map((v) => [v.id, v.states]));
  return { factors, domains };
}

test("穷举联合分布归一化（全部夹具）", () => {
  for (const name of Object.keys(FIXTURE_REGISTRY) as (keyof typeof FIXTURE_REGISTRY)[]) {
    const { factors, domains } = prepare(name);
    const rows = enumerateAll(factors, domains);
    const total = rows.reduce((a, r) => a + r.prob, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${name} 穷举总和=${total}`);
  }
});

test("独立节点：P(A) 等于先验，且 VE 与穷举一致", () => {
  const { factors, domains } = prepare("independent");
  const r = runInference({
    factors,
    domains,
    queryVars: ["A"],
    evidence: {},
    order: "minFill",
    budget: { maxFactorRows: 1000 },
  });
  const pA0 = r.joint.find((x) => x.assign.A === "a0")!.prob;
  assert.ok(Math.abs(pA0 - 0.3) < 1e-12);
  assert.ok(Math.abs(r.evidenceProbability - 1) < 1e-12);
  const enumRows = enumerateAll(factors, domains);
  const enumA0 = enumRows.filter((x) => x.assign.A === "a0").reduce((a, x) => a + x.prob, 0);
  assert.ok(Math.abs(pA0 - enumA0) < 1e-9);
});

test("链网：贝叶斯手算 P(B=t|A=f)=0.2，P(C=t)=0.43", () => {
  const { factors, domains } = prepare("chain");
  const prior = runInference({ factors, domains, queryVars: ["C"], evidence: {}, order: "minFill", budget: { maxFactorRows: 1000 } });
  assert.ok(Math.abs(prior.joint.find((r) => r.assign.C === "t")!.prob - 0.43) < 1e-12);
  const post = runInference({ factors, domains, queryVars: ["A"], evidence: { B: "t" }, order: "minFill", budget: { maxFactorRows: 1000 } });
  const pAf = post.joint.find((r) => r.assign.A === "f")!.prob;
  const expected = (0.2 * 0.5) / (0.5 * 0.9 + 0.5 * 0.2);
  assert.ok(Math.abs(pAf - expected) < 1e-9);
  assert.ok(Math.abs(post.evidenceProbability - 0.55) < 1e-12);
});

test("碰撞点：条件化对撞机解释报警", () => {
  const { factors, domains } = prepare("collider");
  const r = runInference({ factors, domains, queryVars: ["Burglary"], evidence: { Alarm: "t" }, order: "minFill", budget: { maxFactorRows: 1000 } });
  const p = r.joint.find((x) => x.assign.Burglary === "t")!.prob;
  assert.ok(p > 0.28 && p < 0.3, `P(B=t|A=t)=${p}`);
});

test("确定性 XOR：零概率组合被保留，条件后验只允许 A=B", () => {
  const { factors, domains } = prepare("deterministic");
  const all = enumerateAll(factors, domains);
  for (const row of all) {
    const xor = row.assign.A === row.assign.B ? "0" : "1";
    if (row.assign.C === xor) assert.ok(row.prob === 0.25, `合法组合概率=${row.prob}`);
    else assert.equal(row.prob, 0);
  }
  const r = runInference({ factors, domains, queryVars: ["A", "B"], evidence: { C: "0" }, order: "minFill", budget: { maxFactorRows: 1000 } });
  for (const row of r.joint) {
    if (row.assign.A !== row.assign.B) assert.equal(row.prob, 0);
    else assert.ok(Math.abs(row.prob - 0.5) < 1e-9);
  }
});

test("不可能证据：impossible=true，P(e)=0，后验全零而非伪造", () => {
  const { factors, domains } = prepare("impossible");
  const r = runInference({ factors, domains, queryVars: ["C"], evidence: { A: "t", B: "t" }, order: "minFill", budget: { maxFactorRows: 1000 } });
  assert.equal(r.impossible, true);
  assert.equal(r.evidenceProbability, 0);
  assert.equal(r.logEvidence, -Infinity);
  assert.ok(r.joint.every((j) => j.prob === 0 && j.logProb === -Infinity));
});

test("证据顺序不变性", () => {
  const { factors, domains } = prepare("chain");
  const r1 = runInference({ factors, domains, queryVars: ["C"], evidence: { A: "f", B: "t" }, order: "minFill", budget: { maxFactorRows: 1000 } });
  const r2 = runInference({ factors, domains, queryVars: ["C"], evidence: { B: "t", A: "f" }, order: "minFill", budget: { maxFactorRows: 1000 } });
  assert.deepEqual(r1.joint.map((x) => x.prob), r2.joint.map((x) => x.prob));
});

test("不同合法消元顺序结果一致", () => {
  const { factors, domains } = prepare("commonCause");
  const orders: ("minFill" | "minDegree" | string[])[] = [
    "minFill",
    "minDegree",
    ["Sprinkler"],
  ];
  const probs = orders.map((o) =>
    runInference({ factors, domains, queryVars: ["WetGrass"], evidence: { Rain: "yes" }, order: o, budget: { maxFactorRows: 1000 } })
      .joint.map((r) => r.prob),
  );
  for (let i = 1; i < probs.length; i++) {
    probs[0]!.forEach((p, j) => assert.ok(Math.abs(p - probs[i]![j]!) < 1e-12));
  }
});

test("父变量顺序置换不改变数值含义", () => {
  const original = FIXTURE_REGISTRY.commonCause().variables;
  const permuted = original.map((v) =>
    v.id === "WetGrass"
      ? {
          ...v,
          cpt: {
            parents: ["Sprinkler", "Rain"],
            rows: v.cpt.rows.map((row) => ({
              parentStates: [row.parentStates[1]!, row.parentStates[0]!],
              probs: row.probs,
            })),
          },
        }
      : v,
  );
  const a = buildFactors({ networkId: "a", version: 1, variables: original });
  const b = buildFactors({ networkId: "b", version: 1, variables: permuted });
  const da = Object.fromEntries(original.map((v) => [v.id, v.states]));
  const db = Object.fromEntries(permuted.map((v) => [v.id, v.states]));
  const ra = runInference({ factors: a, domains: da, queryVars: ["WetGrass"], evidence: {}, order: "minFill", budget: { maxFactorRows: 1000 } });
  const rb = runInference({ factors: b, domains: db, queryVars: ["WetGrass"], evidence: {}, order: "minFill", budget: { maxFactorRows: 1000 } });
  ra.joint.forEach((row, i) => assert.ok(Math.abs(row.prob - rb.joint[i]!.prob) < 1e-12));
});

test("资源不足报 RESOURCE_EXHAUSTED，不误判为不可能", () => {
  const { factors, domains } = prepare("commonCause");
  assert.throws(
    () => runInference({ factors, domains, queryVars: ["WetGrass"], evidence: {}, order: "minFill", budget: { maxFactorRows: 1 } }),
    (e: unknown) => e instanceof BayesError && e.code === "RESOURCE_EXHAUSTED",
  );
});

test("非法证据与被观测变量查询被拒绝", () => {
  const { domains } = prepare("chain");
  assert.throws(
    () =>
      runInference({
        factors: prepare("chain").factors,
        domains,
        queryVars: ["C"],
        evidence: { B: "zzz" },
        order: "minFill",
        budget: { maxFactorRows: 1000 },
      }),
    (e: unknown) => e instanceof BayesError && e.code === "BAD_EVIDENCE",
  );
  assert.throws(
    () =>
      runInference({
        factors: prepare("chain").factors,
        domains,
        queryVars: ["B"],
        evidence: { B: "t" },
        order: "minFill",
        budget: { maxFactorRows: 1000 },
      }),
    (e: unknown) => e instanceof BayesError && e.code === "VALIDATION",
  );
});

test("数值稳定：极小概率链不产生 NaN/Infinity 后验", () => {
  const f = FIXTURE_REGISTRY.chain().variables.map((v) =>
    v.id === "A"
      ? { ...v, cpt: { parents: [], rows: [{ parentStates: [], probs: [1e-300, 1 - 1e-300] }] } }
      : v,
  );
  const factors = buildFactors({ networkId: "tiny", version: 1, variables: f });
  const domains = Object.fromEntries(f.map((v) => [v.id, v.states]));
  const r = runInference({ factors, domains, queryVars: ["C"], evidence: {}, order: "minFill", budget: { maxFactorRows: 1000 } });
  assert.ok(r.joint.every((j) => Number.isFinite(j.prob)));
  const total = r.joint.reduce((a, x) => a + x.prob, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});
