import { z } from 'zod';
import { readableCourses, findCourse } from '../blackboard/courses.js';
import { getCourseContent } from '../blackboard/content.js';
import { getAnnouncements } from '../blackboard/announcements.js';
import { columnFor, getAssignments, getGradebookColumns, statusForColumn } from '../blackboard/assignments.js';
import { getGradeForColumn, getRubricForColumn, normalizeGradeCell } from '../blackboard/grades.js';
import { listContentFiles } from '../blackboard/attachments.js';
import { BlackboardError } from '../blackboard/errors.js';
import { endOfSchoolDay, mapWithConcurrency, parseBBDate, parseWindowBound, slugify, titlesMatch } from '../blackboard/util.js';
import { errorResult, jsonResult, limitations, READ_ONLY_ANNOTATIONS, UNKNOWN_STATUS_GAP } from './util.js';
const MAX_COURSES_FOR_SWEEPS = 20;
const DAY_MS = 24 * 3600_000;
/** How far back "overdue but maybe still submittable" reaches. */
const OVERDUE_LOOKBACK_DAYS = 3;
const STATUS_GUIDE = 'status: graded, submitted, in_progress (started or saved as a draft, NOT handed in), not_submitted, or unknown ' +
    '(Blackboard did not say — never treat unknown as missing work).';
/**
 * Newest enrolments first. Blackboard numbers courses as they are created,
 * so a higher id is a newer term. Sorting by "last opened" (as before) put a
 * new-term course the student had not opened yet behind years of old ones,
 * where the sweep cap could cut it off entirely.
 */
