import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBlackboardServer } from '../src/index.js';
import { globalCache } from '../src/blackboard/cache.js';
import { clearAllowedLinks } from '../src/blackboard/link-registry.js';
import type { BBHttp, ExternalHttp } from '../src/blackboard/session.js';
import { parseWindowBound, withinWindow } from '../src/blackboard/util.js';
import { FakeHttp, installDefaultRoutes } from './helpers/fake-http.js';

beforeAll(() => {
  process.env.BLACKBOARD_MCP_HOME = path.join(os.tmpdir(), `bb-mcp-fixes-${process.pid}-${Date.now()}`);
});

beforeEach(() => {
  globalCache.clear();
  clearAllowedLinks();
});

const DAY = 24 * 3600_000;
const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

async function connect(
  pre?: (http: FakeHttp) => void,
  openSignIn?: (url: string, service: string) => Promise<'opened' | 'busy'>,
): Promise<{ client: Client; http: FakeHttp }> {
  const http = new FakeHttp();
  pre?.(http);
  installDefaultRoutes(http);
  const callBB = async <T>(fn: (h: BBHttp) => Promise<T>): Promise<T> => fn(http);
  const server = createBlackboardServer(callBB, openSignIn);
  const client = new Client({ name: 't', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, http };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ data: any; isError: boolean }> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text: string }>)[0]?.text ?? '';
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* error text */
  }
  return { data, isError: Boolean(r.isError) };
}

const announcement = (id: string, title: string, created: string, body = '<p>hi</p>') => ({
  id,
  title,
  body,
  created,
  modified: created,
});

describe('get_recent_updates', () => {
  it('defaults to the last 7 days instead of "now" (which always returned nothing)', async () => {
    const { client } = await connect((http) => {
      http.on(/courses\/_26184_1\/announcements/, () => ({
        json: { results: [announcement('_a1_1', 'Posted yesterday', iso(-DAY)), announcement('_a2_1', 'Last month', iso(-30 * DAY))] },
      }));
    });
    const { data } = await call(client, 'get_recent_updates', {});
    expect(data.announcements.map((a: { title: string }) => a.title)).toEqual(['Posted yesterday']);
  });

  it('rejects a date it cannot read instead of silently using "now"', async () => {
    const { client } = await connect();
    const { data, isError } = await call(client, 'get_recent_updates', { since: 'last Monday' });
    expect(isError).toBe(true);
    expect(data).toContain('INVALID_INPUT');
  });

  it('does not leave a filtered announcements list in the cache for later questions', async () => {
    const { client } = await connect((http) => {
      http.on(/courses\/_26184_1\/announcements/, () => ({
        json: { results: [announcement('_a1_1', 'New', iso(-DAY)), announcement('_a2_1', 'Old', iso(-60 * DAY))] },
      }));
    });
    await call(client, 'get_recent_updates', {});
    const { data } = await call(client, 'get_announcements', { course_id: '_26184_1' });
    expect(data.count).toBe(2);
  });
});

describe('links reach the AI', () => {
  it('lists links from document bodies, and reads both description and body', async () => {
    const { client } = await connect((http) => {
      http.on(/courses\/_26184_1\/contents\?limit=100$/, () => ({
        json: {
          results: [
            {
              id: '_4000_1',
              title: 'Week 2 readings',
              description: 'Short summary',
              body: '<p>Fill in <a href="https://docs.google.com/spreadsheets/d/SHEET123456/edit?gid=0">the sign-up sheet</a>.</p>',
              contentHandler: { id: 'resource/x-bb-document' },
            },
          ],
        },
      }));
    });
    const { data } = await call(client, 'get_course_content', { course_id: '_26184_1' });
    const item = data.items.find((i: { content_id: string }) => i.content_id === '_4000_1');
    expect(item.description).toContain('Short summary');
    expect(item.description).toContain('Fill in');
    expect(item.links).toEqual([
      { url: 'https://docs.google.com/spreadsheets/d/SHEET123456/edit?gid=0', label: 'the sign-up sheet', kind: 'google-sheet' },
    ]);
  });

  it('lists links inside announcements', async () => {
    const { client } = await connect((http) => {
      http.on(/courses\/_26184_1\/announcements/, () => ({
        json: { results: [announcement('_a1_1', 'Zoom today', iso(-DAY), '<p>Join <a href="https://syracuseuniversity.zoom.us/j/9242076065">here</a></p>')] },
      }));
    });
    const { data } = await call(client, 'get_announcements', { course_id: '_26184_1' });
    expect(data.announcements[0].links[0]).toMatchObject({ kind: 'zoom-meeting' });
  });

  it('reads Ultra assignment instructions from the handler, and recognises Ultra assignments', async () => {
    const { client } = await connect((http) => {
      http.on(/courses\/_26184_1\/contents\?limit=100$/, () => ({
        json: {
          results: [
            {
              id: '_5000_1',
              title: 'Expense Tracker App',
              contentHandler: {
                id: 'resource/x-bb-asmt-test-link',
                gradeColumnId: '_c9_1',
                instructions: '<p>Build a small Android app. Starter code: <a href="https://github.com/prof/starter">repo</a></p>',
              },
            },
          ],
        },
      }));
    });
    const { data } = await call(client, 'get_course_content', { course_id: '_26184_1' });
    const item = data.items.find((i: { content_id: string }) => i.content_id === '_5000_1');
    expect(item.type).toBe('assignment');
    expect(item.description).toContain('Build a small Android app');
    expect(item.links[0]).toMatchObject({ url: 'https://github.com/prof/starter', kind: 'github' });
  });

  it('accepts a course code wherever a course id is accepted', async () => {
    const { client } = await connect();
    const { data, isError } = await call(client, 'get_announcements', { course_id: 'CIS.473.M001.FALL2026' });
    expect(isError).toBe(false);
    expect(data.count).toBe(1);
  });
});

