/**
 * T04: typed backend error taxonomy (PRD T04, mcp-contracts.md §3/§10).
 *
 * All domain failures over MCP arrive as JSON-RPC successes with
 * `isError: true` — they are NEVER retried as transient failures.
 * Transport faults map to typed failures. Error messages carry no
 * credentials, no header values and no response payloads.
 */

export type ErrorCode =
  | "auth" // authorization/authentication — hard setup error, never retried
  | "validation" // domain-level invalid request (isError result)
  | "conflict" // deterministic-path content collision — fail closed
  | "timeout" // configured deadline expired
  | "cancelled" // caller cancellation propagated
  | "availability" // transport/network fault — retryable once at most
  | "response-format" // invalid or oversized backend response
  | "capability" // required tool missing from tools/list
  | "not-persisted"; // opId was not durably persisted before mutation

export class BackendError extends Error {
  readonly code: ErrorCode;
  /** Tool that produced the error, when known (safe name, no arguments). */
  readonly tool: string | undefined;

  constructor(code: ErrorCode, message: string, tool?: string) {
    super(message);
    this.name = "BackendError";
    this.code = code;
    this.tool = tool;
  }
}

export class AuthError extends BackendError {
  constructor(message: string, tool?: string) {
    super("auth", message, tool);
    this.name = "AuthError";
  }
}

export class ValidationError extends BackendError {
  constructor(message: string, tool?: string) {
    super("validation", message, tool);
    this.name = "ValidationError";
  }
}

export class ConflictError extends BackendError {
  constructor(message: string, tool?: string) {
    super("conflict", message, tool);
    this.name = "ConflictError";
  }
}

export class TimeoutError extends BackendError {
  constructor(message: string, tool?: string) {
    super("timeout", message, tool);
    this.name = "TimeoutError";
  }
}

export class CancelledError extends BackendError {
  constructor(message: string, tool?: string) {
    super("cancelled", message, tool);
    this.name = "CancelledError";
  }
}

export class AvailabilityError extends BackendError {
  constructor(message: string, tool?: string) {
    super("availability", message, tool);
    this.name = "AvailabilityError";
  }
}

export class ResponseFormatError extends BackendError {
  constructor(message: string, tool?: string) {
    super("response-format", message, tool);
    this.name = "ResponseFormatError";
  }
}

export class CapabilityError extends BackendError {
  constructor(message: string) {
    super("capability", message);
    this.name = "CapabilityError";
  }
}

export class OpIdNotPersistedError extends BackendError {
  constructor(message: string) {
    super("not-persisted", message);
    this.name = "OpIdNotPersistedError";
  }
}

/** True for error codes that may legitimately be retried (transport faults). */
export function isRetryable(err: unknown): boolean {
  return err instanceof BackendError && err.code === "availability";
}
