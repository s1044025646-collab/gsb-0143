export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "DUPLICATE_STATE"
  | "DUPLICATE_VARIABLE"
  | "CYCLE"
  | "CPT_MISSING_ROW"
  | "CPT_NEGATIVE_PROB"
  | "CPT_NOT_NORMALIZED"
  | "BAD_EVIDENCE"
  | "IMPOSSIBLE_EVIDENCE"
  | "RESOURCE_EXHAUSTED"
  | "VERSION_MISMATCH"
  | "CONFLICT";

export class BayesError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "BayesError";
  }
}
