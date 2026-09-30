import type { VariableInput } from "./network.js";

export const FIXTURE_REGISTRY = {
  independent: () => ({
    name: "独立节点",
    description: "三个相互独立的离散变量",
    variables: [
      {
        id: "A",
        states: ["a0", "a1"],
        cpt: { parents: [], rows: [{ parentStates: [], probs: [0.3, 0.7] }] },
      },
      {
        id: "B",
        states: ["b0", "b1"],
        cpt: { parents: [], rows: [{ parentStates: [], probs: [0.6, 0.4] }] },
      },
      {
        id: "C",
        states: ["c0", "c1", "c2"],
        cpt: { parents: [], rows: [{ parentStates: [], probs: [0.2, 0.3, 0.5] }] },
      },
    ] satisfies VariableInput[],
  }),

  chain: () => ({
    name: "链 A->B->C",
    description: "三节点马尔可夫链",
    variables: [
      {
        id: "A",
        states: ["t", "f"],
        cpt: { parents: [], rows: [{ parentStates: [], probs: [0.5, 0.5] }] },
      },
      {
        id: "B",
        states: ["t", "f"],
        cpt: {
          parents: ["A"],
          rows: [
            { parentStates: ["t"], probs: [0.9, 0.1] },
            { parentStates: ["f"], probs: [0.2, 0.8] },
          ],
        },
      },
      {
        id: "C",
        states: ["t", "f"],
        cpt: {
          parents: ["B"],
          rows: [
            { parentStates: ["t"], probs: [0.7, 0.3] },
            { parentStates: ["f"], probs: [0.1, 0.9] },
          ],
        },
      },
    ] satisfies VariableInput[],
  }),

  commonCause: () => ({
    name: "共同原因 Rain->Sprinkler/WetGrass",
    description: "下雨同时影响喷淋与湿草",
    variables: [
      {
        id: "Rain",
        states: ["yes", "no"],
        cpt: { parents: [], rows: [{ parentStates: [], probs: [0.2, 0.8] }] },
      },
      {
        id: "Sprinkler",
        states: ["on", "off"],
        cpt: {
          parents: ["Rain"],
          rows: [
            { parentStates: ["yes"], probs: [0.01, 0.99] },
            { parentStates: ["no"], probs: [0.4, 0.6] },
          ],
        },
      },
      {
        id: "WetGrass",
        states: ["wet", "dry"],
        cpt: {
          parents: ["Rain", "Sprinkler"],
          rows: [
            { parentStates: ["yes", "on"], probs: [0.99, 0.01] },
            { parentStates: ["yes", "off"], probs: [0.9, 0.1] },
            { parentStates: ["no", "on"], probs: [0.95, 0.05] },
            { parentStates: ["no", "off"], probs: [0.05, 0.95] },
          ],
        },
      },
    ] satisfies VariableInput[],
  }),

  collider: () => ({
    name: "碰撞点 Alarm <- Burglary/Earthquake",
    description: "两个独立原因汇聚到报警器",
    variables: [
      {
        id: "Burglary",
        states: ["t", "f"],
        cpt: { parents: [], rows: [{ parentStates: [], probs: [0.001, 0.999] }] },
      },
      {
        id: "Earthquake",
        states: ["t", "f"],
        cpt: { parents: [], rows: [{ parentStates: [], probs: [0.002, 0.998] }] },
      },
      {
        id: "Alarm",
        states: ["t", "f"],
        cpt: {
          parents: ["Burglary", "Earthquake"],
          rows: [
            { parentStates: ["t", "t"], probs: [0.9999, 0.0001] },
            { parentStates: ["t", "f"], probs: [0.99, 0.01] },
            { parentStates: ["f", "t"], probs: [0.71, 0.29] },
            { parentStates: ["f", "f"], probs: [0.001, 0.999] },
          ],
        },
      },
    ] satisfies VariableInput[],
  }),

  deterministic: () => ({
    name: "确定性异或",
    description: "C = A XOR B，含零概率行",
    variables: [
      {
        id: "A",
        states: ["0", "1"],
        cpt: { parents: [], rows: [{ parentStates: [], probs: [0.5, 0.5] }] },
      },
      {
        id: "B",
        states: ["0", "1"],
        cpt: { parents: [], rows: [{ parentStates: [], probs: [0.5, 0.5] }] },
      },
      {
        id: "C",
        states: ["0", "1"],
        cpt: {
          parents: ["A", "B"],
          rows: [
            { parentStates: ["0", "0"], probs: [1, 0] },
            { parentStates: ["0", "1"], probs: [0, 1] },
            { parentStates: ["1", "0"], probs: [0, 1] },
            { parentStates: ["1", "1"], probs: [1, 0] },
          ],
        },
      },
    ] satisfies VariableInput[],
  }),

  impossible: () => ({
    name: "不可能证据夹具",
    description: "B 在 A=t 时必为 f，观测 B=t 概率为零",
    variables: [
      {
        id: "A",
        states: ["t", "f"],
        cpt: { parents: [], rows: [{ parentStates: [], probs: [0.4, 0.6] }] },
      },
      {
        id: "B",
        states: ["t", "f"],
        cpt: {
          parents: ["A"],
          rows: [
            { parentStates: ["t"], probs: [0, 1] },
            { parentStates: ["f"], probs: [0.8, 0.2] },
          ],
        },
      },
      {
        id: "C",
        states: ["x", "y"],
        cpt: { parents: [], rows: [{ parentStates: [], probs: [0.5, 0.5] }] },
      },
    ] satisfies VariableInput[],
  }),
};

export type FixtureName = keyof typeof FIXTURE_REGISTRY;

export function fixtureNames(): FixtureName[] {
  return Object.keys(FIXTURE_REGISTRY) as FixtureName[];
}
