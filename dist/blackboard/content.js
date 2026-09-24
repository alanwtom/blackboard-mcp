import { globalCache, TTL } from './cache.js';
import { findCourse } from './courses.js';
import { listContentFiles } from './attachments.js';
import { getPaged } from './transport.js';
import { allowLinks } from './link-registry.js';
import { classifyLink, extractLinks, mergeLinks } from './links.js';
import { asRecord, boolField, htmlToText, mapWithConcurrency, strField, toIso, numField } from './util.js';
const API = '/learn/api/public/v1';
/** Upper bound on per-item attachment lookups within one course listing. */
const ATTACHMENT_RESOLUTION_CAP = 40;
const HANDLER_TYPES = {
    'resource/x-bb-folder': 'folder',
    'resource/x-bb-content-folder': 'folder',
    'resource/x-bb-document': 'document',
    'resource/x-bb-file': 'file',
    'resource/x-bb-assignment': 'assignment',
    'resource/x-bb-asmt-test': 'test',
    'resource/x-bb-asmt-survey': 'survey',
    // How Ultra actually lists assignments and tests (seen live, Sep 2026).
    'resource/x-bb-asmt-test-link': 'assignment',
    'resource/x-bb-lesson': 'folder',
    'resource/x-bb-blti-link': 'tool',
    'resource/x-bb-externallink': 'link',
    'resource/x-bb-toollink': 'link',
    'resource/x-bb-blankpage': 'page',
    'resource/x-bb-module-page': 'page',
};
function handlerType(raw) {
    const handlerId = strField(raw, 'contentHandler.id');
    if (!handlerId)
        return 'other';
    return HANDLER_TYPES[handlerId] ?? 'other';
}
/** Normalize a v1 course content object into the internal ContentItem shape. */
export function normalizeContentItem(raw, courseId) {
    const rec = asRecord(raw) ?? {};
    const id = strField(rec, 'id');
    const title = strField(rec, 'title');
    if (!id || !title)
        return null;
    const type = handlerType(rec);
    // Documents keep their text in `body`; `description` is a short summary
    // some items also have. Read both — taking only the first dropped whole
    // documents whenever a professor had also filled in a description.
    // Ultra assignments and tests keep their instructions on the handler.
    const parts = [
        strField(rec, 'description'),
        strField(rec, 'body.formattedText') ?? strField(rec, 'body'),
        strField(rec, 'contentHandler.instructions'),
    ]
        .filter((p) => Boolean(p));
    const descriptionHtml = parts.length > 0 ? [...new Set(parts)].join('\n') : undefined;
    const item = {
        id,
        courseId,
        title,
        type,
        parentId: strField(rec, 'parentId'),
        descriptionHtml,
        descriptionText: htmlToText(descriptionHtml),
        hasChildren: boolField(rec, 'hasChildren') ?? type === 'folder',
        attachments: [],
        links: [],
        position: numField(rec, 'position'),
        gradeColumnId: strField(rec, 'contentHandler.gradeColumnId'),
        modified: toIso(rec.modified),
    };
    const handlerUrl = type === 'link' || type === 'tool' ? strField(rec, 'contentHandler.url') : undefined;
    if (handlerUrl)
        item.url = handlerUrl;
    const own = handlerUrl && type === 'link' ? [{ url: handlerUrl, label: title, kind: classifyLink(handlerUrl) }] : [];
    item.links = mergeLinks(own, extractLinks(descriptionHtml));
    allowLinks(item.links.map((l) => l.url));
    // Ultra file data rides on the handler (verified live); the alternate
    // /ultra/redirect link is what resolves to the actual bytes.
    const altHref = altLinkHref(rec);
    if (!item.url && altHref)
        item.url = altHref;
    const fileName = strField(rec, 'contentHandler.file.fileName') ?? strField(rec, 'contentHandler.file.name');
    if (fileName && (type === 'file' || type === 'document' || type === 'other')) {
        item.attachments.push({
            courseId,
            contentId: id,
            parentId: item.parentId,
            fileName,
            mimeType: strField(rec, 'contentHandler.file.mimeType'),
            url: altHref,
            source: 'handler',
        });
    }
    return item;
}
/** The rel=alternate /ultra/redirect href from a content item's links array. */
function altLinkHref(rec) {
    const links = Array.isArray(rec.links) ? rec.links : [];
    for (const link of links) {
        const rel = strField(link, 'rel');
        const href = strField(link, 'href');
        if (href && (rel === 'alternate' || href.includes('/ultra/redirect'))) {
            return href.startsWith('/') ? href : undefined;
        }
    }
    return undefined;
}
/**
 * Why a listing is incomplete, when it is. Kept beside the (cached) array
 * rather than in it, so every existing caller keeps getting a plain list.
 */
