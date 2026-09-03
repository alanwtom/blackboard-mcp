import type { BBBufferResponse, BBHttp, BBJsonResponse, BBRequestInit } from '../../src/blackboard/session.js';

export interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
  contentType?: string;
}

type ReplyFn = (path: string) => FakeReply | Promise<FakeReply>;

interface Route {
  pattern: RegExp;
  reply: ReplyFn;
}

/**
 * In-memory stand-in for the authenticated Blackboard transport. Domain
 * functions run unmodified against it, so tests cover real request paths,
 * pagination, and error classification without a browser.
 */
export class FakeHttp implements BBHttp {
  private routes: Route[] = [];
  public requests: string[] = [];

  on(pattern: RegExp, reply: ReplyFn): this {
    this.routes.push({ pattern, reply });
    return this;
  }

  async fetchJson(path: string, _init?: BBRequestInit): Promise<BBJsonResponse> {
    this.requests.push(`GET ${path}`);
    const route = this.routes.find((r) => r.pattern.test(path));
    if (!route) {
      return {
        status: 404,
        contentType: 'application/json',
        text: JSON.stringify({ status: 404, message: `no fake route for ${path}` }),
        url: '',
      };
    }
    const reply = await route.reply(path);
    const text = reply.json !== undefined ? JSON.stringify(reply.json) : (reply.text ?? '');
    return {
      status: reply.status ?? 200,
      contentType: reply.contentType ?? (reply.json !== undefined ? 'application/json' : 'text/html'),
      text,
      url: '',
    };
  }

  /** Overrides the bytes both fetch paths return, for size/failure cases. */
  public bufferReply: (pathOrUrl: string) => BBBufferResponse = () => ({
    status: 200,
    contentType: 'application/pdf',
    bytes: Buffer.from('%PDF-1.4 fake'),
    filename: 'downloaded.pdf',
  });

  async fetchBuffer(pathOrUrl: string): Promise<BBBufferResponse> {
    this.requests.push(`BUFFER ${pathOrUrl}`);
    return this.bufferReply(pathOrUrl);
  }

  toSameOriginPath(href: string): string {
    const u = new URL(href, 'https://blackboard.syr.edu');
    return `${u.pathname}${u.search}`;
  }

  async captureRedirectDownload(pathOrUrl: string): Promise<BBBufferResponse> {
    this.requests.push(`CAPTURE ${pathOrUrl}`);
    return this.bufferReply(pathOrUrl);
  }
}

// ---------------------------------------------------------------------------
// Fixtures mirroring Learn v1/v2 response shapes.
// ---------------------------------------------------------------------------

export const USER_ME = {
  id: '_777_1',
  uuid: 'abc-def',
  userName: 'astudent',
  givenName: 'Al',
  familyName: 'Student',
  availability: { available: 'Yes' },
};

export const COURSES = {
  results: [
    {
      id: '_26184_1',
      courseId: 'CIS.473.M001.FALL2026',
      name: 'CIS 473 - Introduction to Artificial Intelligence',
      availability: { available: 'Yes', allowGuests: false },
      created: '2026-08-01T10:00:00.000Z',
      modified: '2026-08-20T10:00:00.000Z',
      startDate: '2026-08-24T04:00:00.000Z',
      endDate: '2026-12-11T05:00:00.000Z',
      organization: false,
    },
    {
      id: '_26185_1',
      courseId: 'PHI.378.M001.FALL2026',
      name: 'PHI 378 - Philosophy of AI',
      availability: { available: 'No', allowGuests: false },
      created: '2026-08-01T10:00:00.000Z',
      organization: false,
    },
  ],
};

export const ENROLLMENTS = {
  results: [
    {
      id: '_9001_1',
      userId: '_777_1',
      courseId: '_26184_1',
      courseRoleId: 'Student',
      availability: { available: 'Yes' },
      created: '2026-08-10T12:00:00.000Z',
      course: COURSES.results[0],
    },
    {
      id: '_9002_1',
      userId: '_777_1',
      courseId: '_26185_1',
      courseRoleId: 'Student',
      availability: { available: 'Yes' },
      created: '2026-08-10T12:00:00.000Z',
      course: COURSES.results[1],
    },
  ],
};

