import { BayesianNetwork } from "../src/inference/network.js";
import { runVariableElimination } from "../src/inference/elimination.js";
import { enumerateAll } from "../src/inference/enumeration.js";
import { AppError } from "../src/errors.js";
import {
  chainFixture,
  colliderFixture,
  commonCauseFixture,
  deterministicFixture,
  impossibleEvidenceFixture,
  IMPOSSIBLE_OBSERVATION,
  independentFixture,
  tinyProbabilitiesFixture
} from "../src/fixtures.js";
import type { InferenceResult, NetworkSpec } from "../src/types.js";

function posteriorMap(result: InferenceResult): Map<string, number> {
  return new Map(
    result.posterior.map((entry) => [
      Object.entries(entry.assignment)
        .map(([k, v]) => `${k}=${v}`)
        .join(","),
      entry.probability
    ])
  );
}

function expectVeMatchesEnumeration(spec: NetworkSpec): void {
  const network = BayesianNetwork.validate(spec);
  const allVars = network.topologicalOrder();
  const ve = runVariableElimination(network, { query: allVars, evidence: {} });
  const oracle = enumerateAll(network, { query: allVars, evidence: {} });
  expect(ve.posterior).toHaveLength(oracle.posterior.length);
  const veMap = posteriorMap(ve);
  for (const entry of oracle.posterior) {
    const key = Object.entries(entry.assignment)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    expect(veMap.get(key)).toBeCloseTo(entry.probability, 9);
  }
  expect(ve.evidenceProbability).toBeCloseTo(1, 9);
}

