import { globalCache, TTL } from './cache.js';
import { findCourse } from './courses.js';
import { listContentFiles } from './attachments.js';
import { getPaged } from './transport.js';
import type { BBHttp } from './session.js';
import type { ContentItem, ContentItemType } from './types.js';
import { asRecord, boolField, htmlToText, mapWithConcurrency, strField, toIso, numField } from './util.js';

const API = '/learn/api/public/v1';

/** Upper bound on per-item attachment lookups within one course listing. */
const ATTACHMENT_RESOLUTION_CAP = 40;

const HANDLER_TYPES: Record<string, ContentItemType> = {
  'resource/x-bb-folder': 'folder',
  'resource/x-bb-content-folder': 'folder',
  'resource/x-bb-document': 'document',
  'resource/x-bb-file': 'file',
  'resource/x-bb-assignment': 'assignment',
  'resource/x-bb-asmt-test': 'test',
  'resource/x-bb-asmt-survey': 'survey',
  'resource/x-bb-externallink': 'link',
  'resource/x-bb-toollink': 'link',
  'resource/x-bb-blankpage': 'page',
  'resource/x-bb-module-page': 'page',
};

function handlerType(raw: unknown): ContentItemType {
  const handlerId = strField(raw, 'contentHandler.id');
  if (!handlerId) return 'other';
  return HANDLER_TYPES[handlerId] ?? 'other';
}

/** Normalize a v1 course content object into the internal ContentItem shape. */
export function normalizeContentItem(raw: unknown, courseId: string): ContentItem | null {
  const rec = asRecord(raw) ?? {};
  const id = strField(rec, 'id');
  const title = strField(rec, 'title');
  if (!id || !title) return null;
  const type = handlerType(rec);
  const descriptionHtml = strField(rec, 'description') ?? strField(rec, 'body.formattedText') ?? strField(rec, 'body');
  const item: ContentItem = {
    id,
    courseId,
    title,
    type,
    parentId: strField(rec, 'parentId'),
    descriptionHtml,
    descriptionText: htmlToText(descriptionHtml),
    hasChildren: boolField(rec, 'hasChildren') ?? type === 'folder',
    attachments: [],
    position: numField(rec, 'position'),
    modified: toIso(rec.modified),
  };
  if (type === 'link') {
    item.url = strField(rec, 'contentHandler.url');
  }
  // Ultra file data rides on the handler (verified live); the alternate
  // /ultra/redirect link is what resolves to the actual bytes.
  const altHref = altLinkHref(rec);
  if (!item.url && altHref) item.url = altHref;
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
function altLinkHref(rec: Record<string, unknown>): string | undefined {
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

export interface GetContentOptions {
  /** Fetch children of a specific folder instead of the course root. */
  folderId?: string;
  /** How many folder levels to include (default 2: root + first-level folders). */
  depth?: number;
  /** Hard cap on items fetched, to keep request volume low. */
  maxItems?: number;
  /** Resolve attachment metadata for leaf items (default true). */
  includeAttachments?: boolean;
}

/**
 * Course content with light hierarchy expansion. Folders are expanded breadth
 * first up to `depth` levels with a bounded item cap; deeper dives use
 * `folderId` to fetch one folder at a time.
 */
export async function getCourseContent(http: BBHttp, courseId: string, opts: GetContentOptions = {}): Promise<ContentItem[]> {
  await findCourse(http, courseId);
  const depth = Math.max(1, Math.min(opts.depth ?? 2, 4));
  const maxItems = opts.maxItems ?? 300;
  const includeAttachments = opts.includeAttachments ?? true;

  const cacheKey = `content:${courseId}:${opts.folderId ?? 'root'}:${depth}:${maxItems}:${includeAttachments}`;
  return globalCache.wrap(cacheKey, TTL.content, async () => {
    const fetchLevel = async (parentId?: string): Promise<ContentItem[]> => {
      const path = parentId
        ? `${API}/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(parentId)}/children?limit=100`
        : `${API}/courses/${encodeURIComponent(courseId)}/contents?limit=100`;
      const page = await getPaged<unknown>(http, path);
      return page
        .map((r) => normalizeContentItem(r, courseId))
        .filter((i): i is ContentItem => i !== null);
    };

    const all: ContentItem[] = await fetchLevel(opts.folderId);
    if (all.length > maxItems) all.length = maxItems;

    // Gap-filling expansion. Some Ultra listings are fully flat (children
    // included), others list only top-level folders; and a single course can
    // mix both. For every folder whose children are NOT already present in
    // the listing, fetch them (bounded by depth and maxItems).
    const seenIds = new Set(all.map((i) => i.id));
    const foldersWithChildren = new Set(
      all.map((i) => i.parentId).filter((p): p is string => p !== undefined),
    );
    // Breadth-first, one level at a time: folders within a level are fetched
    // together, and results are merged in listing order, so which items land
    // under the maxItems bound stays deterministic.
    let frontier = all.filter((i) => i.type === 'folder' && i.hasChildren && !foldersWithChildren.has(i.id));
    for (let level = 1; level < depth && frontier.length > 0 && all.length < maxItems; level += 1) {
      const batches = await mapWithConcurrency(frontier, (folder) => fetchLevel(folder.id));
      const next: ContentItem[] = [];
      for (const children of batches) {
        for (const child of children) {
          if (all.length >= maxItems) break;
          if (seenIds.has(child.id)) continue;
          seenIds.add(child.id);
          all.push(child);
          if (child.type === 'folder' && child.hasChildren) next.push(child);
        }
      }
      frontier = next;
    }

    if (includeAttachments) {
      // One request per leaf, still capped — but overlapped rather than each
      // one waiting out a fixed delay behind the last.
      const leaves = all
        .filter((i) => i.type === 'file' || i.type === 'document' || i.type === 'assignment')
        .slice(0, ATTACHMENT_RESOLUTION_CAP);
      await mapWithConcurrency(leaves, async (item) => {
        item.attachments = await listContentFiles(http, courseId, item.id, item.descriptionHtml).catch(() => []);
      });
    }

    all.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return all;
  });
}