const truncation = new WeakMap();
/** A plain-language note when a course listing was cut short, else undefined. */
export function contentTruncation(items) {
    return truncation.get(items);
}
/**
 * Course content with light hierarchy expansion. Folders are expanded breadth
 * first up to `depth` levels with a bounded item cap; deeper dives use
 * `folderId` to fetch one folder at a time.
 */
export async function getCourseContent(http, courseIdOrCode, opts = {}) {
    // Accept a course code too, but always talk to Blackboard in internal ids.
    const courseId = (await findCourse(http, courseIdOrCode)).id;
    const depth = Math.max(1, Math.min(opts.depth ?? 2, 4));
    const maxItems = opts.maxItems ?? 300;
    const includeAttachments = opts.includeAttachments ?? true;
    const cacheKey = `content:${courseId}:${opts.folderId ?? 'root'}:${depth}:${maxItems}:${includeAttachments}`;
    return globalCache.wrap(cacheKey, TTL.content, async () => {
        const fetchLevel = async (parentId) => {
            const path = parentId
                ? `${API}/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(parentId)}/children?limit=100`
                : `${API}/courses/${encodeURIComponent(courseId)}/contents?limit=100`;
            const page = await getPaged(http, path);
            return page
                .map((r) => normalizeContentItem(r, courseId))
                .filter((i) => i !== null);
        };
        const all = await fetchLevel(opts.folderId);
        let hitCap = all.length > maxItems;
        if (hitCap)
            all.length = maxItems;
        // Gap-filling expansion. Some Ultra listings are fully flat (children
        // included), others list only top-level folders; and a single course can
        // mix both. For every folder whose children are NOT already present in
        // the listing, fetch them (bounded by depth and maxItems).
        const seenIds = new Set(all.map((i) => i.id));
        const foldersWithChildren = new Set(all.map((i) => i.parentId).filter((p) => p !== undefined));
        // Breadth-first, one level at a time: folders within a level are fetched
        // together, and results are merged in listing order, so which items land
        // under the maxItems bound stays deterministic.
        let frontier = all.filter((i) => i.type === 'folder' && i.hasChildren && !foldersWithChildren.has(i.id));
        for (let level = 1; level < depth && frontier.length > 0 && all.length < maxItems; level += 1) {
            const batches = await mapWithConcurrency(frontier, (folder) => fetchLevel(folder.id));
            const next = [];
            for (const children of batches) {
                for (const child of children) {
                    if (all.length >= maxItems) {
                        hitCap = true;
                        break;
                    }
                    if (seenIds.has(child.id))
                        continue;
                    seenIds.add(child.id);
                    all.push(child);
                    if (child.type === 'folder' && child.hasChildren)
                        next.push(child);
                }
            }
            frontier = next;
        }
        if (includeAttachments) {
            // One request per leaf, still capped — but overlapped rather than each
            // one waiting out a fixed delay behind the last.
            // Items that already carry their file (from the listing itself) are
            // skipped: overwriting them with an empty lookup used to erase the only
            // download link a plain file item has.
            const leaves = all
                .filter((i) => (i.type === 'file' || i.type === 'document' || i.type === 'assignment') && i.attachments.length === 0)
                .slice(0, ATTACHMENT_RESOLUTION_CAP);
            await mapWithConcurrency(leaves, async (item) => {
                const found = await listContentFiles(http, courseId, item.id, item.descriptionHtml).catch(() => []);
                if (found.length > 0)
                    item.attachments = found;
            });
        }
        all.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        if (hitCap) {
            truncation.set(all, `Only the first ${maxItems} items are listed; this course has more. Pass folder_id to list one folder at a time.`);
        }
        else if (frontier.length > 0) {
            truncation.set(all, `Folders nested deeper than ${depth} levels are not expanded. Pass folder_id to open them: ${frontier.slice(0, 10).map((f) => `"${f.title}" (${f.id})`).join(', ')}.`);
        }
        return all;
    });
}