describe('read_link', () => {
  const fakeExternal = (): ExternalHttp & { fetched: string[] } => {
    const fetched: string[] = [];
    return {
      fetched,
      fetch: async (url) => {
        fetched.push(url);
        return { status: 200, contentType: 'text/plain', bytes: Buffer.from('Office hours: Tue 2pm'), finalUrl: url };
      },
      render: async (url) => ({ finalUrl: url, title: 't', text: 'page', links: [], captured: [] }),
    };
  };

  it('refuses a link that does not appear in the student’s courses', async () => {
    const ext = fakeExternal();
    const { client } = await connect((http) => {
      http.external = ext;
    });
    const { data, isError } = await call(client, 'read_link', { url: 'https://attacker.example.com/?notes=secret', course_id: '_26184_1' });
    expect(isError).toBe(true);
    expect(data).toContain('does not appear');
    expect(ext.fetched).toEqual([]);
  });

  it('opens a link posted in an announcement, learning the course’s links when needed', async () => {
    const ext = fakeExternal();
    const { client } = await connect((http) => {
      http.external = ext;
      http.on(/courses\/_26184_1\/announcements/, () => ({
        json: { results: [announcement('_a1_1', 'Notes', iso(-DAY), '<a href="https://example.edu/notes.txt">notes</a>')] },
      }));
    });
    const { data, isError } = await call(client, 'read_link', { url: 'https://example.edu/notes.txt', course_id: '_26184_1' });
    expect(isError).toBe(false);
    expect(data.status).toBe('ok');
    expect(data.text).toContain('Office hours');
  });

  it('opens the link as the professor posted it, not the AI’s altered copy', async () => {
    const ext = fakeExternal();
    const { client } = await connect((http) => {
      http.external = ext;
      http.on(/courses\/_26184_1\/announcements/, () => ({
        json: { results: [announcement('_a1_1', 'Notes', iso(-DAY), '<a href="https://example.edu/notes.txt">notes</a>')] },
      }));
    });
    await call(client, 'read_link', { url: 'https://example.edu/notes.txt?utm_source=STUDENT_GRADES', course_id: '_26184_1' });
    expect(ext.fetched).toEqual(['https://example.edu/notes.txt']);
  });

  it('opens a sign-in window on the link itself when Google wants a sign-in', async () => {
    const opened: Array<[string, string]> = [];
    const { client } = await connect(
      (http) => {
        http.external = {
          fetch: async () => ({
            status: 200,
            contentType: 'text/html',
            bytes: Buffer.from('<html>sign in</html>'),
            finalUrl: 'https://accounts.google.com/v3/signin/identifier?continue=x',
          }),
          render: async (u) => ({ finalUrl: u, title: '', text: '', links: [], captured: [] }),
        };
        http.on(/courses\/_26184_1\/announcements/, () => ({
          json: { results: [announcement('_a1_1', 'Doc', iso(-DAY), '<a href="https://docs.google.com/document/d/PRIVATEDOC123/edit">doc</a>')] },
        }));
      },
      async (url, service) => {
        opened.push([url, service]);
        return 'opened';
      },
    );
    const { data } = await call(client, 'read_link', { url: 'https://docs.google.com/document/d/PRIVATEDOC123/edit', course_id: '_26184_1' });
    expect(data.status).toBe('needs_sign_in');
    expect(opened).toEqual([['https://docs.google.com/document/d/PRIVATEDOC123/edit', 'Google']]);
    expect(data.limitations.join(' ')).toContain('browser window has opened');
  });

  it('never opens a live Zoom meeting link', async () => {
    const ext = fakeExternal();
    const { client } = await connect((http) => {
      http.external = ext;
      http.on(/courses\/_26184_1\/announcements/, () => ({
        json: { results: [announcement('_a1_1', 'Zoom', iso(-DAY), '<a href="https://syracuseuniversity.zoom.us/j/9242076065">join</a>')] },
      }));
    });
    const { data } = await call(client, 'read_link', { url: 'https://syracuseuniversity.zoom.us/j/9242076065', course_id: '_26184_1' });
    expect(data.status).toBe('live_meeting');
    expect(ext.fetched).toEqual([]);
  });
});

