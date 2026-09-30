import { test } from "node:test";
import assert from "node:assert/strict";
import { validateNetwork } from "../network.js";
import { FIXTURE_REGISTRY } from "../fixtures.js";
import { BayesError } from "../errors.js";
import type { NetworkData, VariableInput } from "../network.js";

function netOf(variables: VariableInput[]): NetworkData {
  return { networkId: "n", version: 1, variables };
}

function expectCode(fn: () => void, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof BayesError && e.code === code);
}

test("全部夹具通过校验", () => {
  for (const factory of Object.values(FIXTURE_REGISTRY)) {
    const f = factory();
    assert.doesNotThrow(() => validateNetwork(netOf(f.variables)));
  }
});

test("拒绝重复变量与重复状态", () => {
  const f = FIXTURE_REGISTRY.chain().variables;
  expectCode(() => validateNetwork(netOf([...f, f[0]!])), "DUPLICATE_VARIABLE");
  const dup: VariableInput = { id: "Z", states: ["s", "s"], cpt: { parents: [], rows: [{ parentStates: [], probs: [0.5, 0.5] }] } };
  expectCode(() => validateNetwork(netOf([...f, dup])), "DUPLICATE_STATE");
});

test("拒绝有向环（包括自环）", () => {
  const a: VariableInput = { id: "A", states: ["x", "y"], cpt: { parents: ["B"], rows: [
    { parentStates: ["x"], probs: [0.5, 0.5] },
    { parentStates: ["y"], probs: [0.5, 0.5] },
  ] } };
  const b: VariableInput = { id: "B", states: ["x", "y"], cpt: { parents: ["A"], rows: [
    { parentStates: ["x"], probs: [0.5, 0.5] },
    { parentStates: ["y"], probs: [0.5, 0.5] },
  ] } };
  expectCode(() => validateNetwork(netOf([a, b])), "CYCLE");
  const self: VariableInput = { id: "S", states: ["x", "y"], cpt: { parents: ["S"], rows: [
    { parentStates: ["x"], probs: [0.5, 0.5] },
    { parentStates: ["y"], probs: [0.5, 0.5] },
  ] } };
  expectCode(() => validateNetwork(netOf([self])), "CYCLE");
});

test("拒绝 CPT 缺行、负概率、未归一化", () => {
  const base = FIXTURE_REGISTRY.chain().variables;
  const missing = base.map((v) =>
    v.id === "B" ? { ...v, cpt: { parents: ["A"], rows: [v.cpt.rows[0]!] } } : v,
  );
  expectCode(() => validateNetwork(netOf(missing)), "CPT_MISSING_ROW");
  const neg = base.map((v) =>
    v.id === "B"
      ? { ...v, cpt: { parents: ["A"], rows: [
          { parentStates: ["t"], probs: [-0.1, 1.1] },
          { parentStates: ["f"], probs: [0.2, 0.8] },
        ] } }
      : v,
  );
  expectCode(() => validateNetwork(netOf(neg)), "CPT_NEGATIVE_PROB");
  const norm = base.map((v) =>
    v.id === "B"
      ? { ...v, cpt: { parents: ["A"], rows: [
          { parentStates: ["t"], probs: [0.5, 0.4] },
          { parentStates: ["f"], probs: [0.2, 0.8] },
        ] } }
      : v,
  );
  expectCode(() => validateNetwork(netOf(norm)), "CPT_NOT_NORMALIZED");
});

test("拒绝未知父变量与父状态", () => {
  const bad: VariableInput = { id: "A", states: ["x", "y"], cpt: { parents: ["Ghost"], rows: [
    { parentStates: ["x"], probs: [0.5, 0.5] },
    { parentStates: ["y"], probs: [0.5, 0.5] },
  ] } };
  expectCode(() => validateNetwork(netOf([bad])), "NOT_FOUND");
  const root: VariableInput = { id: "P", states: ["x", "y"], cpt: { parents: [], rows: [{ parentStates: [], probs: [0.5, 0.5] }] } };
  const badState: VariableInput = { id: "Q", states: ["m", "n"], cpt: { parents: ["P"], rows: [
    { parentStates: ["x"], probs: [0.5, 0.5] },
    { parentStates: ["zzz"], probs: [0.5, 0.5] },
  ] } };
  expectCode(() => validateNetwork(netOf([root, badState])), "VALIDATION");
});
