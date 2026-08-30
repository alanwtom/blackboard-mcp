import { BlackboardError, maskSensitive, truncate } from '../blackboard/errors.js';
import type { BBHttp } from '../blackboard/session.js';

/** Dependency boundary: MCP handlers call Blackboard only through callBB. */
export interface BBToolContext {
  callBB: <T>(fn: (http: BBHttp) => Promise<T>) => Promise<T>;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  /** Matches the SDK's CallToolResult index-signature shape. */
  [key: string]: unknown;
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Errors are short, coded, masked — never raw HTML or server internals. */
export function errorResult(err: unknown): ToolResult {
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
} as const;
