import { globalCache, TTL } from './cache.js';
import { findCourse, listCourses } from './courses.js';
import { getCourseContent } from './content.js';
import { getAnnouncements } from './announcements.js';
import { getPaged, getJson } from './transport.js';
import type { BBHttp } from './session.js';
import type { Assignment, AssignmentStatus, CalendarItem, ContentItem } from './types.js';
import {
  asRecord,
  isoOrNow,
  numField,
  parseBBDate,
  sleep,
  strField,
  titlesMatch,
  toIso,
  slugify,
  withinWindow,
} from './util.js';

const API = '/learn/api/public/v1';
const API_V2 = '/learn/api/public/v2';

export interface GradebookColumn {
  id: string;
  courseId: string;
  contentId?: string;
  name: string;
  pointsPossible?: number;
  dueDate?: string;
  modified?: string;
  raw: Record<string, unknown>;
}

function normalizeColumn(raw: unknown, courseId: string): GradebookColumn | null {
  const rec = asRecord(raw) ?? {};
  const id = strField(rec, 'id');
  const name = strField(rec, 'name');
  if (!id || !name) return null;
  // Live Ultra shape: due at grading.due, points at score.possible. Keep the
  // documented alternates for other deployments.
  const due =
    toIso(strField(rec, 'grading.due')) ??
    toIso(rec.due) ??
    toIso(rec.dueDate) ??
    toIso(strField(rec, 'availability.duration.end'));
  const points = numField(rec, 'score.possible') ?? numField(rec, 'score.maximum');
  return {
    id,
    courseId,
    contentId: strField(rec, 'contentId'),
    name,
    pointsPossible: points,
    dueDate: due ?? undefined,
    modified: toIso(rec.modified),
    raw: rec,
  };
}

/** Student-visible gradebook columns for a course (cached). */
export async function getGradebookColumns(http: BBHttp, courseId: string): Promise<GradebookColumn[]> {
  return globalCache.wrap(`columns:${courseId}`, TTL.gradebookColumns, async () => {
    const raw = await getPaged<unknown>(
      http,
      `${API_V2}/courses/${encodeURIComponent(courseId)}/gradebook/columns?limit=100`,
    );
    return raw
      .map((r) => normalizeColumn(r, courseId))
      .filter((c): c is GradebookColumn => c !== null);
  });
}

/**
 * Ultra calendar items (due dates across courses). Tolerates missing/renamed
 * fields: courseId may arrive as courseId or calendarId, dates as start or
 * startDate.
 */
export async function getCalendarItems(
  http: BBHttp,
  opts: { sinceMs?: number; untilMs?: number } = {},
): Promise<CalendarItem[]> {
  const now = Date.now();
  const since = opts.sinceMs ?? now - 30 * 24 * 3600_000;
  const until = opts.untilMs ?? now + 120 * 24 * 3600_000;
  const cacheKey = `calendar:${since}:${until}`;
  return globalCache.wrap(cacheKey, TTL.calendar, async () => {
    const data = await getJson<unknown>(
      http,
      `${API}/calendars/items?since=${since}&until=${until}`,
      { allowNotFound: true },
    );
    if (!data) return [];
    const results = Array.isArray(data)
      ? data
      : Array.isArray((data as Record<string, unknown>)?.results)
        ? ((data as Record<string, unknown>).results as unknown[])
        : [];
    return results
      .map((r): CalendarItem | null => {
        const rec = asRecord(r) ?? {};
        const id = strField(rec, 'id');
        if (!id) return null;
        const courseId = strField(rec, 'courseId') ?? strField(rec, 'calendarId');
        return {
          id,
          courseId: courseId && /^_\d+_1$/.test(courseId) ? courseId : undefined,
          title: strField(rec, 'title'),
          type: strField(rec, 'type'),
          startDate: toIso(rec.start) ?? toIso(rec.startDate),
          endDate: toIso(rec.end) ?? toIso(rec.endDate),
        };
      })
      .filter((c): c is CalendarItem => c !== null);
  });
}

