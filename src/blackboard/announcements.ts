import { globalCache, TTL } from './cache.js';
import { findCourse } from './courses.js';
import { getPaged } from './transport.js';
import type { BBHttp } from './session.js';
import type { Announcement } from './types.js';
import { asRecord, htmlToText, strField, toIso, withinWindow } from './util.js';

const API = '/learn/api/public/v1';

/** Normalize a v1 announcement object; body shape varies across deployments. */
export function normalizeAnnouncement(raw: unknown, courseId: string): Announcement | null {
  const rec = asRecord(raw) ?? {};
  const id = strField(rec, 'id');
  const title = strField(rec, 'title');
  if (!id || !title) return null;
  const bodyHtml = strField(rec, 'description') ?? strField(rec, 'body.formattedText') ?? strField(rec, 'body');
  const bodyText = strField(rec, 'body.plainText') ?? htmlToText(bodyHtml) ?? '';
  const created = toIso(rec.created) ?? toIso(strField(rec, 'availability.duration.start'));
  return {
    id,
    courseId,
    title,
    bodyText,
    bodyHtml,
    created,
    modified: toIso(rec.modified),
    url: `https://blackboard.syr.edu/ultra/courses/${courseId}/cl/outline`,
  };
}

export interface GetAnnouncementsOptions {
  /** ISO date; only announcements created on/after this instant are returned. */
  since?: string;
  limit?: number;
}

export async function getAnnouncements(
  http: BBHttp,
  courseId: string,
  opts: GetAnnouncementsOptions = {},
): Promise<Announcement[]> {
  await findCourse(http, courseId);
  const cacheKey = `ann:${courseId}`;
  return globalCache.wrap(cacheKey, TTL.announcements, async () => {
    const raw = await getPaged<unknown>(
      http,
      `${API}/courses/${encodeURIComponent(courseId)}/announcements?limit=50`,
    );
    let items = raw
      .map((r) => normalizeAnnouncement(r, courseId))
      .filter((a): a is Announcement => a !== null);
    items.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
    if (opts.since) {
      items = items.filter((a) => withinWindow(a.created, { after: opts.since }) || withinWindow(a.modified, { after: opts.since }));
    }
    return opts.limit ? items.slice(0, opts.limit) : items;
  });
}

/**
 * Institution-level announcements (no course scoping). Used by
 * get_recent_updates; tolerates permission failures silently.
 */
export async function getSystemAnnouncements(http: BBHttp, opts: GetAnnouncementsOptions = {}): Promise<Announcement[]> {
  const data = await getPaged<unknown>(http, `${API}/announcements?limit=50`).catch(() => []);
  let items = data
    .map((r) => normalizeAnnouncement(r, 'system'))
    .filter((a): a is Announcement => a !== null);
  items.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
  if (opts.since) {
    items = items.filter((a) => withinWindow(a.created, { after: opts.since }) || withinWindow(a.modified, { after: opts.since }));
  }
  return opts.limit ? items.slice(0, opts.limit) : items;
}
