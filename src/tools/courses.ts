import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listCourses } from '../blackboard/courses.js';
import { errorResult, jsonResult, READ_ONLY_ANNOTATIONS, type BBToolContext } from './util.js';

export function registerCourseTools(server: McpServer, ctx: BBToolContext): void {
  server.registerTool(
    'list_courses',
    {
      title: 'List Blackboard courses',
      description:
        'List the student’s currently visible Blackboard (Syracuse University) courses. ' +
        'Returns course ids needed by every other blackboard tool. Read-only.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const courses = await ctx.callBB((http) => listCourses(http));
        return jsonResult({
          count: courses.length,
          courses: courses.map((c) => ({
            course_id: c.id,
            name: c.name,
            course_code: c.courseCode,
            start_date: c.startDate,
            end_date: c.endDate,
            url: c.url,
          })),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