describe("variable elimination", () => {
  test("independent fixture matches enumeration", () => {
    expectVeMatchesEnumeration(independentFixture());
  });

  test("chain fixture matches enumeration", () => {
    expectVeMatchesEnumeration(chainFixture());
  });

  test("common cause fixture matches enumeration and shows explaining symmetry", () => {
    expectVeMatchesEnumeration(commonCauseFixture());
    const network = BayesianNetwork.validate(commonCauseFixture());
    const before = runVariableElimination(network, { query: ["S"], evidence: {} });
    const after = runVariableElimination(network, { query: ["S"], evidence: { W: "w1" } });
    expect(after.evidenceProbability).toBeGreaterThan(0);
    expect(before.posterior.find((p) => p.assignment.S === "s1")!.probability).not.toBeCloseTo(
      after.posterior.find((p) => p.assignment.S === "s1")!.probability,
      6
    );
  });

  test("collider activates dependence only after observing the child", () => {
    const network = BayesianNetwork.validate(colliderFixture());
    const marginal = runVariableElimination(network, { query: ["B", "E"], evidence: {} });
    const observed = runVariableElimination(network, { query: ["B", "E"], evidence: { A: "a1" } });
    const mMap = posteriorMap(marginal);
    const oMap = posteriorMap(observed);
    const independent = mMap.get("B=b1,E=e1")!;
    const product =
      marginal.posterior.find((p) => p.assignment.B === "b1" && p.assignment.E === undefined) ===
      undefined;
    void product;
    expect(independent).toBeCloseTo(0.001 * 0.002, 10);
    expect(oMap.get("B=b1,E=e1")).not.toBeCloseTo(independent, 8);
  });

  test("deterministic XOR gives exact zero/one posteriors", () => {
    const network = BayesianNetwork.validate(deterministicFixture());
    const result = runVariableElimination(network, {
      query: ["Z"],
      evidence: { X: "0" }
    });
    const map = posteriorMap(result);
    expect(map.get("Z=0")).toBeCloseTo(0.5, 12);
    expect(map.get("Z=1")).toBeCloseTo(0.5, 12);
    const fixed = runVariableElimination(network, {
      query: ["Z"],
      evidence: { X: "1", Y: "1" }
    });
    expect(posteriorMap(fixed).get("Z=0")).toBe(1);
    expect(posteriorMap(fixed).get("Z=1")).toBe(0);
  });

  test("impossible evidence reports impossibility without fabricated posterior", () => {
    const network = BayesianNetwork.validate(impossibleEvidenceFixture());
    const result = runVariableElimination(network, {
      query: ["M"],
      evidence: IMPOSSIBLE_OBSERVATION
    });
    expect(result.impossible).toBe(true);
    expect(result.evidenceProbability).toBe(0);
    expect(result.posterior.every((p) => p.probability === 0)).toBe(true);
  });

  test("posterior rows normalize to one", () => {
    const network = BayesianNetwork.validate(chainFixture());
    const result = runVariableElimination(network, {
      query: ["S", "W"],
      evidence: { R: "r0" }
    });
    const total = result.posterior.reduce((sum, p) => sum + p.probability, 0);
    expect(total).toBeCloseTo(1, 9);
  });

  test("evidence insertion order does not change the result", () => {
    const network = BayesianNetwork.validate(commonCauseFixture());
    const a = runVariableElimination(network, {
      query: ["R"],
      evidence: { S: "s1", W: "w0" }
    });
    const b = runVariableElimination(network, {
      query: ["R"],
      evidence: { W: "w0", S: "s1" }
    });
    expect(a.posterior.map((p) => p.probability)).toEqual(
      b.posterior.map((p) => p.probability)
    );
    expect(a.evidenceProbability).toBeCloseTo(b.evidenceProbability, 12);
  });

  test("all legal elimination orderings agree", () => {
    const network = BayesianNetwork.validate(chainFixture());
    const plans: Array<{ ordering?: string[] | "min-fill" | "min-degree" }> = [
      { ordering: ["R", "S"] },
      { ordering: ["S", "R"] },
      { ordering: "min-fill" },
      { ordering: "min-degree" },
      {}
    ];
    const reference = runVariableElimination(network, {
      query: ["W"],
      evidence: {}
    });
    for (const options of plans) {
      const result = runVariableElimination(network, {
        query: ["W"],
        evidence: {},
        ...options
      });
      for (let i = 0; i < result.posterior.length; i++) {
        expect(result.posterior[i]!.probability).toBeCloseTo(
          reference.posterior[i]!.probability,
          10
        );
      }
      expect(result.peakCells).toBeGreaterThan(0);
    }
  });

  test("parent order permutation preserves probabilities", () => {
    const networkA = BayesianNetwork.validate(colliderFixture());
    const swappedSpec: NetworkSpec = JSON.parse(JSON.stringify(colliderFixture()));
    const alarm = swappedSpec.nodes.find((n) => n.variable.id === "A")!;
    alarm.parents = ["E", "B"];
    alarm.cpt = alarm.cpt.map((row) => {
      const b = row.parentStates.B!;
      const e = row.parentStates.E!;
      return {
        parentStates: { E: e, B: b },
        probabilities: { ...row.probabilities }
      };
    });
    const networkB = BayesianNetwork.validate(swappedSpec);
    const resultA = runVariableElimination(networkA, {
      query: ["A"],
      evidence: { B: "b1", E: "e1" }
    });
    const resultB = runVariableElimination(networkB, {
      query: ["A"],
      evidence: { B: "b1", E: "e1" }
    });
    for (let i = 0; i < resultA.posterior.length; i++) {
      expect(resultB.posterior[i]!.probability).toBeCloseTo(
        resultA.posterior[i]!.probability,
        12
      );
    }
  });

  test("tiny probabilities stay numerically stable in log space", () => {
    const network = BayesianNetwork.validate(tinyProbabilitiesFixture());
    const vars = network.topologicalOrder();
    const observed = Object.fromEntries(vars.slice(0, 10).map((v) => [v, "yes"]));
    const result = runVariableElimination(network, {
      query: vars.slice(10),
      evidence: observed
    });
    expect(Number.isFinite(result.logEvidenceProbability)).toBe(true);
    expect(result.evidenceProbability).toBeGreaterThan(0);
    expect(result.evidenceProbability).toBeLessThan(1e-50);
    const total = result.posterior.reduce((sum, p) => sum + p.probability, 0);
    expect(total).toBeCloseTo(1, 9);
    const oracle = enumerateAll(network, {
      query: vars.slice(10),
      evidence: observed
    });
    expect(oracle.evidenceProbability).toBeCloseTo(result.evidenceProbability, 12);
  });

  test("resource exhaustion is reported distinctly from impossibility", () => {
    const network = BayesianNetwork.validate(tinyProbabilitiesFixture());
    expect(() =>
      runVariableElimination(network, {
        query: [],
        evidence: {},
        factorCellBudget: 1
      })
    ).toThrow(AppError);
    try {
      runVariableElimination(network, {
        query: ["R0"],
        evidence: {},
        factorCellBudget: 1
      });
      throw new Error("expected resource error");
    } catch (error) {
      expect((error as AppError).code).toBe("RESOURCE_EXHAUSTED");
    }
  });

  test("result notes the observation vs intervention boundary", () => {
    const network = BayesianNetwork.validate(chainFixture());
    const result = runVariableElimination(network, {
      query: ["W"],
      evidence: { S: "s1" }
    });
    expect(result.note).toMatch(/observational/i);
    expect(result.note).toMatch(/not a causal intervention/i);
  });
});
