import { truncate } from './errors.js';

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read a possibly-nested field with a dot path, e.g. "contentHandler.id". */
export function getField(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    const rec = asRecord(cur);
    if (!rec) return undefined;
    cur = rec[part];
  }
  return cur;
}

export function strField(obj: unknown, path: string): string | undefined {
  const v = getField(obj, path);
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function numField(obj: unknown, path: string): number | undefined {
  const v = getField(obj, path);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function boolField(obj: unknown, path: string): boolean | undefined {
  const v = getField(obj, path);
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Parse the date formats Blackboard emits: ISO strings, epoch millis
 * (numbers), and legacy .NET "/Date(1234567890)/" strings.
 */
export function parseBBDate(value: unknown): Date | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const dotNet = /^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/.exec(value.trim());
  if (dotNet) {
    const d = new Date(Number(dotNet[1]));
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function toIso(value: unknown): string | undefined {
  const d = parseBBDate(value);
  return d ? d.toISOString() : undefined;
}

export function isoOrNow(value: string | undefined): Date {
  if (value) {
    const d = parseBBDate(value);
    if (d) return d;
  }
  return new Date();
}

export function withinWindow(
  iso: string | undefined,
  opts: { after?: string; before?: string },
): boolean {
  if (!iso) return false;
  const d = parseBBDate(iso);
  if (!d) return false;
  if (opts.after) {
    const a = parseBBDate(opts.after);
    if (a && d < a) return false;
  }
  if (opts.before) {
    const b = parseBBDate(opts.before);
    if (b && d > b) return false;
  }
  return true;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToText(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = stripHtml(html);
  return text.length > 0 ? truncate(text, 4000) : undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default width for per-course fan-out. Blackboard is queried for one student
 * across a handful of courses, so a few requests may overlap: the total number
 * of requests is unchanged, they simply are not serialized behind each other.
 * Kept deliberately small — this is a personal tool, not a crawler.
 */
export const DEFAULT_CONCURRENCY = 4;

/**
 * Map over items with at most `limit` promises in flight, preserving input
 * order in the result. Replaces the hand-rolled `for` + `sleep` loops: those
 * paid the full latency of every request in series, which dominated the wait
 * on anything that touched more than one course.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit = DEFAULT_CONCURRENCY,
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

/** Compare Blackboard titles leniently when joining across data sources. */
export function titlesMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
  return norm(a).length > 3 && norm(a) === norm(b);
}
