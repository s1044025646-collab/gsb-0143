import { AppError } from "../src/errors.js";
import { BayesianNetwork } from "../src/inference/network.js";
import { chainFixture } from "../src/fixtures.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`Expected AppError with code ${code}`);
}

describe("network validation", () => {
  test("accepts an acyclic normalized network", () => {
    const network = BayesianNetwork.validate(chainFixture());
    expect(network.topologicalOrder()).toEqual(["R", "S", "W"]);
  });

  test("rejects directed cycles", () => {
    const spec = clone(chainFixture());
    spec.nodes[0]!.parents = ["W"];
    expectCode(() => BayesianNetwork.validate(spec), "CYCLE");
  });

  test("rejects duplicate states", () => {
    const spec = clone(chainFixture());
    spec.nodes[0]!.variable.states = ["r0", "r0"];
    expectCode(() => BayesianNetwork.validate(spec), "DUPLICATE_STATE");
  });

  test("rejects missing parent reference", () => {
    const spec = clone(chainFixture());
    spec.nodes[1]!.parents = ["GHOST"];
    spec.nodes[1]!.cpt = [
      { parentStates: { GHOST: "g0" }, probabilities: { s0: 0.5, s1: 0.5 } }
    ];
    expectCode(() => BayesianNetwork.validate(spec), "MISSING_PARENT");
  });

  test("rejects missing CPT rows", () => {
    const spec = clone(chainFixture());
    spec.nodes[1]!.cpt = [spec.nodes[1]!.cpt[0]!];
    expectCode(() => BayesianNetwork.validate(spec), "CPT_MISSING_ROW");
  });

  test("rejects unnormalized CPT rows", () => {
    const spec = clone(chainFixture());
    spec.nodes[0]!.cpt[0]!.probabilities = { r0: 0.5, r1: 0.2 };
    expectCode(() => BayesianNetwork.validate(spec), "CPT_NOT_NORMALIZED");
  });

  test("rejects all-zero rows instead of smoothing", () => {
    const spec = clone(chainFixture());
    spec.nodes[0]!.cpt[0]!.probabilities = { r0: 0, r1: 0 };
    expectCode(() => BayesianNetwork.validate(spec), "CPT_NOT_NORMALIZED");
  });

  test("rejects negative probabilities", () => {
    const spec = clone(chainFixture());
    spec.nodes[0]!.cpt[0]!.probabilities = { r0: 1.2, r1: -0.2 };
    expectCode(() => BayesianNetwork.validate(spec), "NEGATIVE_PROBABILITY");
  });

  test("rejects illegal evidence variables and states", () => {
    const network = BayesianNetwork.validate(chainFixture());
    expectCode(() => network.validateEvidence({ R: "nope" }), "ILLEGAL_EVIDENCE");
    expectCode(() => network.validateEvidence({ GHOST: "r0" }), "ILLEGAL_EVIDENCE");
  });
});
