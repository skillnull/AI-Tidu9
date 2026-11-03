/** Stable machine-readable error codes shared across AI-Tidu9 boundaries. */
export type TiduErrorCode =
  | "CONFIGURATION_CONFLICT"
  | "CONFIGURATION_INVALID"
  | "INTERNAL_ERROR"
  | "UNSUPPORTED_COMMAND";

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

/** Preserves an authoritative upstream category across model and streaming boundaries. */
export class ProviderError extends Error {
  /** Original machine-readable upstream category. */
  public readonly code: string;
  /** Public protocol error type used by the receiving client. */
  public readonly type: string;

  public constructor(code: string, message: string, type = "server_error") {
    super(message);
    this.name = "ProviderError";
    this.code = /^[a-z][a-z0-9_.-]{0,63}$/u.test(code) ? code : "upstream_request_failed";
    this.type = /^[a-z][a-z0-9_.-]{0,63}$/u.test(type) ? type : "server_error";
  }
}