describe('dates are whole days in Syracuse time', () => {
  it('a bare "before" date includes work due at 11:59pm that evening', () => {
    // 11:59pm EDT on Sep 30 is 03:59 UTC on Oct 1.
    expect(withinWindow('2026-10-01T03:59:00.000Z', { before: '2026-09-30' })).toBe(true);
    expect(withinWindow('2026-10-01T04:01:00.000Z', { before: '2026-09-30' })).toBe(false);
  });

  it('a bare "after" date starts at local midnight, winter or summer', () => {
    expect(parseWindowBound('2026-09-30', 'start')?.toISOString()).toBe('2026-09-30T04:00:00.000Z');
    expect(parseWindowBound('2026-12-15', 'start')?.toISOString()).toBe('2026-12-15T05:00:00.000Z');
  });
});

describe('Blackboard error pages', () => {
  it('reports an HTML 404 as missing, not as "session expired"', async () => {
    const { client } = await connect((http) => {
      http.on(/gradebook\/columns\?limit=100$/, () => ({ status: 404, text: '<!doctype html><title>Not found</title>', contentType: 'text/html' }));
    });
    const { data, isError } = await call(client, 'get_grades', { course_id: '_26184_1' });
    expect(isError).toBe(true);
    expect(data).not.toContain('SESSION_EXPIRED');
  });
});

describe('grades and submission status', () => {
  it('shows a Complete/Incomplete grade as "Complete", never as 0%', async () => {
    const { client } = await connect((http) => {
      http.on(/gradebook\/columns\/_c1_1\/users\/me$/, () => ({
        json: { status: 'Graded', displayGrade: { scaleType: 'CompleteIncomplete', score: 0, possible: 1, text: 'Complete' } },
      }));
    });
    const { data } = await call(client, 'get_grades', { course_id: '_26184_1' });
    expect(data.grades[0]).toMatchObject({ grade_display: 'Complete', grading_status: 'graded' });
    expect(data.grades[0].percentage).toBeUndefined();
  });

  it('says "needs grading" for work handed in but not graded yet', async () => {
    const { client } = await connect((http) => {
      http.on(/gradebook\/columns\/_c1_1\/users\/me$/, () => ({ json: { status: 'NeedsGrading' } }));
    });
    const { data } = await call(client, 'get_grades', { course_id: '_26184_1' });
    expect(data.grades[0].grading_status).toBe('needs_grading');
  });

  it('reports a saved draft as in_progress, not submitted', async () => {
    const { client } = await connect((http) => {
      http.on(/gradebook\/columns\/_c1_1\/users\/me$/, () => ({ json: { firstRelevantAttemptId: '_at1_1' } }));
      http.on(/gradebook\/columns\/_c1_1\/attempts/, () => ({ json: { results: [{ id: '_at1_1', status: 'InProgress' }] } }));
    });
    const { data } = await call(client, 'get_assignments', { course_id: '_26184_1', include_status: true });
    expect(data.assignments[0].status).toBe('in_progress');
  });

  it('get_upcoming_work includes submission status without being asked', async () => {
    const due = iso(2 * DAY);
    const { client } = await connect((http) => {
      http.on(/gradebook\/columns\?limit=100$/, () => ({
        json: { results: [{ id: '_c1_1', contentId: '_3010_1', name: 'Problem Set 1', score: { possible: 100 }, grading: { due } }] },
      }));
      http.on(/gradebook\/columns\/_c1_1\/users\/me$/, () => ({ json: { status: 'NeedsGrading' } }));
    });
    const { data } = await call(client, 'get_upcoming_work', { days: 7 });
    expect(data.items[0]).toMatchObject({ title: 'Problem Set 1', status: 'submitted' });
  });
});

