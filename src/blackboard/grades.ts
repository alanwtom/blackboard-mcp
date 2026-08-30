import { globalCache, TTL } from './cache.js';
import { findCourse } from './courses.js';
import { getGradebookColumns } from './assignments.js';
import { getJson } from './transport.js';
import type { BBHttp } from './session.js';
import type { GradeEntry, GradingStatus } from './types.js';
import { htmlToText, sleep, strField } from './util.js';

const API_V2 = '/learn/api/public/v2';

function extractScore(data: Record<string, unknown>): number | undefined {
  const score = data.score;
  if (typeof score === 'number' && Number.isFinite(score)) return score;
  if (score && typeof score === 'object') {
    const inner = (score as Record<string, unknown>).score;
    if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
  }
  return undefined;
}

function extractFeedback(data: Record<string, unknown>): string | undefined {
  const fb = strField(data, 'feedback') ?? strField(data, 'attempt.feedback');
  if (fb && fb.trim() !== '') return htmlToText(fb) ?? fb.trim();
  return undefined;
}

/** Normalized view of a student's grade cell for MCP output. */
export function normalizeGradeCell(cell: Record<string, unknown>): {
  score?: number;
  feedback?: string;
  gradingStatus: GradingStatus;
} {
  const score = extractScore(cell);
  const gradingStatus: GradingStatus =
    cell.exempt === true ? 'exempt' : score !== undefined ? 'graded' : 'not_graded';
  return { score, feedback: extractFeedback(cell), gradingStatus };
}

/**
 * The student's own grades for one course. Only data Blackboard already shows
 * the signed-in student is requested (v2 gradebook columns + the per-column
 * "users/me" grade cell). Sequential with small delays and cached.
 */
export async function getGrades(http: BBHttp, courseId: string): Promise<GradeEntry[]> {
  const course = await findCourse(http, courseId);
  const cacheKey = `grades:${course.id}`;
  return globalCache.wrap(cacheKey, TTL.grades, async () => {
    const columns = await getGradebookColumns(http, course.id);
    const entries: GradeEntry[] = [];
    for (const column of columns) {
      await sleep(120);
      const cell = await getJson<Record<string, unknown>>(
        http,
        `${API_V2}/courses/${encodeURIComponent(course.id)}/gradebook/columns/${encodeURIComponent(column.id)}/users/me`,
        { allowNotFound: true },
      ).catch(() => null);

      const score = cell ? extractScore(cell) : undefined;
      const exempt = cell?.exempt === true;
      let gradingStatus: GradingStatus = 'unknown';
      if (exempt) gradingStatus = 'exempt';
      else if (score !== undefined) gradingStatus = 'graded';
      else if (cell) gradingStatus = 'not_graded';

      const pointsPossible = column.pointsPossible;
      const percentage =
        score !== undefined && pointsPossible !== undefined && pointsPossible > 0
          ? Math.round((score / pointsPossible) * 1000) / 10
          : undefined;

      entries.push({
        id: `${course.id}:${column.id}`,
        courseId: course.id,
        columnId: column.id,
        title: column.name,
        dueDate: column.dueDate,
        score,
        pointsPossible,
        percentage,
        feedback: cell ? extractFeedback(cell) : undefined,
        gradingStatus,
        modified: column.modified,
      });
    }
    return entries;
  });
}

/** Read the student's grade cell for one column; returns undefined if absent. */
export async function getGradeForColumn(
  http: BBHttp,
  courseId: string,
  columnId: string,
): Promise<Record<string, unknown> | undefined> {
  const cell = await getJson<Record<string, unknown>>(
    http,
    `${API_V2}/courses/${encodeURIComponent(courseId)}/gradebook/columns/${encodeURIComponent(columnId)}/users/me`,
    { allowNotFound: true },
  ).catch(() => null);
  return cell ?? undefined;
}

/** Rubric metadata for a gradebook column, when the deployment exposes it. */
export async function getRubricForColumn(
  http: BBHttp,
  courseId: string,
  columnId: string,
): Promise<{ title?: string; id?: string }[]> {
  const data = await getJson<unknown>(
    http,
    `${API_V2}/courses/${encodeURIComponent(courseId)}/gradebook/columns/${encodeURIComponent(columnId)}/rubrics`,
    { allowNotFound: true },
  ).catch(() => null);
  if (!data) return [];
  const results = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown>)?.results)
      ? ((data as Record<string, unknown>).results as unknown[])
      : [];
  return results
    .map((r): { id?: string; title?: string } | null => {
      const rec = r as Record<string, unknown>;
      const id = strField(rec, 'id');
      const title = strField(rec, 'title');
      return id || title ? { id, title } : null;
    })
    .filter((r): r is { id?: string; title?: string } => r !== null);
}
