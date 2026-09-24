import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAssignments } from '../blackboard/assignments.js';
import { errorResult, jsonResult, limitations, READ_ONLY_ANNOTATIONS, UNKNOWN_STATUS_GAP, type BBToolContext } from './util.js';

export function registerAssignmentTools(server: McpServer, ctx: BBToolContext): void {
  server.registerTool(
    'get_assignments',
    {
      title: 'Get Blackboard assignments',
      description:
        'List assignments and assessments with due dates, combined and deduplicated from Blackboard course content, ' +
        'the gradebook, and the calendar. Optionally scope to one course and/or a due-date window. Read-only.',
      inputSchema: {
        course_id: z.string().optional().describe('Blackboard course id from list_courses. Omit to include all courses.'),
        due_after: z.string().optional().describe('ISO date or date-time. A bare date ("2026-09-30") means the start of that day, Syracuse time.'),
        due_before: z.string().optional().describe('ISO date or date-time. A bare date ("2026-09-30") includes that whole day, Syracuse time.'),
        include_status: z
          .boolean()
          .optional()
          .describe(
            'Also resolve submitted/graded status (slower: 1-2 extra Blackboard requests per item). Status is "in_progress" for a started or saved draft that was NOT handed in, and "unknown" when Blackboard does not report an attempt either way — treat unknown as undetermined, never as missing work.',
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      try {
        const warnings: string[] = [];
        const assignments = await ctx.callBB((http) =>
          getAssignments(http, {
            courseId: args.course_id,
            dueAfter: args.due_after,
            dueBefore: args.due_before,
            includeStatus: args.include_status,
            onWarning: (w) => {
              if (!warnings.includes(w)) warnings.push(w);
            },
          }),
        );
        return jsonResult({
          count: assignments.length,
          assignments: assignments.map((a) => ({
            assignment_id: a.id,
            ref: a.ref,
            course_id: a.courseId,
            course_name: a.courseName,
            title: a.title,
            due_date: a.dueDate,
            points_possible: a.pointsPossible,
            status: a.status,
            category: a.category,
            description: a.descriptionText,
            url: a.url,
          })),
          ...limitations([
            ...warnings,
            (() => {
              const n = args.include_status ? assignments.filter((a) => !a.status || a.status === 'unknown').length : 0;
              return n > 0 ? UNKNOWN_STATUS_GAP(n) : undefined;
            })(),
          ]),
          note: 'Use "ref" with get_assignment_context for the full package (instructions, attachments, grades, related announcements).',
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
