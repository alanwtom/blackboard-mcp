import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listCourses, findCourse } from '../blackboard/courses.js';
import { getCourseContent, type GetContentOptions } from '../blackboard/content.js';
import { getAnnouncements } from '../blackboard/announcements.js';
import { getAssignments, getGradebookColumns } from '../blackboard/assignments.js';
import { getGradeForColumn, getRubricForColumn, normalizeGradeCell } from '../blackboard/grades.js';
import { listContentFiles } from '../blackboard/attachments.js';
import { BlackboardError } from '../blackboard/errors.js';
import type { ContentItem } from '../blackboard/types.js';
import { isoOrNow, parseBBDate, sleep, titlesMatch } from '../blackboard/util.js';
import { errorResult, jsonResult, READ_ONLY_ANNOTATIONS, type BBToolContext } from './util.js';

const MAX_COURSES_FOR_SWEEPS = 12;

export function registerStudentTools(server: McpServer, ctx: BBToolContext): void {
  server.registerTool(
    'get_upcoming_work',
    {
      title: 'Get upcoming Blackboard work',
      description:
        'Upcoming assignments and assessments across ALL Blackboard courses, sorted by due date. ' +
        'This is the one call to answer “what do I have due?”. Read-only.',
      inputSchema: {
        days: z.number().int().min(1).max(90).optional().describe('How many days ahead to look (default 7).'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      try {
        const days = args.days ?? 7;
        const now = new Date();
        const until = new Date(now.getTime() + days * 24 * 3600_000);
        const assignments = await ctx.callBB((http) =>
          getAssignments(http, { dueAfter: now.toISOString(), dueBefore: until.toISOString() }),
        );
        const undated = await ctx.callBB((http) => getAssignments(http)).then(
          (all) => all.filter((a) => !a.dueDate).length,
          () => undefined,
        );
        return jsonResult({
          window: { from: now.toISOString(), until: until.toISOString(), days },
          count: assignments.length,
          items: assignments.map((a) => ({
            ref: a.ref,
            course_id: a.courseId,
            course_name: a.courseName,
            title: a.title,
            due_date: a.dueDate,
            points_possible: a.pointsPossible,
            status: a.status,
            category: a.category,
          })),
          undated_items_excluded: undated,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_recent_updates',
    {
      title: 'Get recent Blackboard updates',
      description:
        'Recent Blackboard activity across all courses since a point in time (default: last 7 days): announcements, ' +
        'new/changed content items, changed assignments, and newly posted grades. Read-only.',
      inputSchema: {
        since: z.string().optional().describe('ISO date (e.g. "2026-08-21"). Defaults to 7 days ago.'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      try {
        const result = await ctx.callBB(async (http) => {
          const since = isoOrNow(args.since);
          const sinceIso = since.toISOString();
          const courses = (await listCourses(http)).slice(0, MAX_COURSES_FOR_SWEEPS);

          const announcements: Array<Record<string, unknown>> = [];
          const newContent: Array<Record<string, unknown>> = [];
          const changedAssignments: Array<Record<string, unknown>> = [];
          const newGrades: Array<Record<string, unknown>> = [];

          for (const course of courses) {
            try {
              const anns = await getAnnouncements(http, course.id, { since: sinceIso, limit: 20 });
              announcements.push(...anns.map((a) => ({ course: course.name, course_id: course.id, ...a })));
            } catch {
              /* per-course failures are fine in a sweep */
            }
            await sleep(150);

            let items: ContentItem[] = [];
            try {
              items = await getCourseContent(http, course.id, { depth: 2, includeAttachments: false, maxItems: 150 });
            } catch {
              items = [];
            }
            for (const item of items) {
              const modified = item.modified ? parseBBDate(item.modified) : undefined;
              if (modified && modified >= since) {
                newContent.push({
                  course: course.name,
                  course_id: course.id,
                  content_id: item.id,
                  title: item.title,
                  type: item.type,
                  modified: item.modified,
                  url: item.url ?? null,
                });
              }
              if (item.type === 'assignment' || item.type === 'test') {
                if (modified && modified >= since) {
                  changedAssignments.push({
                    course: course.name,
                    course_id: course.id,
                    assignment_id: item.id,
                    ref: `${course.id}:${item.id}`,
                    title: item.title,
                    modified: item.modified,
                  });
                }
              }
            }
            await sleep(150);

            try {
              const columns = await getGradebookColumns(http, course.id);
              for (const col of columns) {
                const modified = col.modified ? parseBBDate(col.modified) : undefined;
                if (!modified || modified < since) continue;
                if (!col.contentId && !col.dueDate) continue;
                changedAssignments.push({
                  course: course.name,
                  course_id: course.id,
                  assignment_id: col.contentId,
                  title: col.name,
                  points_possible: col.pointsPossible,
                  modified: col.modified,
                });
                const cell = await getGradeForColumn(http, course.id, col.id);
                if (cell) {
                  newGrades.push({
                    course: course.name,
                    course_id: course.id,
                    title: col.name,
                    score: cell.score ?? null,
                    points_possible: col.pointsPossible,
                    modified: col.modified,
                  });
                }
                await sleep(120);
              }
            } catch {
              /* gradebook may be unavailable for some courses */
            }
          }

          return {
            since: sinceIso,
            course_count: courses.length,
            announcements,
            new_or_changed_content: newContent,
            changed_assignments: changedAssignments,
            new_grades: newGrades,
          };
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_assignment_context',
    {
      title: 'Get full assignment context',
      description:
        'One package describing a Blackboard assignment: instructions, due date, points, rubric (when available), ' +
        'attachments with local file paths, the student’s grade/status for it, and related course announcements. ' +
        'Use this instead of many low-level calls. Read-only.',
      inputSchema: {
        assignment_id: z.string().describe('Assignment reference "ref" from get_assignments (format "<course_id>:<content_id>"), or a bare Blackboard content id.'),
        course_id: z.string().optional().describe('Required only when assignment_id is a bare content id.'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      try {
        const result = await ctx.callBB(async (http) => {
          let courseId: string | undefined;
          let contentId: string | undefined;
          const raw = args.assignment_id.trim();
          if (raw.includes(':')) {
            const idx = raw.indexOf(':');
            courseId = raw.slice(0, idx);
            contentId = raw.slice(idx + 1);
          } else {
            contentId = raw;
            courseId = args.course_id?.trim() || undefined;
          }
          if (!courseId) {
            throw new BlackboardError(
              'INVALID_INPUT',
              'Cannot determine the course for this assignment. Pass the "ref" value from get_assignments, or provide course_id.',
            );
          }

          const course = await findCourse(http, courseId);

          const contentOpts: GetContentOptions = { depth: 2, includeAttachments: false, maxItems: 300 };
          let items: ContentItem[] = [];
          try {
            items = await getCourseContent(http, course.id, contentOpts);
          } catch {
            items = [];
          }
          let item = items.find((i) => i.id === contentId) ?? items.find((i) => titlesMatch(i.title, contentId));
          if (!item) {
            throw new BlackboardError(
              'CONTENT_NOT_AVAILABLE',
              `Assignment "${args.assignment_id}" was not found in course ${course.id}. Use get_assignments to get valid refs.`,
            );
          }

          const attachments =
            item.attachments.length > 0
              ? item.attachments
              : await listContentFiles(http, course.id, item.id, item.descriptionHtml).catch(() => []);

          const columns = await getGradebookColumns(http, course.id).catch(() => []);
          const column = columns.find((c) => c.contentId === item?.id) ?? columns.find((c) => titlesMatch(c.name, item?.title));
          let grade: Record<string, unknown> | null = null;
          let rubric: { id?: string; title?: string }[] = [];
          if (column) {
            grade = (await getGradeForColumn(http, course.id, column.id).catch(() => null)) ?? null;
            rubric = await getRubricForColumn(http, course.id, column.id).catch(() => []);
          }

          let relatedAnnouncements: Array<Record<string, unknown>> = [];
          try {
            // Blackboard rarely puts due dates on content items; the joined
            // gradebook column is the reliable source.
            const due = parseBBDate(item.dueDate) ?? parseBBDate(column?.dueDate);
            const all = await getAnnouncements(http, course.id, { limit: 30 });
            relatedAnnouncements = all
              .filter((a) => {
                if (titlesMatch(a.title, item?.title)) return true;
                if (!due) return false;
                const created = a.created ? parseBBDate(a.created) : undefined;
                if (!created) return false;
                const twoWeeks = 14 * 24 * 3600_000;
                return Math.abs(created.getTime() - due.getTime()) <= twoWeeks;
              })
              .slice(0, 5)
              .map((a) => ({ title: a.title, created: a.created, body: a.bodyText }));
          } catch {
            relatedAnnouncements = [];
          }

          return {
            assignment: {
              ref: `${course.id}:${item.id}`,
              course_id: course.id,
              course_name: course.name,
              content_id: item.id,
              title: item.title,
              type: item.type,
              instructions: item.descriptionText,
              instructions_html: item.descriptionHtml,
              due_date: item.dueDate ?? column?.dueDate ?? null,
              points_possible: column?.pointsPossible ?? null,
              url: item.url ?? course.url,
            },
            rubric: rubric.length > 0 ? rubric : null,
            attachments: attachments.map((a) => ({
              file_id: a.fileId ?? null,
              file_name: a.fileName ?? null,
              mime_type: a.mimeType ?? null,
              size_bytes: a.sizeBytes ?? null,
            })),
            grade: (() => {
              const cell = grade ? normalizeGradeCell(grade) : null;
              return {
                score: cell?.score ?? null,
                grading_status: cell?.gradingStatus ?? 'not_graded',
                feedback: cell?.feedback ?? null,
                column: column?.name ?? null,
              };
            })(),
            related_announcements: relatedAnnouncements,
            hint: 'Call get_attachment with course_id + content_id (+ file_id) to save any attachment locally.',
          };
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
