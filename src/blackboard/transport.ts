import { BlackboardError, truncate, isBlackboardError } from './errors.js';
import type { BBHttp, BBJsonResponse } from './session.js';
import { sleep } from './util.js';

/**
 * Generic helpers over the authenticated transport: JSON classification,
 * pagination, and courtesy pacing. All domain modules go through these so
 * error handling and request volume stay consistent.
 */

const PAGE_DELAY_MS = 200;
const MAX_PAGES = 25;
const MAX_RESULTS = 2000;

export interface GetJsonOptions {
  /** Return null instead of throwing on HTTP 404. */
  allowNotFound?: boolean;
  /** Overrides the error raised on 404 (e.g. COURSE_NOT_FOUND). */
  notFoundCode?: 'COURSE_NOT_FOUND' | 'CONTENT_NOT_AVAILABLE' | 'ATTACHMENT_NOT_FOUND';
  notFoundMessage?: string;
}

function apiLabel(path: string): string {
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}

function looksLikeHtml(resp: BBJsonResponse): boolean {
  const ct = resp.contentType ?? '';
  if (ct.includes('html')) return true;
  const head = resp.text.slice(0, 200).trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

export async function getJson<T = unknown>(
  http: BBHttp,
  path: string,
  opts: GetJsonOptions = {},
): Promise<T | null> {
  let resp: BBJsonResponse;
  try {
    resp = await http.fetchJson(path);
  } catch (err) {
    if (isBlackboardError(err) && err.code === 'INVALID_INPUT') throw err;
    throw err;
  }

  // A 200 that is actually the login/SSO HTML page means the session is gone.
  if (looksLikeHtml(resp)) {
    throw BlackboardError.sessionExpired('Blackboard returned an HTML page instead of API data');
  }
  if (resp.status === 401) {
    throw BlackboardError.sessionExpired(`HTTP 401 from ${apiLabel(path)}`);
  }
  if (resp.status === 403) {
    throw new BlackboardError(
      'PERMISSION_DENIED',
      `Blackboard denied access to ${apiLabel(path)} (HTTP 403). This data is not visible to the signed-in student.`,
      { status: 403 },
    );
  }
  if (resp.status === 404) {
    if (opts.allowNotFound) return null;
    throw new BlackboardError(
      opts.notFoundCode ?? 'BLACKBOARD_REQUEST_FAILED',
      opts.notFoundMessage ?? `Blackboard resource not found: ${apiLabel(path)} (HTTP 404)`,
      { status: 404 },
    );
  }
  if (resp.status === 429) {
    throw new BlackboardError(
      'BLACKBOARD_REQUEST_FAILED',
      'Blackboard rate limit hit (HTTP 429). Wait a moment before retrying — this tool intentionally keeps request volume low.',
      { status: 429 },
    );
  }
  if (resp.status >= 400) {
    const snippet = truncate(resp.text, 160);
    throw new BlackboardError(
      'BLACKBOARD_REQUEST_FAILED',
      `Blackboard API request failed for ${apiLabel(path)} (HTTP ${resp.status}): ${snippet}`,
      { status: resp.status },
    );
  }

  try {
    return JSON.parse(resp.text) as T;
  } catch {
    throw new BlackboardError(
      'BLACKBOARD_REQUEST_FAILED',
      `Blackboard returned non-JSON data for ${apiLabel(path)}. The session may have expired — run npm run status.`,
    );
  }
}

/** Extract the results array from a paged (`{results, paging}`) or plain response. */
function extractResults(data: unknown): { results: unknown[]; nextHref?: string } {
  if (Array.isArray(data)) return { results: data };
  if (data !== null && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    const results = Array.isArray(rec.results) ? rec.results : null;
    if (results) {
      const paging = rec.paging as Record<string, unknown> | undefined;
      const nextPage = paging?.nextPage as Record<string, unknown> | undefined;
      const href = typeof nextPage?.href === 'string' ? nextPage.href : undefined;
      return { results, nextHref: href };
    }
    return { results: [data] };
  }
  throw new BlackboardError('BLACKBOARD_REQUEST_FAILED', 'Unexpected response shape from Blackboard API.');
}

export interface GetPagedOptions {
  maxPages?: number;
  maxResults?: number;
  notFoundCode?: 'COURSE_NOT_FOUND' | 'CONTENT_NOT_AVAILABLE';
  notFoundMessage?: string;
}

/**
 * Walk a Blackboard paged endpoint following `paging.nextPage.href`, with a
 * small courtesy delay between pages and hard caps so we never hammer Blackboard.
 */
export async function getPaged<T = unknown>(
  http: BBHttp,
  path: string,
  opts: GetPagedOptions = {},
): Promise<T[]> {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const maxResults = opts.maxResults ?? MAX_RESULTS;
  let next: string = path;
  const out: unknown[] = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await getJson<unknown>(http, next, {
      notFoundCode: opts.notFoundCode,
      notFoundMessage: opts.notFoundMessage,
    });
    const { results, nextHref } = extractResults(data);
    out.push(...results);
    if (out.length >= maxResults) break;
    if (!nextHref) break;
    next = http.toSameOriginPath(nextHref);
    if (page < maxPages - 1) await sleep(PAGE_DELAY_MS);
  }
  return out as T[];
}
