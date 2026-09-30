export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "DUPLICATE"
  | "CYCLE"
  | "DUPLICATE_STATE"
  | "MISSING_PARENT"
  | "CPT_MISSING_ROW"
  | "CPT_EXTRA_ROW"
  | "CPT_NOT_NORMALIZED"
  | "NEGATIVE_PROBABILITY"
  | "ILLEGAL_EVIDENCE"
  | "IMPOSSIBLE_EVIDENCE"
  | "RESOURCE_EXHAUSTED"
  | "VERSION_ARCHIVED"
  | "CONFLICT"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError("VALIDATION", `Field '${field}' must be a non-empty string.`, { field });
  }
  return value;
}

export function requireArray<T>(value: unknown, field: string): T[] {
  if (!Array.isArray(value)) {
    throw new AppError("VALIDATION", `Field '${field}' must be an array.`, { field });
  }
  return value as T[];
}

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "VALIDATION":
      return 400;
    case "DUPLICATE":
    case "DUPLICATE_STATE":
    case "CYCLE":
    case "MISSING_PARENT":
    case "CPT_MISSING_ROW":
    case "CPT_EXTRA_ROW":
    case "CPT_NOT_NORMALIZED":
    case "NEGATIVE_PROBABILITY":
    case "ILLEGAL_EVIDENCE":
    case "IMPOSSIBLE_EVIDENCE":
    case "RESOURCE_EXHAUSTED":
    case "VERSION_ARCHIVED":
    case "CONFLICT":
      return 422;
    default:
      return 500;
  }
}
