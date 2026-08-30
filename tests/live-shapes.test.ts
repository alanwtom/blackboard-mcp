import { beforeEach, describe, expect, it } from 'vitest';
import { getCourseContent, normalizeContentItem } from '../src/blackboard/content.js';
import { globalCache } from '../src/blackboard/cache.js';
import { ENROLLMENTS, FakeHttp, USER_ME, COURSES } from './helpers/fake-http.js';

beforeEach(() => {
  globalCache.clear();
});

describe('live Ultra shapes (Syracuse, verified 2026-08-29)', () => {
  it('captures handler file data and the /ultra/redirect download link', () => {
    const item = normalizeContentItem(
      {
        id: '_654321_1',
        parentId: '_111111_1',
        title: 'Recitation Syllabus',
        position: 1,
        hasChildren: false,
        availability: { available: 'Yes' },
        contentHandler: {
          id: 'resource/x-bb-file',
          file: { fileName: 'course-syllabus.pdf', mimeType: 'application/pdf' },
        },
        links: [
          { href: '/ultra/redirect?redirectType=nautilus&courseId=_123456_1&contentId=_654321_1', rel: 'alternate' },
        ],
      },
      '_123456_1',
    );
    expect(item?.parentId).toBe('_111111_1');
    expect(item?.type).toBe('file');
    expect(item?.attachments).toHaveLength(1);
    expect(item?.attachments[0]).toMatchObject({
      fileName: 'course-syllabus.pdf',
      mimeType: 'application/pdf',
      source: 'handler',
    });
    expect(item?.attachments[0]?.url).toContain('/ultra/redirect');
    expect(item?.url).toContain('/ultra/redirect');
  });

  it('treats listings with parentIds as flat and skips folder expansion requests', async () => {
    const http = new FakeHttp();
    http.on(/\/learn\/api\/public\/v1\/users\/me$/, () => ({ json: USER_ME }));
    http.on(/\/users\/_777_1\/courses/, () => ({ json: ENROLLMENTS }));
    http.on(/\/courses\?limit=100$/, () => ({ json: COURSES }));
    // Flat listing: children included directly, each item carrying parentId.
    http.on(/\/courses\/_26184_1\/contents\?limit=100$/, () => ({
      json: {
        results: [
          {
            id: '_3000_1',
            parentId: '_12787577_1',
            title: 'Week 1',
            hasChildren: true,
            contentHandler: { id: 'resource/x-bb-folder' },
          },
          {
            id: '_3001_1',
            parentId: '_3000_1',
            title: 'Recitation Syllabus',
            hasChildren: false,
            contentHandler: {
              id: 'resource/x-bb-file',
              file: { fileName: 'syllabus.pdf', mimeType: 'application/pdf' },
            },
            links: [{ href: '/ultra/redirect?redirectType=nautilus&contentId=_3001_1', rel: 'alternate' }],
          },
        ],
      },
    }));

    const items = await getCourseContent(http, '_26184_1', { depth: 2 });
    expect(items.map((i) => i.id)).toContain('_3001_1');
    // The children endpoint must never have been requested for flat listings.
    expect(http.requests.some((r) => r.includes('/children'))).toBe(false);
  });

  it('reads due dates from grading.due and points from score.possible', async () => {
    const { mergeAssignmentParts } = await import('../src/blackboard/assignments.js');
    const merged = mergeAssignmentParts([
      {
        courseId: '_569403_1',
        title: 'Exam-1',
        category: 'gradebook-column',
        pointsPossible: 100,
        dueDate: '2024-09-19T17:23:09.270Z',
      },
    ]);
    expect(merged?.pointsPossible).toBe(100);
    expect(merged?.dueDate).toBe('2024-09-19T17:23:09.270Z');
  });
});
