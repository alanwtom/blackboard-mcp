import { globalCache, TTL } from './cache.js';
import { BlackboardError, truncate } from './errors.js';
import { isBlackboardHost } from './hosts.js';
import { getJson } from './transport.js';
import type { BBHttp } from './session.js';
import type { AttachmentRef, AttachmentSaveResult } from './types.js';
import { asRecord, htmlToText, numField, strField } from './util.js';
import { paths } from '../storage/session-store.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const API = '/learn/api/public/v1';

const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const TEXT_EXCERPT_MAX_BYTES = 256 * 1024;
const TEXT_EXCERPT_CHARS = 4000;

/**
 * Extract /bbcswebdav/xid-... attachment links embedded in content HTML
 * (common for documents that carry file chips in their body).
 */
export function extractWebdavLinks(html: string): { url: string; fileName?: string }[] {
  const out: { url: string; fileName?: string }[] = [];
  const seen = new Set<string>();
  const anchor = /<a\b[^>]*href="([^"]*\/bbcswebdav\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html)) !== null) {
    let href = m[1].replace(/&amp;/g, '&');
    const label = htmlToText(m[2]);
    const key = href.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    if (!href.startsWith('/')) {
      try {
        const u = new URL(href);
        if (!isBlackboardHost(u)) continue;
        href = `${u.pathname}${u.search}`;
      } catch {
        continue;
      }
    }
    out.push({ url: href, fileName: label ?? undefined });
  }
  // Bare links without anchors (rare, e.g. plain-text bodies).
  const bare = /["'(\s](\/bbcswebdav\/[A-Za-z0-9_\-./%]+[?][^"'\s)]+|\/bbcswebdav\/[A-Za-z0-9_\-./%]+)/g;
  while ((m = bare.exec(html)) !== null) {
    const href = m[1].replace(/&amp;/g, '&');
    const key = href.split('?')[0];
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ url: href });
    }
  }
  return out;
}

function normalizeFileEntry(raw: unknown, courseId: string, contentId: string): AttachmentRef | null {
  const rec = asRecord(raw) ?? {};
  const fileId = strField(rec, 'id') ?? strField(rec, 'fileId');
  const fileName = strField(rec, 'fileName') ?? strField(rec, 'name') ?? strField(rec, 'originalFileName');
  if (!fileId && !fileName) return null;
  return {
    fileId,
    courseId,
    contentId,
    fileName,
    mimeType: strField(rec, 'mimeType') ?? strField(rec, 'contentType'),
    sizeBytes: numField(rec, 'sizeBytes') ?? numField(rec, 'size'),
    url: strField(rec, 'url') ?? undefined,
    source: 'files-api',
  };
}

/**
 * List attachments for one content item. Tries the Learn "content files"
 * endpoints first, then falls back to /bbcswebdav links embedded in the item's
 * HTML. Every failure mode degrades to an empty list, never a hard error —
 * attachments are best-effort metadata.
 */
export async function listContentFiles(http: BBHttp, courseId: string, contentId: string, descriptionHtml?: string): Promise<AttachmentRef[]> {
  const cacheKey = `files:${courseId}:${contentId}`;
  return globalCache.wrap(cacheKey, TTL.content, async () => {
    const endpoints = [
      `${API}/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(contentId)}/files`,
      `${API}/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(contentId)}/attachments`,
    ];
    for (const endpoint of endpoints) {
      const data = await getJson<unknown>(http, endpoint, { allowNotFound: true });
      if (data === null) continue;
      const results = Array.isArray(data) ? data : Array.isArray((data as Record<string, unknown>)?.results)
        ? ((data as Record<string, unknown>).results as unknown[])
        : null;
      if (results && results.length > 0) {
        const refs = results
          .map((r) => normalizeFileEntry(r, courseId, contentId))
          .filter((r): r is AttachmentRef => r !== null);
        if (refs.length > 0) return refs;
      }
    }
    if (descriptionHtml) {
      return extractWebdavLinks(descriptionHtml).map((link) => ({
        courseId,
        contentId,
        fileName: link.fileName,
        url: link.url,
        source: 'description' as const,
      }));
    }
    return [];
  });
}

/** Resolve a concrete same-origin URL for downloading one attachment. */
export async function resolveAttachmentUrl(
  http: BBHttp,
  courseId: string,
  contentId: string,
  fileId?: string,
): Promise<AttachmentRef> {
  const refs = await listContentFiles(http, courseId, contentId);
  if (refs.length === 0) {
    throw new BlackboardError(
      'ATTACHMENT_NOT_FOUND',
      `No attachments found for content ${contentId} in course ${courseId}.`,
    );
  }
  const chosen = fileId ? refs.find((r) => r.fileId === fileId) : refs[0];
  if (!chosen) {
    throw new BlackboardError(
      'ATTACHMENT_NOT_FOUND',
      `Attachment "${fileId}" not found on content ${contentId}. Available files: ${refs
        .map((r) => r.fileName ?? r.fileId ?? '(unnamed)')
        .join(', ')}`,
    );
  }
  if (!chosen.url && chosen.fileId) {
    // Last-resort construction of the standard webdav xid path; the download
    // attempt itself verifies it.
    const id = chosen.fileId.startsWith('_') ? chosen.fileId.slice(1) : chosen.fileId;
    chosen.url = `/bbcswebdav/xid-${id}_1`;
  }
  if (!chosen.url) {
    throw new BlackboardError('ATTACHMENT_NOT_FOUND', 'Attachment has no downloadable URL.');
  }
  return chosen;
}

