import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getGrades } from '../blackboard/grades.js';
import { errorResult, jsonResult, READ_ONLY_ANNOTATIONS, type BBToolContext } from './util.js';

export function registerGradeTools(server: McpServer, ctx: BBToolContext): void {
  server.registerTool(
    'get_grades',
    {
      title: 'Get Blackboard grades',
      description:
        'List the student’s own grades for one Blackboard course: assignment, score, points possible, percentage, ' +
        'feedback, and grading status. Only grades visible to the signed-in student are returned. Read-only.',
      inputSchema: {
        course_id: z.string().describe('Blackboard course id from list_courses, e.g. "_26184_1" (course code also accepted).'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      try {
        const grades = await ctx.callBB((http) => getGrades(http, args.course_id));
        const graded = grades.filter((g) => g.gradingStatus === 'graded');
        return jsonResult({
          course_id: args.course_id,
          count: grades.length,
          graded_count: graded.length,
          grades: grades.map((g) => ({
            grade_id: g.id,
            title: g.title,
            score: g.score,
            points_possible: g.pointsPossible,
            percentage: g.percentage,
            grading_status: g.gradingStatus,
            feedback: g.feedback,
            due_date: g.dueDate,
            modified: g.modified,
          })),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
