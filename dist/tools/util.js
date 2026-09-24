import { BlackboardError, maskSensitive, truncate } from '../blackboard/errors.js';
/**
 * What an answer could not cover, as plain sentences meant for the student,
 * each with what they can do instead. Every tool reports gaps under this one
 * name so the AI always knows where to look, and the server's instructions
 * tell it to pass each one on. Spread into a result; omitted when empty.
 */
export function limitations(list) {
    const clean = [...new Set(list.filter((x) => typeof x === 'string' && x.trim().length > 0))];
    return clean.length > 0 ? { limitations: clean } : {};
}
export const UNKNOWN_STATUS_GAP = (n) => `Blackboard did not say whether ${n === 1 ? '1 item was' : `${n} items were`} handed in (status "unknown"). ` +
    'Check those in Blackboard rather than assuming they are missing.';
export function jsonResult(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
export function textResult(text) {
    return { content: [{ type: 'text', text }] };
}
/** Errors are short, coded, masked — never raw HTML or server internals. */
export function errorResult(err) {
    if (err instanceof BlackboardError) {
        return { content: [{ type: 'text', text: `${err.code}: ${err.message}` }], isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
        content: [{ type: 'text', text: `BLACKBOARD_REQUEST_FAILED: ${maskSensitive(truncate(msg, 300))}` }],
        isError: true,
    };
}
export const READ_ONLY_ANNOTATIONS = {
    readOnlyHint: true,
    openWorldHint: true,
};