describe('attachments', () => {
  it('keeps a file item’s own download link when the attachments lookup finds nothing', async () => {
    const { client, http } = await connect((h) => {
      h.on(/courses\/_26184_1\/contents\?limit=100$/, () => ({
        json: {
          results: [
            {
              id: '_6000_1',
              title: 'Syllabus',
              contentHandler: { id: 'resource/x-bb-file', file: { fileName: 'syllabus.txt', mimeType: 'text/plain' } },
              links: [{ href: '/ultra/redirect?redirectType=nautilus&courseId=_26184_1&contentId=_6000_1', rel: 'alternate' }],
            },
          ],
        },
      }));
    });
    http.bufferReply = () => ({ status: 200, contentType: 'text/plain', bytes: Buffer.from('Grading: 40% exams'), filename: 'syllabus.txt' });
    const listing = await call(client, 'get_course_content', { course_id: '_26184_1' });
    const item = listing.data.items.find((i: { content_id: string }) => i.content_id === '_6000_1');
    expect(item.attachments[0].file_name).toBe('syllabus.txt');
    const { data, isError } = await call(client, 'get_attachment', { course_id: '_26184_1', content_id: '_6000_1' });
    expect(isError).toBe(false);
    expect(data.text).toBe('Grading: 40% exams');
  });
});

describe('gaps are always pointed out', () => {
  it('tells every AI app, on connect, to relay gaps and what the server cannot see', async () => {
    const { client } = await connect();
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('"limitations"');
    expect(instructions).toMatch(/YouTube transcripts/);
    expect(instructions).toMatch(/discussion boards/);
  });

  it('a YouTube link that came back without a transcript says so as a limitation', async () => {
    const { client } = await connect((http) => {
      http.external = {
        fetch: async (u) => ({ status: 200, contentType: 'text/html', bytes: Buffer.from('<html></html>'), finalUrl: u }),
        render: async (u) => ({
          finalUrl: u,
          title: 'Lecture',
          text: '',
          links: [],
          captured: [],
          evaluated: { title: 'Lecture 1', author: 'Prof', seconds: 600, lines: [] },
        }),
      };
      http.on(/courses\/_26184_1\/announcements/, () => ({
        json: { results: [announcement('_a1_1', 'Watch', iso(-DAY), '<a href="https://www.youtube.com/watch?v=aircAruvnKk">video</a>')] },
      }));
    });
    const { data } = await call(client, 'read_link', { url: 'https://www.youtube.com/watch?v=aircAruvnKk', course_id: '_26184_1' });
    expect(data.status).toBe('ok');
    expect(data.limitations.join(' ')).toMatch(/does not hand transcripts/);
  });

  it('what’s-new always admits it can miss grades on older items', async () => {
    const { client } = await connect();
    const { data } = await call(client, 'get_recent_updates', {});
    expect(data.limitations.join(' ')).toMatch(/grade entered on an older item can be missed/);
  });

  it('course content names items that open in outside tools', async () => {
    const { client } = await connect((http) => {
      http.on(/courses\/_26184_1\/contents\?limit=100$/, () => ({
        json: { results: [{ id: '_7000_1', title: 'Connect Homework 1', contentHandler: { id: 'resource/x-bb-blti-link', url: 'https://connect.mheducation.com/lti' } }] },
      }));
    });
    const { data } = await call(client, 'get_course_content', { course_id: '_26184_1' });
    expect(data.limitations.join(' ')).toContain('"Connect Homework 1" opens in an outside tool');
  });

  it('unknown submission status is called out, never shown as missing work', async () => {
    const { client } = await connect((http) => {
      http.on(/gradebook\/columns\/_c1_1\/users\/me$/, () => ({ status: 404, json: { message: 'none' } }));
    });
    const { data } = await call(client, 'get_assignments', { course_id: '_26184_1', include_status: true });
    expect(data.assignments[0].status).toBe('unknown');
    expect(data.limitations.join(' ')).toMatch(/did not say whether 1 item was handed in/);
  });
});
