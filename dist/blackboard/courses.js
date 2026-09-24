import { globalCache, TTL } from './cache.js';
import { BlackboardError } from './errors.js';
import { getPaged, getJson } from './transport.js';
import { asRecord, getField, strField, toIso } from './util.js';
const API = '/learn/api/public/v1';
/**
 * Resolve the signed-in user. The `/users/me` alias exists on current Learn
 * deployments; when it does not, we degrade gracefully (courses are still
 * obtainable from the permission-filtered /courses listing).
 */
export async function getIdentity(http) {
    return globalCache.wrap('identity', TTL.identity, async () => {
        const me = await getJson(http, `${API}/users/me`, { allowNotFound: true });
        if (me && typeof me.id === 'string') {
            const given = typeof me.givenName === 'string' ? me.givenName : '';
            const family = typeof me.familyName === 'string' ? me.familyName : '';
            return {
                userId: me.id,
                userName: typeof me.userName === 'string' ? me.userName : undefined,
                displayName: [given, family].filter(Boolean).join(' ') || undefined,
            };
        }
        const courses = await getJson(http, `${API}/courses?limit=1`, {
            allowNotFound: true,
        });
        if (courses && Array.isArray(courses.results))
            return { userId: 'unknown' };
        return null;
    });
}
/** Normalize a v1 course object, optionally joined with the student's enrollment. */
export function normalizeCourse(raw, enrollment) {
    const rec = asRecord(raw) ?? {};
    const id = strField(rec, 'id');
    const name = strField(rec, 'name');
    if (!id || !name) {
        throw new BlackboardError('BLACKBOARD_REQUEST_FAILED', 'Malformed course object received from Blackboard.');
    }
    const availability = strField(rec, 'availability.available') ?? 'No';
    const enrollmentAvailable = enrollment ? (strField(enrollment, 'availability.available') ?? 'No') : 'Yes';
    const course = {
        id,
        name,
        courseCode: strField(rec, 'courseId'),
        available: availability === 'Yes' && enrollmentAvailable === 'Yes',
        startDate: toIso(rec.startDate),
        endDate: toIso(rec.endDate),
    };
    const role = enrollment ? strField(enrollment, 'courseRoleId') : undefined;
    if (role)
        course.role = role;
    const lastAccessed = toIso(getField(enrollment, 'lastAccessed'));
    if (lastAccessed)
        course.lastAccessed = lastAccessed;
    const organization = rec.organization === true;
    course.url = organization
        ? `https://blackboard.syr.edu/ultra/organizations/${id}/outline`
        : `https://blackboard.syr.edu/ultra/courses/${id}/outline`;
    return course;
}
/**
 * The student's currently visible courses. Primary path: the user-courses
 * endpoint with `expand=course`, which returns enrollment + course in one
 * call (verified against Syracuse's deployment). Falls back to joining with
 * the bulk course listing when a deployment lacks the expansion.
 */
export async function listCourses(http, opts = {}) {
    const cacheKey = opts.includeUnavailable ? 'courses:all' : 'courses:available';
    return globalCache.wrap(cacheKey, TTL.courses, async () => {
        const identity = await getIdentity(http);
        let courses = [];
        if (identity && identity.userId !== 'unknown') {
            const enrollments = await getPaged(http, `${API}/users/${encodeURIComponent(identity.userId)}/courses?expand=course&limit=100`);
            const expanded = enrollments.filter((e) => asRecord(getField(e, 'course')) !== null);
            if (expanded.length > 0) {
                courses = expanded
                    .map((e) => {
                    try {
                        return normalizeCourse(getField(e, 'course'), e);
                    }
                    catch {
                        return null;
                    }
                })
                    .filter((c) => c !== null);
            }
            else {
                // Expansion unsupported: join enrollments with the bulk course listing.
                const byId = new Map();
                const listed = await getPaged(http, `${API}/courses?limit=100`).catch(() => []);
                for (const c of listed) {
                    const id = strField(c, 'id');
                    if (id)
                        byId.set(id, c);
                }
                courses = enrollments
                    .map((e) => {
                    const courseId = strField(e, 'courseId');
                    const raw = courseId ? byId.get(courseId) : undefined;
                    return raw ? normalizeCourse(raw, e) : null;
                })
                    .filter((c) => c !== null);
            }
        }
        else {
            // No resolvable identity: rely on Blackboard's own permission filtering.
            const listed = await getPaged(http, `${API}/courses?limit=100`);
            courses = listed.map((c) => normalizeCourse(c));
        }
        const seen = new Set();
        const unique = courses.filter((c) => {
            if (seen.has(c.id))
                return false;
            seen.add(c.id);
            return true;
        });
        unique.sort((a, b) => a.name.localeCompare(b.name));
        return opts.includeUnavailable ? unique : unique.filter((c) => c.available);
    });
}
/**
 * Blackboard reports past-term courses as `available` and only refuses when
 * their contents are actually requested — and it publishes no end date to
 * distinguish them, so the enrolment listing cannot tell them apart. Once a
 * course has definitively refused, remember that for a while: a student with
 * years of enrolments would otherwise re-ask every locked course on every
 * question. Only an explicit PERMISSION_DENIED counts, so a transient failure
 * never hides a live course, and the short TTL lets access come back.
 */
const DENIED_TTL = 15 * 60_000;
export function noteCourseDenied(courseId) {
    globalCache.set(`denied:${courseId}`, true, DENIED_TTL);
}
export function isCourseDenied(courseId) {
    return globalCache.get(`denied:${courseId}`) === true;
}
/**
 * Courses worth querying: the visible ones, minus any that recently refused.
 * Multi-course tools should start here rather than from `listCourses`.
 */
export async function readableCourses(http, opts = {}) {
    const courses = await listCourses(http, opts);
    return courses.filter((c) => !isCourseDenied(c.id));
}
/** Resolve a course by Blackboard id or course code; throws COURSE_NOT_FOUND. */
export async function findCourse(http, courseIdOrCode) {
    const key = courseIdOrCode.trim();
    if (!key)
        throw new BlackboardError('COURSE_NOT_FOUND', 'No course id provided.');
    const courses = await listCourses(http, { includeUnavailable: true });
    const lower = key.toLowerCase();
    const match = courses.find((c) => c.id.toLowerCase() === lower || (c.courseCode ?? '').toLowerCase() === lower);
    if (!match) {
        throw new BlackboardError('COURSE_NOT_FOUND', `Course "${courseIdOrCode}" was not found among your accessible courses. Use list_courses to see valid ids.`);
    }
    return match;
}