export function mergeAssignmentParts(parts: Partial<Assignment>[]): Assignment | undefined {
  let best: Partial<Assignment> | undefined;
  for (const part of parts) {
    if (!best) {
      best = part;
      continue;
    }
    // Prefer parts that carry a real Blackboard content id.
    const bestRank = best.id && best.id.startsWith('_') ? 2 : best.category === 'gradebook-column' ? 1 : 0;
    const partRank = part.id && part.id.startsWith('_') ? 2 : part.category === 'gradebook-column' ? 1 : 0;
    if (partRank > bestRank) best = part;
  }
  if (!best?.title || !best.courseId) return undefined;

  const merged: Assignment = {
    id: best.id ?? slugify(best.title),
    ref: best.id && best.id.startsWith('_') ? `${best.courseId}:${best.id}` : `${best.courseId}:${slugify(best.title)}`,
    courseId: best.courseId,
    title: best.title,
    category: best.category ?? 'assignment',
  };
  const pickStr = (...vals: (string | undefined)[]) => vals.find((v) => v !== undefined);
  const pickNum = (...vals: (number | undefined)[]) => vals.find((v) => v !== undefined);
  merged.courseName = pickStr(...parts.map((p) => p.courseName));
  merged.descriptionText = pickStr(...parts.map((p) => p.descriptionText));
  merged.dueDate = pickStr(...parts.map((p) => p.dueDate));
  merged.pointsPossible = pickNum(...parts.map((p) => p.pointsPossible));
  merged.status = pickStr(...parts.map((p) => p.status)) as AssignmentStatus | undefined;
  merged.url = pickStr(...parts.map((p) => p.url));
  return merged;
}

/** Attach the student's submission status for one gradebook column (1 request). */
async function statusForColumn(http: BBHttp, courseId: string, columnId: string): Promise<AssignmentStatus | undefined> {
  const data = await getJson<Record<string, unknown>>(
    http,
    `${API_V2}/courses/${encodeURIComponent(courseId)}/gradebook/columns/${encodeURIComponent(columnId)}/users/me`,
    { allowNotFound: true },
  );
  if (!data) return 'unknown';
  const score = data.score;
  if (typeof score === 'number') return 'graded';
  if (score && typeof score === 'object') {
    const s = (score as Record<string, unknown>).score;
    if (typeof s === 'number') return 'graded';
  }
  if (data.exempt === true) return 'graded';
  const attempts = data.attempts;
  if (Array.isArray(attempts) && attempts.length > 0) return 'submitted';
  return 'not_submitted';
}

export interface GetAssignmentsOptions {
  courseId?: string;
  dueAfter?: string;
  dueBefore?: string;
  /** Resolve submission status (extra per-column request; off by default). */
  includeStatus?: boolean;
}

/**
 * Assignments and assessments, combining three Blackboard sources:
 * course content items (assignment/test handlers), gradebook columns (points,
 * due dates), and the Ultra calendar (authoritative due dates). Results are
 * deduplicated into one consistent list.
 */
