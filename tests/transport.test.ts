import { beforeEach, describe, expect, it } from 'vitest';
import { getJson, getPaged } from '../src/blackboard/transport.js';
import { BlackboardError } from '../src/blackboard/errors.js';
import { globalCache } from '../src/blackboard/cache.js';
import { FakeHttp } from './helpers/fake-http.js';

beforeEach(() => {
  globalCache.clear();
});

describe('getJson', () => {
  it('parses JSON responses', async () => {
    const http = new FakeHttp();
    http.on(/ok$/, () => ({ json: { hello: 'world' } }));
    await expect(getJson(http, '/ok')).resolves.toEqual({ hello: 'world' });
  });

  it('maps 401 to BLACKBOARD_SESSION_EXPIRED', async () => {
    const http = new FakeHttp();
    http.on(/x$/, () => ({ status: 401, json: { status: 401, message: 'unauthorized' } }));
    const err = await getJson(http, '/x').catch((e) => e);
    expect(err).toBeInstanceOf(BlackboardError);
    expect((err as BlackboardError).code).toBe('BLACKBOARD_SESSION_EXPIRED');
    expect((err as BlackboardError).message).toContain('npm run login');
  });

  it('maps an HTML login page to BLACKBOARD_SESSION_EXPIRED even with HTTP 200', async () => {
    const http = new FakeHttp();
    http.on(/x$/, () => ({
      status: 200,
      contentType: 'text/html',
      text: '<!DOCTYPE html><html><body>Please sign in</body></html>',
    }));
    await expect(getJson(http, '/x')).rejects.toMatchObject({ code: 'BLACKBOARD_SESSION_EXPIRED' });
  });

  it('maps 403 to PERMISSION_DENIED', async () => {
    const http = new FakeHttp();
    http.on(/x$/, () => ({ status: 403, json: { status: 403 } }));
    await expect(getJson(http, '/x')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('maps 404 per options', async () => {
    const http = new FakeHttp();
    http.on(/x$/, () => ({ status: 404, json: { status: 404 } }));

    await expect(getJson(http, '/x')).rejects.toBeInstanceOf(BlackboardError);
    await expect(getJson(http, '/x', { allowNotFound: true })).resolves.toBeNull();
    await expect(
      getJson(http, '/x', { notFoundCode: 'COURSE_NOT_FOUND', notFoundMessage: 'Course not found' }),
    ).rejects.toMatchObject({ code: 'COURSE_NOT_FOUND' });
  });

  it('reports 429 rate limiting without hammering', async () => {
    const http = new FakeHttp();
    http.on(/x$/, () => ({ status: 429, json: {} }));
    await expect(getJson(http, '/x')).rejects.toMatchObject({ code: 'BLACKBOARD_REQUEST_FAILED' });
    expect(http.requests.filter((r) => r === 'GET /x')).toHaveLength(1);
  });
});

describe('getPaged', () => {
  it('follows paging.nextPage.href across pages', async () => {
    const http = new FakeHttp();
    http.on(/\/list$/, () => ({
      json: {
        results: [{ n: 1 }, { n: 2 }],
        paging: { nextPage: { href: '/list?offset=2&limit=2' } },
      },
    }));
    http.on(/\/list\?offset=2&limit=2$/, () => ({ json: { results: [{ n: 3 }] } }));

    const items = await getPaged<{ n: number }>(http, '/list');
    expect(items.map((i) => i.n)).toEqual([1, 2, 3]);
  });

  it('handles plain-array responses', async () => {
    const http = new FakeHttp();
    http.on(/\/flat$/, () => ({ json: [{ a: 1 }, { a: 2 }] }));
    await expect(getPaged(http, '/flat')).resolves.toHaveLength(2);
  });

  it('caps page count to stay low-volume', async () => {
    const http = new FakeHttp();
    let page = 0;
    http.on(/\/endless/, (path) => {
      page += 1;
      const offset = Number(/offset=(\d+)/.exec(path)?.[1] ?? 0);
      return {
        json: {
          results: [{ offset }],
          paging: { nextPage: { href: `/endless?offset=${offset + 1}` } },
        },
      };
    });
    const items = await getPaged(http, '/endless?offset=0', { maxPages: 5 });
    expect(items).toHaveLength(5);
    expect(page).toBe(5);
  });
});