function newestFirst(courses) {
    const num = (c) => Number(/^_(\d+)_/.exec(c.id)?.[1] ?? 0);
    return [...courses].sort((a, b) => num(b) - num(a));
}
export function registerStudentTools(server, ctx) {
    server.registerTool('get_upcoming_work', {
        title: 'Get upcoming Blackboard work',
        description: 'Upcoming assignments and assessments across ALL Blackboard courses, sorted by due date, with submission status. ' +
            'Also lists anything due in the last few days that has not been handed in. ' +
            'This is the one call to answer “what do I have due?”. The window runs to the end of the last day, Syracuse time. ' +
            `${STATUS_GUIDE} Read-only.`,
        inputSchema: {
            days: z.number().int().min(1).max(90).optional().describe('How many days ahead to look (default 7).'),
        },
        annotations: READ_ONLY_ANNOTATIONS,
    }, async (args) => {
        try {
            const days = args.days ?? 7;
            const now = new Date();
            const until = endOfSchoolDay(new Date(now.getTime() + days * DAY_MS));
            const from = new Date(now.getTime() - OVERDUE_LOOKBACK_DAYS * DAY_MS);
            const warnings = [];
            const onWarning = (w) => {
                if (!warnings.includes(w))
                    warnings.push(w);
            };
            const { windowed, undated } = await ctx.callBB(async (http) => {
                const windowed = await getAssignments(http, {
                    dueAfter: from.toISOString(),
                    dueBefore: until.toISOString(),
                    includeStatus: true,
                    onWarning,
                });
                // Same cached listings, so this costs no extra Blackboard requests.
                const all = await getAssignments(http).catch(() => null);
                return { windowed, undated: all ? all.filter((a) => !a.dueDate).length : undefined };
            });
            const row = (a) => ({
                ref: a.ref,
                course_id: a.courseId,
                course_name: a.courseName,
                title: a.title,
                due_date: a.dueDate,
                points_possible: a.pointsPossible,
                status: a.status ?? 'unknown',
                category: a.category,
            });
            const handedIn = new Set(['submitted', 'graded']);
            const upcoming = windowed.filter((a) => (parseBBDate(a.dueDate)?.getTime() ?? 0) >= now.getTime());
            const overdue = windowed.filter((a) => (parseBBDate(a.dueDate)?.getTime() ?? 0) < now.getTime() && !handedIn.has(a.status));
            const unknown = [...upcoming, ...overdue].filter((a) => !a.status || a.status === 'unknown').length;
            return jsonResult({
                window: { from: now.toISOString(), until: until.toISOString(), days },
                count: upcoming.length,
                items: upcoming.map(row),
                recently_overdue: overdue.length > 0 ? overdue.map(row) : undefined,
                ...limitations([
                    ...warnings,
                    unknown > 0 ? UNKNOWN_STATUS_GAP(unknown) : undefined,
                    undated
                        ? `${undated} assignment${undated === 1 ? ' has' : 's have'} no due date in Blackboard, so ${undated === 1 ? 'it is' : 'they are'} not listed here. Ask for all assignments to see ${undated === 1 ? 'it' : 'them'}.`
                        : undefined,
                    'Only work posted in Blackboard is included. Deadlines a professor gives only in class, on a syllabus PDF, or in an outside tool (like McGraw Hill Connect or Gradescope) will not appear.',
                ]),
            });
        }
        catch (err) {
            return errorResult(err);
        }
    });
    server.registerTool('get_recent_updates', {
        title: 'Get recent Blackboard updates',
        description: 'Recent Blackboard activity across current courses since a point in time (default: the last 7 days): announcements ' +
            '(with their links), new or changed content items, changed assignments, and grades on gradebook items that changed. ' +
            'Read-only.',
        inputSchema: {
            since: z.string().optional().describe('ISO date (e.g. "2026-08-21"). Defaults to 7 days ago.'),
        },
        annotations: READ_ONLY_ANNOTATIONS,
    }, async (args) => {
        try {
            let since;
            if (args.since) {
                const parsed = parseWindowBound(args.since, 'start');
                if (!parsed) {
                    throw new BlackboardError('INVALID_INPUT', `"${args.since}" is not a date. Use a date like "2026-09-01".`);
                }
                since = parsed;
            }
            else {
                // The old default was "now", so asking with no date always came
                // back empty — the tool's most common use answered "nothing new".
                since = new Date(Date.now() - 7 * DAY_MS);
            }
            const result = await ctx.callBB(async (http) => {
                const sinceIso = since.toISOString();
                const allCourses = await readableCourses(http);
                const courses = newestFirst(allCourses).slice(0, MAX_COURSES_FOR_SWEEPS);
                const skipped = allCourses.length - courses.length;
                const perCourse = await mapWithConcurrency(courses, async (course) => {
                    const tag = { course: course.name, course_id: course.id };
                    const bucket = {
                        announcements: [],
                        newContent: [],
                        changedAssignments: [],
                        newGrades: [],
                    };
                    // Three independent sources; a failure in one must not lose the others.
                    const [anns, items, columns] = await Promise.all([
                        getAnnouncements(http, course.id, { since: sinceIso, limit: 20 }).catch(() => []),
                        getCourseContent(http, course.id, { depth: 2, includeAttachments: false, maxItems: 150 }).catch(() => []),
                        getGradebookColumns(http, course.id).catch(() => []),
                    ]);
                    bucket.announcements.push(...anns.map((a) => ({
                        ...tag,
                        title: a.title,
                        body: a.bodyText,
                        created: a.created,
                        links: a.links.map((l) => ({ url: l.url, label: l.label ?? null, kind: l.kind })),
                    })));
                    for (const item of items) {
                        const modified = item.modified ? parseBBDate(item.modified) : undefined;
                        if (!modified || modified < since)
                            continue;
                        bucket.newContent.push({
                            ...tag,
                            content_id: item.id,
                            title: item.title,
                            type: item.type,
                            modified: item.modified,
                            url: item.url ?? null,
                            links: item.links.length > 0 ? item.links.map((l) => ({ url: l.url, kind: l.kind })) : undefined,
                        });
                        if (item.type === 'assignment' || item.type === 'test') {
                            bucket.changedAssignments.push({
                                ...tag,
                                assignment_id: item.id,
                                ref: `${course.id}:${item.id}`,
                                title: item.title,
                                modified: item.modified,
                            });
                        }
                    }
                    const changedColumns = columns.filter((col) => {
                        const modified = col.modified ? parseBBDate(col.modified) : undefined;
                        if (!modified || modified < since)
                            return false;
                        return Boolean(col.contentId || col.dueDate);
                    });
                    for (const col of changedColumns) {
                        bucket.changedAssignments.push({
                            ...tag,
                            assignment_id: col.contentId,
                            title: col.name,
                            points_possible: col.pointsPossible,
                            modified: col.modified,
                        });
                    }
                    const cells = await mapWithConcurrency(changedColumns, (col) => getGradeForColumn(http, course.id, col.id).catch(() => undefined));
                    cells.forEach((cell, i) => {
                        const col = changedColumns[i];
                        if (!cell || !col)
                            return;
                        const grade = normalizeGradeCell(cell);
                        // Only an actual grade is news; an empty cell on an edited column is not.
                        if (grade.gradingStatus !== 'graded')
                            return;
                        bucket.newGrades.push({
                            ...tag,
                            title: col.name,
                            score: grade.score ?? null,
                            grade_display: grade.display ?? null,
                            points_possible: col.pointsPossible,
                            modified: col.modified,
                        });
                    });
                    return bucket;
                });
                return {
                    since: sinceIso,
                    course_count: courses.length,
                    ...limitations([
                        skipped > 0
                            ? `${skipped} older courses were not checked (only the ${MAX_COURSES_FOR_SWEEPS} newest are). Ask about a specific course to check it.`
                            : undefined,
                        // A real gap in what Blackboard exposes: grade cells carry no
                        // "graded on" date, so only items the instructor edited recently
                        // can be checked.
                        'New grades are only spotted on gradebook items the instructor changed recently. A grade entered on an older item can be missed here; ask for the grades in a course to be sure.',
                    ]),
                    announcements: perCourse.flatMap((b) => b.announcements),
                    new_or_changed_content: perCourse.flatMap((b) => b.newContent),
                    changed_assignments: perCourse.flatMap((b) => b.changedAssignments),
                    new_grades: perCourse.flatMap((b) => b.newGrades),
                };
            });
            return jsonResult(result);
        }
        catch (err) {
            return errorResult(err);
        }
    });
    server.registerTool('get_assignment_context', {
        title: 'Get full assignment context',
        description: 'One package describing a Blackboard assignment: instructions, due date, points, rubric (when available), ' +
            'attached files, links in the instructions (open them with read_link), the student’s grade and submission status, ' +
            `and related course announcements. Use this instead of many low-level calls. ${STATUS_GUIDE} Read-only.`,
        inputSchema: {
            assignment_id: z.string().describe('Assignment reference "ref" from get_assignments (format "<course_id>:<content_id>"), or a bare Blackboard content id.'),
            course_id: z.string().optional().describe('Required only when assignment_id is a bare content id.'),
        },
        annotations: READ_ONLY_ANNOTATIONS,
    }, async (args) => {
        try {
            const result = await ctx.callBB(async (http) => {
                let courseId;
                let contentId;
                const raw = args.assignment_id.trim();
                if (raw.includes(':')) {
                    const idx = raw.indexOf(':');
                    courseId = raw.slice(0, idx);
                    contentId = raw.slice(idx + 1);
                }
                else {
                    contentId = raw;
                    courseId = args.course_id?.trim() || undefined;
                }
                if (!courseId) {
                    throw new BlackboardError('INVALID_INPUT', 'Cannot determine the course for this assignment. Pass the "ref" value from get_assignments, or provide course_id.');
                }
                const course = await findCourse(http, courseId);
                // Same options as read_link and get_attachment, so all three share one listing.
                const items = await getCourseContent(http, course.id, { depth: 4, maxItems: 800, includeAttachments: false }).catch(() => []);
                const columns = await getGradebookColumns(http, course.id).catch(() => []);
                // By id, then by title — preferring an actual assignment or test over
                // a same-named instructions page.
                const isWork = (i) => i.type === 'assignment' || i.type === 'test';
                const item = items.find((i) => i.id === contentId) ??
                    items.find((i) => isWork(i) && (titlesMatch(i.title, contentId) || slugify(i.title) === contentId)) ??
                    items.find((i) => titlesMatch(i.title, contentId));
                // Gradebook-only work (no content item) gets a title-slug ref from
                // get_assignments; find its column so those refs work here too.
                const column = item
                    ? columnFor(columns, { id: item.id, columnId: item.gradeColumnId, title: item.title })
                    : columns.find((c) => c.contentId === contentId || c.id === contentId || slugify(c.name) === contentId);
                if (!item && !column) {
                    throw new BlackboardError('CONTENT_NOT_AVAILABLE', `Assignment "${args.assignment_id}" was not found in course ${course.id}. Use get_assignments to get valid refs.`);
                }
                const attachments = item
                    ? item.attachments.length > 0
                        ? item.attachments
                        : await listContentFiles(http, course.id, item.id, item.descriptionHtml).catch(() => [])
                    : [];
                let cell;
                let rubric = [];
                let status;
                if (column) {
                    [cell, rubric, status] = await Promise.all([
                        getGradeForColumn(http, course.id, column.id).catch(() => undefined),
                        getRubricForColumn(http, course.id, column.id).catch(() => []),
                        statusForColumn(http, course.id, column.id).catch(() => 'unknown'),
                    ]);
                }
                const title = item?.title ?? column?.name ?? contentId;
                let relatedAnnouncements = [];
                try {
                    // Blackboard rarely puts due dates on content items; the joined
                    // gradebook column is the reliable source.
                    const due = parseBBDate(item?.dueDate) ?? parseBBDate(column?.dueDate);
                    const all = await getAnnouncements(http, course.id, { limit: 30 });
                    relatedAnnouncements = all
                        .filter((a) => {
                        if (titlesMatch(a.title, title))
                            return true;
                        if (!due)
                            return false;
                        const created = a.created ? parseBBDate(a.created) : undefined;
                        if (!created)
                            return false;
                        return Math.abs(created.getTime() - due.getTime()) <= 14 * DAY_MS;
                    })
                        .slice(0, 5)
                        .map((a) => ({
                        title: a.title,
                        created: a.created,
                        body: a.bodyText,
                        links: a.links.map((l) => ({ url: l.url, label: l.label ?? null, kind: l.kind })),
                    }));
                }
                catch {
                    relatedAnnouncements = [];
                }
                const grade = cell ? normalizeGradeCell(cell) : null;
                return {
                    assignment: {
                        ref: `${course.id}:${item?.id ?? contentId}`,
                        course_id: course.id,
                        course_name: course.name,
                        content_id: item?.id ?? column?.contentId ?? null,
                        title,
                        type: item?.type ?? 'gradebook-column',
                        instructions: item?.descriptionText ?? null,
                        instructions_html: item?.descriptionHtml ?? null,
                        due_date: item?.dueDate ?? column?.dueDate ?? null,
                        points_possible: column?.pointsPossible ?? null,
                        url: item?.url ?? course.url,
                    },
                    rubric: rubric.length > 0 ? rubric : null,
                    attachments: attachments.map((a) => ({
                        file_id: a.fileId ?? null,
                        file_name: a.fileName ?? null,
                        mime_type: a.mimeType ?? null,
                        size_bytes: a.sizeBytes ?? null,
                    })),
                    links: (item?.links ?? []).map((l) => ({ url: l.url, label: l.label ?? null, kind: l.kind })),
                    grade: {
                        score: grade?.score ?? null,
                        grade_display: grade?.display ?? null,
                        // No cell means Blackboard did not answer, not "ungraded".
                        grading_status: grade?.gradingStatus ?? (column ? 'unknown' : 'not_graded'),
                        submission_status: status ?? 'unknown',
                        feedback: grade?.feedback ?? null,
                        column: column?.name ?? null,
                    },
                    related_announcements: relatedAnnouncements,
                    ...limitations([
                        !column
                            ? 'This item is not linked to a gradebook column, so its grade, points and submission status are unknown here. Check it in Blackboard.'
                            : undefined,
                        column && (status ?? 'unknown') === 'unknown' ? UNKNOWN_STATUS_GAP(1) : undefined,
                        column && !cell ? 'Blackboard did not return the grade for this item, so it is unknown here (not zero).' : undefined,
                        rubric.length === 0 && column
                            ? 'No rubric came through from Blackboard. If the assignment page shows one, it has to be read there.'
                            : undefined,
                        item && !item.descriptionText
                            ? 'This item has no written instructions in Blackboard. They may be in an attached file (see attachments) or given in class.'
                            : undefined,
                    ]),
                    hint: item && attachments.length > 0
                        ? 'Call get_attachment with course_id + content_id (+ file_id) to read an attachment.'
                        : undefined,
                };
            });
            return jsonResult(result);
        }
        catch (err) {
            return errorResult(err);
        }
    });
}
