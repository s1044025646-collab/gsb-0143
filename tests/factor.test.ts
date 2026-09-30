import {
  Factor,
  multiply,
  restrict,
  sumOut
} from "../src/inference/factor.js";
import { LOG_ZERO } from "../src/logmath.js";

describe("factor operations", () => {
  test("multiply two independent binary factors equals outer product", () => {
    const a = new Factor(
      [{ variable: "A", states: ["a0", "a1"] }],
      Float64Array.from([Math.log(0.3), Math.log(0.7)]),
      "fa"
    );
    const b = new Factor(
      [{ variable: "B", states: ["b0", "b1"] }],
      Float64Array.from([Math.log(0.6), Math.log(0.4)]),
      "fb"
    );
    const product = multiply(a, b, "fab");
    expect(product.variables).toEqual(["A", "B"]);
    expect(Math.exp(product.getLog({ A: "a0", B: "b0" }))).toBeCloseTo(0.18, 12);
    expect(Math.exp(product.getLog({ A: "a1", B: "b1" }))).toBeCloseTo(0.28, 12);
  });

  test("restrict selects rows and removes the observed dimension", () => {
    const factor = new Factor(
      [
        { variable: "A", states: ["a0", "a1"] },
        { variable: "B", states: ["b0", "b1"] }
      ],
      Float64Array.from([
        Math.log(0.12),
        Math.log(0.18),
        Math.log(0.42),
        Math.log(0.28)
      ])
    );
    const { factor: restricted, applied } = restrict(factor, { A: "a1" });
    expect(applied).toEqual(["A"]);
    expect(restricted.variables).toEqual(["B"]);
    const rows = restricted.enumerate();
    expect(Math.exp(rows[0]!.logValue)).toBeCloseTo(0.42, 12);
    expect(Math.exp(rows[1]!.logValue)).toBeCloseTo(0.28, 12);
  });

  test("sumOut marginalizes in log space", () => {
    const factor = new Factor(
      [
        { variable: "A", states: ["a0", "a1"] },
        { variable: "B", states: ["b0", "b1"] }
      ],
      Float64Array.from([
        Math.log(0.12),
        Math.log(0.18),
        Math.log(0.42),
        Math.log(0.28)
      ])
    );
    const marginal = sumOut(factor, "A");
    expect(marginal.variables).toEqual(["B"]);
    const rows = marginal.enumerate();
    expect(Math.exp(rows[0]!.logValue)).toBeCloseTo(0.54, 12);
    expect(Math.exp(rows[1]!.logValue)).toBeCloseTo(0.46, 12);
  });

  test("zero probabilities stay as log-zero without epsilon smoothing", () => {
    const factor = new Factor(
      [{ variable: "A", states: ["a0", "a1"] }],
      Float64Array.of(LOG_ZERO, Math.log(1))
    );
    const marginal = sumOut(factor, "A");
    expect(marginal.logValues[0]).toBe(0);
    expect(Math.exp(factor.getLog({ A: "a0" }))).toBe(0);
  });

  test("restrict rejects illegal state", () => {
    const factor = new Factor(
      [{ variable: "A", states: ["a0", "a1"] }],
      Float64Array.of(Math.log(0.5), Math.log(0.5))
    );
    expect(() => restrict(factor, { A: "nope" })).toThrow(/illegal evidence/i);
  });
});