const TEXTY_EXT = new Set(['.txt', '.md', '.csv', '.json', '.html', '.htm', '.xml', '.log', '.srt', '.vtt']);

function isTexty(fileName: string, mimeType?: string): boolean {
  if (mimeType && (mimeType.startsWith('text/') || mimeType === 'application/json')) return true;
  const ext = path.extname(fileName).toLowerCase();
  return TEXTY_EXT.has(ext);
}

/** Keep files inside the managed downloads root; never trust server names. */
export function sanitizeFileName(name: string): string {
  // Treat backslashes as separators too, then take only the final segment.
  const normalized = name.replace(/[\\/]+/g, '/');
  const ext = path.posix.extname(normalized).toLowerCase().slice(0, 12);
  const base = path.posix.basename(normalized).replace(/[\u0000-\u001f]/g, '').trim();
  let clean = base === '' || base === '.' || base === '..' ? 'attachment' : base;
  if (clean.length > 120) {
    clean = clean.slice(0, 120 - ext.length) + ext;
  }
  return clean;
}

function safeJoin(root: string, ...parts: string[]): string {
  const resolved = path.resolve(root, ...parts);
  const normalizedRoot = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(normalizedRoot)) {
    throw new BlackboardError('INVALID_INPUT', 'Refusing to save outside the blackboard-mcp downloads directory.');
  }
  return resolved;
}

/**
 * Download one resolved attachment reference (e.g. from a content item's
 * handler data — the /ultra/redirect link resolves to the actual bytes).
 */
export async function downloadAttachmentRef(
  http: BBHttp,
  ref: AttachmentRef,
  opts: { fileName?: string; subfolder?: string } = {},
): Promise<AttachmentSaveResult> {
  if (!ref.url) {
    throw new BlackboardError('ATTACHMENT_NOT_FOUND', 'Attachment has no downloadable URL.');
  }
  const resp = await http.fetchBuffer(ref.url);
  if (resp.status !== 200) {
    throw new BlackboardError(
      resp.status === 404 ? 'ATTACHMENT_NOT_FOUND' : 'BLACKBOARD_REQUEST_FAILED',
      `Attachment download failed (HTTP ${resp.status}).`,
      { status: resp.status },
    );
  }
  if (resp.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new BlackboardError('CONTENT_NOT_AVAILABLE', 'Attachment is too large to download (over 200 MB).');
  }

  const rawName = opts.fileName ?? ref.fileName ?? resp.filename ?? `attachment-${ref.contentId}`;
  const fileName = sanitizeFileName(rawName);
  const dir = opts.subfolder
    ? safeJoin(paths.downloadsDir, sanitizeFileName(opts.subfolder))
    : safeJoin(paths.downloadsDir);
  await fs.mkdir(dir, { recursive: true });
  let target = safeJoin(dir, fileName);
  let counter = 1;
  while (true) {
    try {
      await fs.access(target);
      target = safeJoin(dir, fileName.replace(/(\.[^.]*)?$/, `-${counter}$1`));
      counter += 1;
    } catch {
      break;
    }
  }
  await fs.writeFile(target, resp.bytes);

  const result: AttachmentSaveResult = {
    path: target,
    fileName: path.basename(target),
    sizeBytes: resp.bytes.length,
    mimeType: resp.contentType ?? ref.mimeType,
  };
  if (isTexty(result.fileName, result.mimeType) && resp.bytes.length <= TEXT_EXCERPT_MAX_BYTES) {
    result.textExcerpt = truncate(resp.bytes.toString('utf8'), TEXT_EXCERPT_CHARS);
  }
  return result;
}

export interface DownloadOptions {
  courseId: string;
  contentId: string;
  fileId?: string;
  /** Preferred file name (sanitized); defaults to the server-provided name. */
  fileName?: string;
  /** Subdirectory inside the downloads root (sanitized), e.g. a course folder. */
  subfolder?: string;
}

/**
 * Download one course attachment into ~/.blackboard-mcp/downloads/. Files are
 * saved locally only when explicitly requested by a tool call — nothing is
 * uploaded anywhere, ever.
 */
export async function downloadAttachment(http: BBHttp, opts: DownloadOptions): Promise<AttachmentSaveResult> {
  const ref = await resolveAttachmentUrl(http, opts.courseId, opts.contentId, opts.fileId);
  return downloadAttachmentRef(http, ref, { fileName: opts.fileName, subfolder: opts.subfolder });
}
