import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAssignments } from '../blackboard/assignments.js';
import { errorResult, jsonResult, READ_ONLY_ANNOTATIONS, type BBToolContext } from './util.js';

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
        due_after: z.string().optional().describe('ISO date — only items due on/after this instant.'),
        due_before: z.string().optional().describe('ISO date — only items due on/before this instant.'),
        include_status: z.boolean().optional().describe('Also resolve submitted/graded status (slower: one extra Blackboard request per item).'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      try {
        const assignments = await ctx.callBB((http) =>
          getAssignments(http, {
            courseId: args.course_id,
            dueAfter: args.due_after,
            dueBefore: args.due_before,
            includeStatus: args.include_status,
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
          note: 'Use "ref" with get_assignment_context for the full package (instructions, attachments, grades, related announcements).',
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
