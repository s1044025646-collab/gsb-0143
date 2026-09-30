import type { NetworkSpec } from "./types.js";

export function independentFixture(): NetworkSpec {
  return {
    id: "independent",
    name: "Independent Coins",
    nodes: [
      {
        variable: { id: "A", states: ["a0", "a1"] },
        parents: [],
        cpt: [
          {
            parentStates: {},
            probabilities: { a0: 0.3, a1: 0.7 }
          }
        ]
      },
      {
        variable: { id: "B", states: ["b0", "b1"] },
        parents: [],
        cpt: [
          {
            parentStates: {},
            probabilities: { b0: 0.6, b1: 0.4 }
          }
        ]
      }
    ]
  };
}

export function chainFixture(): NetworkSpec {
  return {
    id: "chain",
    name: "Rain -> Sprinkler -> WetGrass style chain",
    nodes: [
      {
        variable: { id: "R", states: ["r0", "r1"] },
        parents: [],
        cpt: [{ parentStates: {}, probabilities: { r0: 0.8, r1: 0.2 } }]
      },
      {
        variable: { id: "S", states: ["s0", "s1"] },
        parents: ["R"],
        cpt: [
          { parentStates: { R: "r0" }, probabilities: { s0: 0.6, s1: 0.4 } },
          { parentStates: { R: "r1" }, probabilities: { s0: 0.55, s1: 0.45 } }
        ]
      },
      {
        variable: { id: "W", states: ["w0", "w1"] },
        parents: ["S"],
        cpt: [
          { parentStates: { S: "s0" }, probabilities: { w0: 0.7, w1: 0.3 } },
          { parentStates: { S: "s1" }, probabilities: { w0: 0.1, w1: 0.9 } }
        ]
      }
    ]
  };
}

export function commonCauseFixture(): NetworkSpec {
  return {
    id: "common-cause",
    name: "Rain causes Sprinkler-off and Wet Grass",
    nodes: [
      {
        variable: { id: "R", states: ["r0", "r1"] },
        parents: [],
        cpt: [{ parentStates: {}, probabilities: { r0: 0.8, r1: 0.2 } }]
      },
      {
        variable: { id: "S", states: ["s0", "s1"] },
        parents: ["R"],
        cpt: [
          { parentStates: { R: "r0" }, probabilities: { s0: 0.4, s1: 0.6 } },
          { parentStates: { R: "r1" }, probabilities: { s0: 0.9, s1: 0.1 } }
        ]
      },
      {
        variable: { id: "W", states: ["w0", "w1"] },
        parents: ["R"],
        cpt: [
          { parentStates: { R: "r0" }, probabilities: { w0: 0.8, w1: 0.2 } },
          { parentStates: { R: "r1" }, probabilities: { w0: 0.1, w1: 0.9 } }
        ]
      }
    ]
  };
}

export function colliderFixture(): NetworkSpec {
  return {
    id: "collider",
    name: "Burglary/Earthquake -> Alarm collider",
    nodes: [
      {
        variable: { id: "B", states: ["b0", "b1"] },
        parents: [],
        cpt: [{ parentStates: {}, probabilities: { b0: 0.999, b1: 0.001 } }]
      },
      {
        variable: { id: "E", states: ["e0", "e1"] },
        parents: [],
        cpt: [{ parentStates: {}, probabilities: { e0: 0.998, e1: 0.002 } }]
      },
      {
        variable: { id: "A", states: ["a0", "a1"] },
        parents: ["B", "E"],
        cpt: [
          { parentStates: { B: "b0", E: "e0" }, probabilities: { a0: 0.999, a1: 0.001 } },
          { parentStates: { B: "b0", E: "e1" }, probabilities: { a0: 0.71, a1: 0.29 } },
          { parentStates: { B: "b1", E: "e0" }, probabilities: { a0: 0.06, a1: 0.94 } },
          { parentStates: { B: "b1", E: "e1" }, probabilities: { a0: 0.05, a1: 0.95 } }
        ]
      }
    ]
  };
}

export function deterministicFixture(): NetworkSpec {
  return {
    id: "deterministic",
    name: "XOR of two bits is deterministic",
    nodes: [
      {
        variable: { id: "X", states: ["0", "1"] },
        parents: [],
        cpt: [{ parentStates: {}, probabilities: { "0": 0.5, "1": 0.5 } }]
      },
      {
        variable: { id: "Y", states: ["0", "1"] },
        parents: [],
        cpt: [{ parentStates: {}, probabilities: { "0": 0.5, "1": 0.5 } }]
      },
      {
        variable: { id: "Z", states: ["0", "1"] },
        parents: ["X", "Y"],
        cpt: [
          { parentStates: { X: "0", Y: "0" }, probabilities: { "0": 1, "1": 0 } },
          { parentStates: { X: "0", Y: "1" }, probabilities: { "0": 0, "1": 1 } },
          { parentStates: { X: "1", Y: "0" }, probabilities: { "0": 0, "1": 1 } },
          { parentStates: { X: "1", Y: "1" }, probabilities: { "0": 1, "1": 0 } }
        ]
      }
    ]
  };
}

export function impossibleEvidenceFixture(): NetworkSpec {
  const spec = deterministicFixture();
  spec.id = "impossible-evidence";
  spec.name = "Deterministic XOR with an impossible observation";
  spec.nodes.push({
    variable: { id: "M", states: ["m0", "m1"] },
    parents: [],
    cpt: [{ parentStates: {}, probabilities: { m0: 0.5, m1: 0.5 } }]
  });
  return spec;
}

export const IMPOSSIBLE_OBSERVATION = {
  X: "0" as const,
  Y: "0" as const,
  Z: "1" as const
};

export function tinyProbabilitiesFixture(): NetworkSpec {
  return {
    id: "rare-events",
    name: "Many rare independent events for underflow checks",
    nodes: Array.from({ length: 12 }, (_, i) => {
      const id = `R${i}`;
      return {
        variable: { id, states: ["yes", "no"] },
        parents: [],
        cpt: [
          {
            parentStates: {},
            probabilities: { yes: 1e-6, no: 1 - 1e-6 }
          }
        ]
      };
    })
  };
}

export function allFixtures(): NetworkSpec[] {
  return [
    independentFixture(),
    chainFixture(),
    commonCauseFixture(),
    colliderFixture(),
    deterministicFixture(),
    impossibleEvidenceFixture(),
    tinyProbabilitiesFixture()
  ];
}
