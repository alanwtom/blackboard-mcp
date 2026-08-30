import { beforeEach, describe, expect, it } from 'vitest';
import { getAssignments, mergeAssignmentParts } from '../src/blackboard/assignments.js';
import { globalCache } from '../src/blackboard/cache.js';
import {
  CALENDAR_ITEMS,
  COURSES,
  COURSE_CONTENT_CHILDREN,
  COURSE_CONTENT_ROOT,
  ENROLLMENTS,
  FakeHttp,
  GRADEBOOK_COLUMNS,
  USER_ME,
} from './helpers/fake-http.js';

beforeEach(() => {
  globalCache.clear();
});

function makeHttp(): FakeHttp {
  const http = new FakeHttp();
  // Anchors matter: /v1/users/me must not also match /v2/.../users/me.
  http.on(/\/learn\/api\/public\/v1\/users\/me$/, () => ({ json: USER_ME }));
  http.on(/\/learn\/api\/public\/v1\/users\/_777_1\/courses/, () => ({ json: ENROLLMENTS }));
  http.on(/\/learn\/api\/public\/v1\/courses\?limit=100$/, () => ({ json: COURSES }));
  http.on(/\/courses\/_26184_1\/contents\?limit=100$/, () => ({ json: COURSE_CONTENT_ROOT }));
  http.on(/\/courses\/_26184_1\/contents\/_3000_1\/children\?limit=100$/, () => ({
    json: COURSE_CONTENT_CHILDREN,
  }));
  http.on(/\/gradebook\/columns\?limit=100$/, () => ({ json: GRADEBOOK_COLUMNS }));
  http.on(/\/calendars\/items/, () => ({ json: CALENDAR_ITEMS }));
  return http;
}

describe('mergeAssignmentParts', () => {
  const courseId = '_26184_1';

  it('merges content, gradebook, and calendar views of the same assignment', () => {
    const merged = mergeAssignmentParts([
      { id: '_3010_1', courseId, title: 'Problem Set 1', category: 'assignment', descriptionText: 'Do it' },
      { id: '_3010_1', courseId, title: 'Problem Set 1', category: 'gradebook-column', pointsPossible: 100, dueDate: '2026-09-05T23:59:00.000Z' },
      { courseId, title: 'Problem Set 1', category: 'calendar-item', dueDate: '2026-09-06T00:00:00.000Z' },
    ]);
    expect(merged).toBeDefined();
    expect(merged?.id).toBe('_3010_1');
    expect(merged?.ref).toBe(`${courseId}:_3010_1`);
    expect(merged?.pointsPossible).toBe(100);
    // First available due date wins (gradebook column here).
    expect(merged?.dueDate).toBe('2026-09-05T23:59:00.000Z');
    expect(merged?.descriptionText).toBe('Do it');
  });

  it('prefers a real content id over a calendar-only entry', () => {
    const merged = mergeAssignmentParts([
      { courseId, title: 'Essay', category: 'calendar-item', dueDate: '2026-09-10' },
      { id: '_4000_1', courseId, title: 'Essay', category: 'gradebook-column' },
    ]);
    expect(merged?.id).toBe('_4000_1');
    expect(merged?.dueDate).toBe('2026-09-10');
  });

  it('returns undefined without usable data', () => {
    expect(mergeAssignmentParts([{ courseId }])).toBeUndefined();
  });
});

describe('getAssignments', () => {
  it('combines and deduplicates sources into one assignment', async () => {
    const http = makeHttp();
    const assignments = await getAssignments(http, { courseId: '_26184_1' });
    const ps1 = assignments.filter((a) => a.title === 'Problem Set 1');
    expect(ps1).toHaveLength(1);
    expect(ps1[0]).toMatchObject({
      id: '_3010_1',
      courseId: '_26184_1',
      pointsPossible: 100,
      dueDate: '2026-09-05T23:59:00.000Z',
      courseName: 'CIS 473 - Introduction to Artificial Intelligence',
    });
    expect(ps1[0].ref).toBe('_26184_1:_3010_1');
  });

  it('filters by due-date window', async () => {
    const http = makeHttp();
    const inside = await getAssignments(http, { courseId: '_26184_1', dueAfter: '2026-09-01', dueBefore: '2026-09-30' });
    expect(inside.map((a) => a.title)).toContain('Problem Set 1');

    const outside = await getAssignments(http, { courseId: '_26184_1', dueAfter: '2026-10-01' });
    expect(outside).toHaveLength(0);
  });

  it('resolves submission status when requested', async () => {
    const http = makeHttp();
    http.on(/\/gradebook\/columns\/_c1_1\/users\/me$/, () => ({
      json: { userId: '_777_1', columnId: '_c1_1', score: { score: 88 } },
    }));
    const assignments = await getAssignments(http, { courseId: '_26184_1', includeStatus: true });
    const ps1 = assignments.find((a) => a.title === 'Problem Set 1');
    expect(ps1?.status).toBe('graded');
  });

  it('reports not_submitted when there is no attempt and no score', async () => {
    const http = makeHttp();
    http.on(/\/gradebook\/columns\/_c1_1\/users\/me$/, () => ({
      json: { userId: '_777_1', columnId: '_c1_1', score: null },
    }));
    const assignments = await getAssignments(http, { courseId: '_26184_1', includeStatus: true });
    expect(assignments.find((a) => a.title === 'Problem Set 1')?.status).toBe('not_submitted');
  });

  it('tolerates columns without content links', async () => {
    const http = makeHttp();
    http.on(/\/gradebook\/columns\?limit=100$/, () => ({
      json: {
        results: [{ id: '_c2_1', name: 'Participation', score: { maximum: 10 } }],
      },
    }));
    const assignments = await getAssignments(http, { courseId: '_26184_1' });
    // No contentId and no due date → not an assignment the student must do.
    expect(assignments.find((a) => a.title === 'Participation')).toBeUndefined();
  });

  it('carries points and due dates from gradebook columns through the merge', async () => {
    const merged = mergeAssignmentParts([
      {
        courseId: '_26184_1',
        title: 'Quiz 1',
        category: 'gradebook-column',
        pointsPossible: 50,
        dueDate: '2026-09-07T00:00:00.000Z',
      },
    ]);
    expect(merged?.pointsPossible).toBe(50);
    expect(merged?.dueDate).toBe('2026-09-07T00:00:00.000Z');
    expect(merged?.category).toBe('gradebook-column');
  });
});