export async function getAssignments(http: BBHttp, opts: GetAssignmentsOptions = {}): Promise<Assignment[]> {
  const courses = opts.courseId
    ? [await findCourse(http, opts.courseId)]
    : await listCourses(http);

  const partsByCourse = new Map<string, Partial<Assignment>[]>();
  const calendar = await getCalendarItems(http).catch(() => [] as CalendarItem[]);

  for (const course of courses) {
    const parts: Partial<Assignment>[] = [];
    const base = { courseId: course.id, courseName: course.name, url: course.url };

    // 1) Content items that are assignments or tests.
    let items: ContentItem[] = [];
    try {
      items = await getCourseContent(http, course.id, { depth: 2, includeAttachments: false });
    } catch {
      items = [];
    }
    for (const item of items) {
      if (item.type !== 'assignment' && item.type !== 'test') continue;
      parts.push({
        id: item.id,
        title: item.title,
        descriptionText: item.descriptionText,
        category: item.type === 'test' ? 'test' : 'assignment',
        ...base,
      });
    }

    // 2) Gradebook columns tied to content or carrying due dates.
    let columns: GradebookColumn[] = [];
    try {
      columns = await getGradebookColumns(http, course.id);
    } catch {
      columns = [];
    }
    for (const col of columns) {
      if (!col.contentId && !col.dueDate) continue;
      parts.push({
        id: col.contentId,
        title: col.name,
        dueDate: col.dueDate,
        pointsPossible: col.pointsPossible,
        category: 'gradebook-column',
        ...base,
      });
    }

    // 3) Calendar due-date items for this course.
    for (const cal of calendar) {
      if (cal.courseId !== course.id || !cal.startDate) continue;
      const matchesColumn = columns.some((c) => titlesMatch(c.name, cal.title));
      const matchesContent = items.some((i) => titlesMatch(i.title, cal.title));
      if (!matchesColumn && !matchesContent) continue;
      parts.push({
        title: cal.title ?? 'Due item',
        dueDate: cal.startDate,
        category: 'calendar-item',
        ...base,
      });
    }

    partsByCourse.set(course.id, parts);
  }

  // Deduplicate across sources. Parts with a real content id group by id;
  // id-less parts (calendar items) attach to a matching-title bucket, or form
  // their own bucket when nothing matches.
  const buckets = new Map<string, Partial<Assignment>[]>();
  const orphans: Partial<Assignment>[] = [];
  for (const [, parts] of partsByCourse) {
    for (const part of parts) {
      if (!part.courseId || !part.title) continue;
      if (part.id && part.id.startsWith('_')) {
        const key = `${part.courseId}|${part.id}`;
        const bucket = buckets.get(key) ?? [];
        bucket.push(part);
        buckets.set(key, bucket);
      } else {
        orphans.push(part);
      }
    }
  }
  for (const orphan of orphans) {
    let home: Partial<Assignment>[] | undefined;
    for (const bucket of buckets.values()) {
      if (bucket[0]?.courseId !== orphan.courseId) continue;
      if (bucket.some((p) => titlesMatch(p.title, orphan.title))) {
        home = bucket;
        break;
      }
    }
    if (!home) {
      const key = `${orphan.courseId}|${slugify(orphan.title ?? 'untitled')}|${orphan.pointsPossible ?? ''}`;
      home = buckets.get(key);
      if (!home) {
        home = [];
        buckets.set(key, home);
      }
    }
    home.push(orphan);
  }

  let merged = [...buckets.values()]
    .map((bucket) => mergeAssignmentParts(bucket))
    .filter((a): a is Assignment => a !== undefined);

  // Optional status resolution (bounded: one request per assignment with a
  // known column, capped to keep volume low).
  if (opts.includeStatus) {
    let resolved = 0;
    for (const assignment of merged) {
      if (resolved >= 60) break;
      const column = (partsByCourse.get(assignment.courseId) ?? []).length > 0
        ? (await getGradebookColumns(http, assignment.courseId).catch(() => [])).find(
            (c) => c.contentId === assignment.id || titlesMatch(c.name, assignment.title),
          )
        : undefined;
      if (!column) continue;
      resolved += 1;
      await sleep(120);
      assignment.status = await statusForColumn(http, assignment.courseId, column.id).catch(() => 'unknown' as AssignmentStatus);
    }
  }

  if (opts.dueAfter || opts.dueBefore) {
    merged = merged.filter((a) => withinWindow(a.dueDate, { after: opts.dueAfter, before: opts.dueBefore }));
  }

  merged.sort((a, b) => {
    const da = a.dueDate ? isoOrNow(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    const db = b.dueDate ? isoOrNow(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
    return da - db;
  });
  return merged;
}

export { statusForColumn };
