import { globalCache, TTL } from './cache.js';
import { findCourse } from './courses.js';
import { getPaged } from './transport.js';
import { allowLinks } from './link-registry.js';
import { extractLinks } from './links.js';
import { asRecord, htmlToText, strField, toIso, withinWindow } from './util.js';
const API = '/learn/api/public/v1';
/** Normalize a v1 announcement object; body shape varies across deployments. */
export function normalizeAnnouncement(raw, courseId) {
    const rec = asRecord(raw) ?? {};
    const id = strField(rec, 'id');
    const title = strField(rec, 'title');
    if (!id || !title)
        return null;
    const bodyHtml = strField(rec, 'description') ?? strField(rec, 'body.formattedText') ?? strField(rec, 'body');
    const bodyText = strField(rec, 'body.plainText') ?? htmlToText(bodyHtml) ?? '';
    const created = toIso(rec.created) ?? toIso(strField(rec, 'availability.duration.start'));
    const links = extractLinks(bodyHtml);
    allowLinks(links.map((l) => l.url));
    return {
        id,
        courseId,
        title,
        bodyText,
        bodyHtml,
        links,
        created,
        modified: toIso(rec.modified),
        url: `https://blackboard.syr.edu/ultra/courses/${courseId}/cl/outline`,
    };
}
export async function getAnnouncements(http, courseId, opts = {}) {
    const course = await findCourse(http, courseId);
    // Cache the full list and filter afterwards. Caching the filtered list
    // under a key that ignored the filter meant one "last 7 days, top 20"
    // lookup answered every other announcements question for five minutes.
    const all = await globalCache.wrap(`ann:${course.id}`, TTL.announcements, async () => {
        const raw = await getPaged(http, `${API}/courses/${encodeURIComponent(course.id)}/announcements?limit=50`);
        const items = raw
            .map((r) => normalizeAnnouncement(r, course.id))
            .filter((a) => a !== null);
        items.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
        return items;
    });
    let items = all;
    if (opts.since) {
        items = items.filter((a) => withinWindow(a.created, { after: opts.since }) || withinWindow(a.modified, { after: opts.since }));
    }
    return opts.limit ? items.slice(0, opts.limit) : items;
}
/**
 * Institution-level announcements (no course scoping). Used by
 * get_recent_updates; tolerates permission failures silently.
 */
export async function getSystemAnnouncements(http, opts = {}) {
    const data = await getPaged(http, `${API}/announcements?limit=50`).catch(() => []);
    let items = data
        .map((r) => normalizeAnnouncement(r, 'system'))
        .filter((a) => a !== null);
    items.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
    if (opts.since) {
        items = items.filter((a) => withinWindow(a.created, { after: opts.since }) || withinWindow(a.modified, { after: opts.since }));
    }
    return opts.limit ? items.slice(0, opts.limit) : items;
}
