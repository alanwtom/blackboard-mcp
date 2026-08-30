/** Stable machine-readable error codes surfaced to MCP clients and the CLI. */
export type BlackboardErrorCode =
  | 'BLACKBOARD_SESSION_EXPIRED'
  | 'NOT_LOGGED_IN'
  | 'COURSE_NOT_FOUND'
  | 'CONTENT_NOT_AVAILABLE'
  | 'PERMISSION_DENIED'
  | 'BLACKBOARD_REQUEST_FAILED'
  | 'ATTACHMENT_NOT_FOUND'
  | 'BROWSER_PROFILE_BUSY'
  | 'BROWSER_LAUNCH_FAILED'
  | 'INVALID_INPUT';

/** Canonical message required by the project spec. */
export const SESSION_EXPIRED_MESSAGE = 'Blackboard session expired. Run npm run login again.';

/**
 * Redact anything that looks like a token/cookie/header value before it can
 * reach an MCP client or the console. Long opaque runs are masked, but URL
 * paths (which contain slashes) survive so error messages stay useful.
 */
export function maskSensitive(text: string): string {
  return text
    .replace(/[A-Za-z0-9+_\-.~]{32,}=*/g, '«redacted»')
    .replace(/\b(BbRouter|s_session|JSESSIONID|Authorization|Cookie)\b[^\s,;]*/gi, '$1=«redacted»');
}

export class BlackboardError extends Error {
  readonly code: BlackboardErrorCode;
  readonly status?: number;

  constructor(code: BlackboardErrorCode, message: string, options?: { status?: number; cause?: unknown }) {
    super(maskSensitive(truncate(message, 500)));
    this.name = 'BlackboardError';
    this.code = code;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.cause !== undefined) this.cause = options.cause;
  }

  static sessionExpired(detail?: string): BlackboardError {
    return new BlackboardError(
      'BLACKBOARD_SESSION_EXPIRED',
      detail ? `${SESSION_EXPIRED_MESSAGE} (${detail})` : SESSION_EXPIRED_MESSAGE,
    );
  }

  static notLoggedIn(detail?: string): BlackboardError {
    return new BlackboardError(
      'NOT_LOGGED_IN',
      detail ?? 'No Blackboard session found. Run npm run login first.',
    );
  }
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export function isBlackboardError(err: unknown): err is BlackboardError {
  return err instanceof BlackboardError;
}
