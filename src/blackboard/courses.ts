import { globalCache, TTL } from './cache.js';
import { BlackboardError } from './errors.js';
import { getPaged, getJson } from './transport.js';
import type { BBHttp } from './session.js';
import type { BBIdentity, Course } from './types.js';
import { asRecord, getField, strField, toIso } from './util.js';

const API = '/learn/api/public/v1';

/**
 * Resolve the signed-in user. The `/users/me` alias exists on current Learn
 * deployments; when it does not, we degrade gracefully (courses are still
 * obtainable from the permission-filtered /courses listing).
 */
export async function getIdentity(http: BBHttp): Promise<BBIdentity | null> {
  return globalCache.wrap('identity', TTL.identity, async () => {
    const me = await getJson<Record<string, unknown>>(http, `${API}/users/me`, { allowNotFound: true });
    if (me && typeof me.id === 'string') {
      const given = typeof me.givenName === 'string' ? me.givenName : '';
      const family = typeof me.familyName === 'string' ? me.familyName : '';
      return {
        userId: me.id,
        userName: typeof me.userName === 'string' ? me.userName : undefined,
        displayName: [given, family].filter(Boolean).join(' ') || undefined,
      };
    }
    const courses = await getJson<Record<string, unknown>>(http, `${API}/courses?limit=1`, {
      allowNotFound: true,
    });
    if (courses && Array.isArray(courses.results)) return { userId: 'unknown' };
    return null;
  });
}

/** Normalize a v1 course object, optionally joined with the student's enrollment. */
export function normalizeCourse(raw: unknown, enrollment?: unknown): Course {
  const rec = asRecord(raw) ?? {};
  const id = strField(rec, 'id');
  const name = strField(rec, 'name');
  if (!id || !name) {
    throw new BlackboardError('BLACKBOARD_REQUEST_FAILED', 'Malformed course object received from Blackboard.');
  }
  const availability = strField(rec, 'availability.available') ?? 'No';
  const enrollmentAvailable = enrollment ? (strField(enrollment, 'availability.available') ?? 'No') : 'Yes';
  const course: Course = {
    id,
    name,
    courseCode: strField(rec, 'courseId'),
    available: availability === 'Yes' && enrollmentAvailable === 'Yes',
    startDate: toIso(rec.startDate),
    endDate: toIso(rec.endDate),
  };
  const role = enrollment ? strField(enrollment, 'courseRoleId') : undefined;
  if (role) course.role = role;
  const lastAccessed = toIso(getField(enrollment, 'lastAccessed'));
  if (lastAccessed) course.lastAccessed = lastAccessed;
  const organization = rec.organization === true;
  course.url = organization
    ? `https://blackboard.syr.edu/ultra/organizations/${id}/outline`
    : `https://blackboard.syr.edu/ultra/courses/${id}/outline`;
  return course;
}

export interface ListCoursesOptions {
  includeUnavailable?: boolean;
}

/**
 * The student's currently visible courses. Primary path: the user-courses
 * endpoint with `expand=course`, which returns enrollment + course in one
 * call (verified against Syracuse's deployment). Falls back to joining with
 * the bulk course listing when a deployment lacks the expansion.
 */
export async function listCourses(http: BBHttp, opts: ListCoursesOptions = {}): Promise<Course[]> {
  const cacheKey = opts.includeUnavailable ? 'courses:all' : 'courses:available';
  return globalCache.wrap(cacheKey, TTL.courses, async () => {
    const identity = await getIdentity(http);

    let courses: Course[] = [];
    if (identity && identity.userId !== 'unknown') {
      const enrollments = await getPaged<unknown>(
        http,
        `${API}/users/${encodeURIComponent(identity.userId)}/courses?expand=course&limit=100`,
      );
      const expanded = enrollments.filter((e) => asRecord(getField(e, 'course')) !== null);
      if (expanded.length > 0) {
        courses = expanded
          .map((e) => {
            try {
              return normalizeCourse(getField(e, 'course'), e);
            } catch {
              return null;
            }
          })
          .filter((c): c is Course => c !== null);
      } else {
        // Expansion unsupported: join enrollments with the bulk course listing.
        const byId = new Map<string, unknown>();
        const listed = await getPaged<unknown>(http, `${API}/courses?limit=100`).catch(() => []);
        for (const c of listed) {
          const id = strField(c, 'id');
          if (id) byId.set(id, c);
        }
        courses = enrollments
          .map((e) => {
            const courseId = strField(e, 'courseId');
            const raw = courseId ? byId.get(courseId) : undefined;
            return raw ? normalizeCourse(raw, e) : null;
          })
          .filter((c): c is Course => c !== null);
      }
    } else {
      // No resolvable identity: rely on Blackboard's own permission filtering.
      const listed = await getPaged<unknown>(http, `${API}/courses?limit=100`);
      courses = listed.map((c) => normalizeCourse(c));
    }

    const seen = new Set<string>();
    const unique = courses.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
    unique.sort((a, b) => a.name.localeCompare(b.name));
    return opts.includeUnavailable ? unique : unique.filter((c) => c.available);
  });
}

/** Resolve a course by Blackboard id or course code; throws COURSE_NOT_FOUND. */
export async function findCourse(http: BBHttp, courseIdOrCode: string): Promise<Course> {
  const key = courseIdOrCode.trim();
  if (!key) throw new BlackboardError('COURSE_NOT_FOUND', 'No course id provided.');
  const courses = await listCourses(http, { includeUnavailable: true });
  const lower = key.toLowerCase();
  const match = courses.find((c) => c.id.toLowerCase() === lower || (c.courseCode ?? '').toLowerCase() === lower);
  if (!match) {
    throw new BlackboardError(
      'COURSE_NOT_FOUND',
      `Course "${courseIdOrCode}" was not found among your accessible courses. Use list_courses to see valid ids.`,
    );
  }
  return match;
}