export const COURSE_CONTENT_ROOT = {
  results: [
    {
      id: '_3000_1',
      title: 'Week 1',
      description: '<p>First week folder</p>',
      created: '2026-08-20T10:00:00.000Z',
      modified: '2026-08-21T10:00:00.000Z',
      position: 1,
      hasChildren: true,
      contentHandler: { id: 'resource/x-bb-folder' },
      availability: { available: 'Yes' },
    },
    {
      id: '_3010_1',
      title: 'Problem Set 1',
      description: '<p>Complete all four problems. Show your work.</p>',
      created: '2026-08-20T10:00:00.000Z',
      modified: '2026-08-22T10:00:00.000Z',
      position: 2,
      hasChildren: false,
      contentHandler: { id: 'resource/x-bb-assignment' },
      availability: { available: 'Yes' },
    },
  ],
};

export const COURSE_CONTENT_CHILDREN = {
  results: [
    {
      id: '_3001_1',
      title: 'Lecture Notes',
      description:
        '<p>Slides attached.</p><a href="https://blackboard.syr.edu/bbcswebdav/xid-12345_1&amp;course_id=_26184_1">notes.pdf</a>',
      created: '2026-08-20T10:00:00.000Z',
      modified: '2026-08-21T10:00:00.000Z',
      position: 1,
      hasChildren: false,
      contentHandler: { id: 'resource/x-bb-file' },
      availability: { available: 'Yes' },
    },
  ],
};

export const GRADEBOOK_COLUMNS = {
  results: [
    {
      id: '_c1_1',
      contentId: '_3010_1',
      name: 'Problem Set 1',
      description: null,
      created: '2026-08-15T10:00:00.000Z',
      modified: '2026-08-20T10:00:00.000Z',
      score: { maximum: 100, minimum: 0 },
      due: '2026-09-05T23:59:00.000Z',
    },
  ],
};

export const CALENDAR_ITEMS = {
  results: [
    {
      id: 'evt1',
      type: 'gradebookItem',
      title: 'Problem Set 1',
      start: '2026-09-05T23:59:00.000Z',
      courseId: '_26184_1',
    },
  ],
};

export const ANNOUNCEMENTS = {
  results: [
    {
      id: '_a1_1',
      title: 'Welcome to CIS 473',
      body: { plainText: 'Hello class. Office hours are Tuesdays.' },
      created: '2026-08-25T14:00:00.000Z',
      modified: '2026-08-25T14:00:00.000Z',
      availability: { duration: { start: '2026-08-25T14:00:00.000Z' } },
    },
  ],
};

export const GRADE_CELL_PS1 = {
  userId: '_777_1',
  columnId: '_c1_1',
  score: { score: 88 },
  text: null,
  notes: null,
  feedback: '<p>Nice work on problem 3.</p>',
};

/** Wire a FakeHttp with a full consistent fixture dataset for course _26184_1. */
export function installDefaultRoutes(http: FakeHttp): void {
  http.on(/\/learn\/api\/public\/v1\/users\/me$/, () => ({ json: USER_ME }));
  http.on(/\/learn\/api\/public\/v1\/users\/_777_1\/courses/, () => ({ json: ENROLLMENTS }));
  http.on(/\/learn\/api\/public\/v1\/courses\?limit=100$/, () => ({ json: COURSES }));
  http.on(/\/learn\/api\/public\/v1\/courses\/_26184_1\/contents\?limit=100$/, () => ({ json: COURSE_CONTENT_ROOT }));
  http.on(/\/learn\/api\/public\/v1\/courses\/_26184_1\/contents\/_3000_1\/children\?limit=100$/, () => ({
    json: COURSE_CONTENT_CHILDREN,
  }));
  http.on(/\/learn\/api\/public\/v2\/courses\/_26184_1\/gradebook\/columns\?limit=100$/, () => ({
    json: GRADEBOOK_COLUMNS,
  }));
  http.on(/\/learn\/api\/public\/v2\/courses\/_26184_1\/gradebook\/columns\/_c1_1\/users\/me$/, () => ({
    json: GRADE_CELL_PS1,
  }));
  http.on(/\/learn\/api\/public\/v1\/calendars\/items/, () => ({ json: CALENDAR_ITEMS }));
  http.on(/\/learn\/api\/public\/v1\/courses\/_26184_1\/announcements/, () => ({ json: ANNOUNCEMENTS }));
  http.on(/\/learn\/api\/public\/v1\/courses\/_26184_1\/contents\/_3001_1\/files$/, () => ({
    json: {
      results: [{ id: '_f1_1', fileName: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 12345 }],
    },
  }));
}
