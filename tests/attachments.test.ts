import { describe, expect, it, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { downloadAttachment, sanitizeFileName } from '../src/blackboard/attachments.js';
import { BlackboardError } from '../src/blackboard/errors.js';
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
