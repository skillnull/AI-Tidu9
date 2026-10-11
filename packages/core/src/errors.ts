/** Stable machine-readable error codes shared across AI-Tidu9 boundaries. */
export type TiduErrorCode = "CONFIGURATION_INVALID" | "INTERNAL_ERROR" | "UNSUPPORTED_COMMAND";

/** Optional structured context safe to pass between trusted AI-Tidu9 components. */
export interface TiduErrorOptions {
  /** Original failure retained for local diagnostics. */
  cause?: unknown;
  /** Non-secret structured details for programmatic handling. */
  details?: Readonly<Record<string, unknown>>;
}

/** Base error carrying a stable code without exposing implementation details by default. */
export class TiduError extends Error {
  /** Stable machine-readable category. */
  public readonly code: TiduErrorCode;

  /** Non-secret structured context. */
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(code: TiduErrorCode, message: string, options: TiduErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "TiduError";
    this.code = code;
    this.details = Object.freeze({ ...options.details });
  }
}
