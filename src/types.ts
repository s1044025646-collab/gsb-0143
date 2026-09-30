export type VariableId = string;

export interface VariableSpec {
  id: VariableId;
  states: string[];
}

export type CptRow = {
  parentStates: Record<string, string>;
  probabilities: Record<string, number>;
};

export interface NodeSpec {
  variable: VariableSpec;
  parents: VariableId[];
  cpt: CptRow[];
}

export type Evidence = Record<VariableId, string>;

export interface NetworkSpec {
  id: string;
  name: string;
  nodes: NodeSpec[];
}

export interface QueryPlanInput {
  variables: VariableId[];
  evidence: Evidence;
  ordering?: VariableId[] | "min-fill" | "min-degree";
  factorCellBudget?: number;
  idempotencyKey?: string;
}

export interface EliminationStep {
  step: number;
  eliminated: VariableId;
  factorsIn: string[];
  factorOut: string;
  factorCellsBefore: number;
  factorCellsAfter: number;
}

export interface InferenceResult {
  query: VariableId[];
  evidence: Evidence;
  posterior: Array<{ assignment: Record<string, string>; probability: number; logProbability: number }>;
  logEvidenceProbability: number;
  evidenceProbability: number;
  impossible: boolean;
  eliminationSteps: EliminationStep[];
  ordering: VariableId[];
  peakCells: number;
  note: string;
}

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  total: number;
}
