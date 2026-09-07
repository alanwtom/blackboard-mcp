import { beforeEach, describe, expect, it } from 'vitest';
import { getAssignments } from '../src/blackboard/assignments.js';
import { globalCache } from '../src/blackboard/cache.js';
import { FakeHttp, installDefaultRoutes, type FakeReply } from './helpers/fake-http.js';

const CELL = /\/learn\/api\/public\/v2\/courses\/_26184_1\/gradebook\/columns\/_c1_1\/users\/me$/;
const ATTEMPTS = /\/learn\/api\/public\/v2\/courses\/_26184_1\/gradebook\/columns\/_c1_1\/attempts/;

/**
 * Routes registered first win in FakeHttp, so these override the defaults.
 * `attempts` is optional: omitting it leaves the endpoint 404ing, which is the
 * "Blackboard won't tell us" case.
 */
function build(cell: FakeReply, attempts?: FakeReply): FakeHttp {
  const http = new FakeHttp();
  http.on(CELL, () => cell);
  if (attempts) http.on(ATTEMPTS, () => attempts);
  installDefaultRoutes(http);
  return http;
}

async function statusOf(http: FakeHttp): Promise<string | undefined> {
  const assignments = await getAssignments(http, { courseId: '_26184_1', includeStatus: true });
  return assignments.find((a) => a.title === 'Problem Set 1')?.status;
}

describe('submission status', () => {
  beforeEach(() => globalCache.clear());

  it('reports a graded item as graded', async () => {
    const http = build({ json: { userId: '_777_1', columnId: '_c1_1', score: { score: 88 } } });
    expect(await statusOf(http)).toBe('graded');
  });

  // The regression this suite exists for: submitted-but-ungraded work used to
  // come back as 'not_submitted', telling students they had missed a deadline
  // they had actually met.
  it('reports submitted-but-ungraded work as submitted, not missing', async () => {
    const http = build({
      json: { userId: '_777_1', columnId: '_c1_1', status: 'NeedsGrading', score: null },
    });
    expect(await statusOf(http)).toBe('submitted');
  });

  it('accepts the underscored status spelling some deployments use', async () => {
    const http = build({ json: { userId: '_777_1', columnId: '_c1_1', status: 'NEEDS_GRADING' } });
    expect(await statusOf(http)).toBe('submitted');
  });

  it('treats a linked attempt id as a submission even with no status', async () => {
    const http = build({
      json: { userId: '_777_1', columnId: '_c1_1', firstRelevantAttemptId: '_a99_1' },
    });
    expect(await statusOf(http)).toBe('submitted');
  });

  it('falls back to the attempts endpoint when the grade cell is silent', async () => {
    const http = build(
      { json: { userId: '_777_1', columnId: '_c1_1' } },
      { json: { results: [{ id: '_a99_1', status: 'NeedsGrading' }] } },
    );
    expect(await statusOf(http)).toBe('submitted');
  });

  it('only says not_submitted when the attempts endpoint confirms none exist', async () => {
    const http = build({ json: { userId: '_777_1', columnId: '_c1_1' } }, { json: { results: [] } });
    expect(await statusOf(http)).toBe('not_submitted');
  });

  // Guessing 'not_submitted' here is the dangerous failure: it accuses the
  // student of missing work on no evidence at all.
  it('says unknown, never not_submitted, when Blackboard will not say', async () => {
    const http = build({ json: { userId: '_777_1', columnId: '_c1_1' } });
    expect(await statusOf(http)).toBe('unknown');
  });

  it('says unknown when the attempts endpoint is forbidden', async () => {
    const http = build({ json: { userId: '_777_1', columnId: '_c1_1' } }, { status: 403, json: {} });
    expect(await statusOf(http)).toBe('unknown');
  });

  // Response bodies below were captured from live Blackboard Ultra
  // (blackboard.syr.edu, Sept 2026) rather than written from the docs — the
  // live shape is what the documented one missed.
  describe('live Ultra response shapes', () => {
    it('reads a graded quiz whose score only appears under displayGrade', async () => {
      const http = build({
        json: {
          userId: '_21025281_1',
          columnId: '_3604061_1',
          status: 'Graded',
          displayGrade: { scaleType: 'Score', score: 4, possible: 5 },
          exempt: false,
          changeIndex: 626166009,
        },
      });
      expect(await statusOf(http)).toBe('graded');
    });

    it('reads submitted-but-ungraded homework as submitted', async () => {
      const http = build({
        json: {
          userId: '_21025281_1',
          columnId: '_3601918_1',
          status: 'NeedsGrading',
          exempt: false,
          changeIndex: 626694362,
        },
      });
      expect(await statusOf(http)).toBe('submitted');
    });

    it('reads a never-opened assignment as not submitted', async () => {
      const http = build(
        { json: { userId: '_21025281_1', columnId: '_3609677_1' } },
        { json: { results: [] } },
      );
      expect(await statusOf(http)).toBe('not_submitted');
    });
  });

  it('does not query attempts once the grade cell already proves a submission', async () => {
    const http = build({ json: { userId: '_777_1', columnId: '_c1_1', status: 'NeedsGrading' } });
    await statusOf(http);
    expect(http.requests.some((r) => ATTEMPTS.test(r))).toBe(false);
  });
});
