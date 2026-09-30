import { BayesianNetwork } from "../dist/inference/network.js";
import { runVariableElimination } from "../dist/inference/elimination.js";
import { enumerateAll } from "../dist/inference/enumeration.js";
import {
  independentFixture,
  chainFixture,
  commonCauseFixture,
  colliderFixture,
  deterministicFixture,
  IMPOSSIBLE_OBSERVATION,
  impossibleEvidenceFixture
} from "../dist/fixtures.js";

const fixtures = [
  independentFixture(),
  chainFixture(),
  commonCauseFixture(),
  colliderFixture(),
  deterministicFixture()
];

for (const f of fixtures) {
  const net = BayesianNetwork.validate(f);
  const vars = net.topologicalOrder();
  const ve = runVariableElimination(net, { query: vars, evidence: {} });
  const en = enumerateAll(net, { query: vars, evidence: {} });
  let maxd = 0;
  for (let i = 0; i < ve.posterior.length; i++) {
    maxd = Math.max(maxd, Math.abs(ve.posterior[i].probability - en.posterior[i].probability));
  }
  console.log(f.id, "P(E)=", ve.evidenceProbability.toFixed(6), "maxdiff", maxd.toExponential(2));
}

const chain = BayesianNetwork.validate(chainFixture());
const q1 = runVariableElimination(chain, { query: ["W"], evidence: { R: "r1" } });
const q2 = runVariableElimination(chain, {
  query: ["W"],
  evidence: { R: "r1" },
  ordering: ["S"]
});
console.log("chain P(W|r1) orderings:", q1.posterior.map((p) => p.probability), q2.posterior.map((p) => p.probability));

const det = BayesianNetwork.validate(impossibleEvidenceFixture());
const imp = runVariableElimination(det, {
  query: ["M"],
  evidence: IMPOSSIBLE_OBSERVATION
});
console.log("impossible evidence -> impossible:", imp.impossible, "P(E)=", imp.evidenceProbability);
