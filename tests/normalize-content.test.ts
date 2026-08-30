import { beforeEach, describe, expect, it } from 'vitest';
import { getCourseContent, normalizeContentItem } from '../src/blackboard/content.js';
import { extractWebdavLinks } from '../src/blackboard/attachments.js';
import { globalCache } from '../src/blackboard/cache.js';
import {
  COURSE_CONTENT_CHILDREN,
  COURSE_CONTENT_ROOT,
  ENROLLMENTS,
  FakeHttp,
  USER_ME,
  COURSES,
} from './helpers/fake-http.js';

beforeEach(() => {
  globalCache.clear();
});

describe('normalizeContentItem', () => {
  it('maps handlers to internal item types', () => {
    const folder = normalizeContentItem(COURSE_CONTENT_ROOT.results[0], '_26184_1');
    expect(folder).toMatchObject({ id: '_3000_1', type: 'folder', hasChildren: true });
    expect(folder?.descriptionText).toBe('First week folder');

    const assignment = normalizeContentItem(COURSE_CONTENT_ROOT.results[1], '_26184_1');
    expect(assignment?.type).toBe('assignment');
    expect(assignment?.descriptionText).toContain('Show your work');

    const linkItem = normalizeContentItem(
      { id: '_9_1', title: 'Read this', contentHandler: { id: 'resource/x-bb-externallink', url: 'https://example.com' } },
      '_26184_1',
    );
    expect(linkItem?.type).toBe('link');
    expect(linkItem?.url).toBe('https://example.com');

    const unknown = normalizeContentItem(
      { id: '_10_1', title: 'Mystery', contentHandler: { id: 'resource/x-bb-something-new' } },
      '_26184_1',
    );
    expect(unknown?.type).toBe('other');
  });

  it('rejects malformed items', () => {
    expect(normalizeContentItem({ title: 'no id' }, '_26184_1')).toBeNull();
  });
});

describe('extractWebdavLinks', () => {
  it('extracts and deduplicates bbcswebdav links, decoding entities', () => {
    const html =
      '<a href="https://blackboard.syr.edu/bbcswebdav/xid-12345_1&amp;course_id=_26184_1">notes.pdf</a>' +
      '<a href="https://blackboard.syr.edu/bbcswebdav/xid-12345_1&amp;course_id=_26184_1">notes.pdf</a>' +
      '<a href="/bbcswebdav/xid-67890_1">slides.pptx</a>';
    const links = extractWebdavLinks(html);
    expect(links).toHaveLength(2);
    expect(links[0].url).toBe('/bbcswebdav/xid-12345_1&course_id=_26184_1');
    expect(links[0].fileName).toBe('notes.pdf');
    expect(links[1].url).toBe('/bbcswebdav/xid-67890_1');
  });

  it('ignores links to other hosts', () => {
    const links = extractWebdavLinks('<a href="https://evil.example/bbcswebdav/xid-1">bad</a>');
    expect(links).toHaveLength(0);
  });
});

describe('getCourseContent', () => {
  function makeHttp(opts: { filesEndpoint: 'ok' | 'missing' } = { filesEndpoint: 'ok' }): FakeHttp {
    const http = new FakeHttp();
    http.on(/\/users\/me$/, () => ({ json: USER_ME }));
    http.on(/\/users\/_777_1\/courses/, () => ({ json: ENROLLMENTS }));
    http.on(/\/courses\?limit=100$/, () => ({ json: COURSES }));
    http.on(/\/courses\/_26184_1\/contents\?limit=100$/, () => ({ json: COURSE_CONTENT_ROOT }));
    http.on(/\/courses\/_26184_1\/contents\/_3000_1\/children\?limit=100$/, () => ({
      json: COURSE_CONTENT_CHILDREN,
    }));
    if (opts.filesEndpoint === 'ok') {
      http.on(/\/courses\/_26184_1\/contents\/_3001_1\/files$/, () => ({
        json: { results: [{ id: '_f1_1', fileName: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 12345 }] },
      }));
    }
    http.on(/\/courses\/_26184_1\/contents\/_3010_1\/files$/, () => ({ status: 404, json: {} }));
    return http;
  }

  it('expands folders one level and resolves attachment metadata', async () => {
    const http = makeHttp();
    const items = await getCourseContent(http, '_26184_1', { depth: 2 });
    const ids = items.map((i) => i.id);
    expect(ids).toContain('_3000_1');
    expect(ids).toContain('_3010_1');
    expect(ids).toContain('_3001_1');

    const notes = items.find((i) => i.id === '_3001_1');
    expect(notes?.attachments).toHaveLength(1);
    expect(notes?.attachments[0]).toMatchObject({
      fileId: '_f1_1',
      fileName: 'notes.pdf',
      source: 'files-api',
    });
  });

  it('falls back to description links when the files endpoint is missing', async () => {
    const http = makeHttp({ filesEndpoint: 'missing' });
    const items = await getCourseContent(http, '_26184_1', { depth: 2 });
    const notes = items.find((i) => i.id === '_3001_1');
    expect(notes?.attachments).toHaveLength(1);
    expect(notes?.attachments[0]?.source).toBe('description');
    expect(notes?.attachments[0]?.fileName).toBe('notes.pdf');
  });

  it('throws COURSE_NOT_FOUND for unknown courses', async () => {
    const http = makeHttp();
    await expect(getCourseContent(http, '_404_1')).rejects.toMatchObject({ code: 'COURSE_NOT_FOUND' });
  });
});
