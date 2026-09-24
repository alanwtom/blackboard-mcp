/** Canonical message required by the project spec. */
export const SESSION_EXPIRED_MESSAGE = 'The Blackboard sign-in has expired.';
/**
 * Redact anything that looks like a token/cookie/header value before it can
 * reach an MCP client or the console. Long opaque runs are masked, but URL
 * paths (which contain slashes) survive so error messages stay useful.
 */
export function maskSensitive(text) {
    return text
        .replace(/[A-Za-z0-9+_\-.~]{32,}=*/g, '«redacted»')
        .replace(/\b(BbRouter|s_session|JSESSIONID|Authorization|Cookie)\b[^\s,;]*/gi, '$1=«redacted»');
}
export class BlackboardError extends Error {
    code;
    status;
    constructor(code, message, options) {
        super(maskSensitive(truncate(message, 500)));
        this.name = 'BlackboardError';
        this.code = code;
        if (options?.status !== undefined)
            this.status = options.status;
        if (options?.cause !== undefined)
            this.cause = options.cause;
    }
    static sessionExpired(detail) {
        return new BlackboardError('BLACKBOARD_SESSION_EXPIRED', detail ? `${SESSION_EXPIRED_MESSAGE} (${detail})` : SESSION_EXPIRED_MESSAGE);
    }
    static unreachable() {
        return new BlackboardError('BLACKBOARD_REQUEST_FAILED', "Can't reach Blackboard right now. Check your internet connection (campus Wi-Fi sometimes needs you to sign in to it first), then try again.");
    }
    static notLoggedIn(detail) {
        return new BlackboardError('NOT_LOGGED_IN', detail ?? 'Not signed in to Blackboard yet.');
    }
}
export function truncate(text, max) {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
export function isBlackboardError(err) {
    return err instanceof BlackboardError;
}
