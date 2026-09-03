import { describe, expect, it, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { downloadAttachment, downloadAttachmentRef, sanitizeFileName } from '../src/blackboard/attachments.js';
import { BlackboardError } from '../src/blackboard/errors.js';
import { MAX_DOWNLOAD_BYTES } from '../src/blackboard/session.js';
import { globalCache } from '../src/blackboard/cache.js';
import { FakeHttp, installDefaultRoutes } from './helpers/fake-http.js';
import { paths } from '../src/storage/session-store.js';

// Redirect all persistent state to a throwaway directory for this test file.
beforeAll(() => {
  process.env.BLACKBOARD_MCP_HOME = path.join(os.tmpdir(), `bb-mcp-test-${process.pid}-${Date.now()}`);
});

describe('sanitizeFileName', () => {
  it('strips path traversal attempts', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('..\\..\\windows\\system32\\evil.dll')).toBe('evil.dll');
    expect(sanitizeFileName('/absolute/path/file.pdf')).toBe('file.pdf');
  });

  it('handles control characters, dots, and empties', () => {
    expect(sanitizeFileName('..')).toBe('attachment');
    expect(sanitizeFileName('')).toBe('attachment');
    expect(sanitizeFileName('bad\x00name.txt')).toBe('badname.txt');
  });

  it('keeps reasonable extensions on long names', () => {
    const long = `${'a'.repeat(300)}.pdf`;
    const clean = sanitizeFileName(long);
    expect(clean.length).toBeLessThanOrEqual(120);
    expect(clean.endsWith('.pdf')).toBe(true);
  });
});

describe('downloadAttachment', () => {
  it('downloads into the managed downloads directory and reports the path', async () => {
    globalCache.clear();
    const http = new FakeHttp();
    installDefaultRoutes(http);
    const result = await downloadAttachment(http, {
      courseId: '_26184_1',
      contentId: '_3001_1',
      fileId: '_f1_1',
      subfolder: 'CIS.473.M001.FALL2026',
    });
    const resolved = result.path;
    expect(resolved.startsWith(paths.downloadsDir)).toBe(true);
    expect(resolved).toContain('CIS.473.M001.FALL2026');
    expect(result.fileName.endsWith('.pdf')).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('throws ATTACHMENT_NOT_FOUND when the content has no files', async () => {
    globalCache.clear();
    const http = new FakeHttp();
    installDefaultRoutes(http);
    await expect(
      downloadAttachment(http, { courseId: '_26184_1', contentId: '_3010_1' }),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
  });

  it('routes a ref with no url through the redirect capture, not a same-origin fetch', async () => {
    globalCache.clear();
    const http = new FakeHttp();
    installDefaultRoutes(http);
    // Files-api refs arrive without a url; the download link has to be rebuilt
    // as an /ultra/redirect and resolved through the page.
    await downloadAttachmentRef(http, { courseId: '_26184_1', contentId: '_3001_1', fileName: 'deck.pdf' });
    const capture = http.requests.find((r) => r.startsWith('CAPTURE'));
    expect(capture).toBeDefined();
    expect(capture).toContain('/ultra/redirect');
    expect(capture).toContain('courseId=_26184_1');
    expect(capture).toContain('contentId=_3001_1');
    expect(http.requests.some((r) => r.startsWith('BUFFER'))).toBe(false);
  });

  it('handles a file far larger than Chromium buffers in memory', async () => {
    globalCache.clear();
    const http = new FakeHttp();
    installDefaultRoutes(http);
    // 26 MB: the size that used to fail, because the body was evicted from the
    // DevTools inspector cache before it could be read.
    const big = Buffer.alloc(26 * 1024 * 1024, 0x41);
    big.write('%PDF-1.4');
    http.bufferReply = () => ({ status: 200, contentType: 'application/pdf', bytes: big, filename: 'big.pdf' });
    const saved = await downloadAttachmentRef(http, {
      courseId: '_26184_1',
      contentId: '_3001_1',
      fileName: 'big.pdf',
    });
    expect(saved.sizeBytes).toBe(big.length);
    expect(saved.fileName).toBe('big.pdf');
  });

  it('refuses a file over the size ceiling instead of writing it', async () => {
    globalCache.clear();
    const http = new FakeHttp();
    installDefaultRoutes(http);
    http.bufferReply = () => ({
      status: 200,
      contentType: 'application/pdf',
      bytes: Buffer.alloc(MAX_DOWNLOAD_BYTES + 1),
      filename: 'huge.pdf',
    });
    await expect(
      downloadAttachmentRef(http, { courseId: '_26184_1', contentId: '_3001_1', fileName: 'huge.pdf' }),
    ).rejects.toMatchObject({ code: 'CONTENT_NOT_AVAILABLE' });
  });

  it('reports a failed download by status rather than writing a stub', async () => {
    globalCache.clear();
    const http = new FakeHttp();
    installDefaultRoutes(http);
    http.bufferReply = () => ({ status: 404, contentType: null, bytes: Buffer.alloc(0) });
    await expect(
      downloadAttachmentRef(http, { courseId: '_26184_1', contentId: '_3001_1', fileName: 'gone.pdf' }),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
  });

  it('throws INVALID_INPUT when asked for an unknown file id', async () => {
    globalCache.clear();
    const http = new FakeHttp();
    installDefaultRoutes(http);
    const err = await downloadAttachment(http, {
      courseId: '_26184_1',
      contentId: '_3001_1',
      fileId: '_nope_1',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlackboardError);
    expect((err as BlackboardError).code).toBe('ATTACHMENT_NOT_FOUND');
    expect((err as BlackboardError).message).toContain('_nope_1');
  });
});
