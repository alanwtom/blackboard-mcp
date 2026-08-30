import { globalCache, TTL } from './cache.js';
import { findCourse } from './courses.js';
import { listContentFiles } from './attachments.js';
import { getPaged } from './transport.js';
import type { BBHttp } from './session.js';
import type { ContentItem, ContentItemType } from './types.js';
import { asRecord, boolField, htmlToText, sleep, strField, toIso, numField } from './util.js';

const API = '/learn/api/public/v1';

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

    // Ultra listings are flat: every item carries parentId and children are
    // already included. Only expand via extra requests for deployments that
    // return roots only (no parentIds) — and never for explicit folder views.
    const flatListing = !opts.folderId && all.some((i) => i.parentId !== undefined);
    if (!flatListing) {
      const queue: { folder: ContentItem; level: number }[] = all
        .filter((i) => i.type === 'folder' && i.hasChildren)
        .map((folder) => ({ folder, level: 1 }));

      while (queue.length > 0 && all.length < maxItems) {
        const { folder, level } = queue.shift() as { folder: ContentItem; level: number };
        if (level >= depth) continue;
        await sleep(150);
        const children = await fetchLevel(folder.id);
        for (const child of children) {
          if (all.length >= maxItems) break;
          if (all.some((existing) => existing.id === child.id)) continue;
          all.push(child);
          if (child.type === 'folder' && child.hasChildren) {
            queue.push({ folder: child, level: level + 1 });
          }
        }
      }
    }

    if (includeAttachments) {
      const leaves = all.filter((i) => i.type === 'file' || i.type === 'document' || i.type === 'assignment');
      let resolved = 0;
      for (const item of leaves) {
        if (resolved >= 40) break;
        resolved += 1;
        await sleep(120);
        try {
          item.attachments = await listContentFiles(http, courseId, item.id, item.descriptionHtml);
        } catch {
          item.attachments = [];
        }
      }
    }

    all.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return all;
  });
}
