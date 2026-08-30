import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAnnouncements } from '../blackboard/announcements.js';
import { errorResult, jsonResult, READ_ONLY_ANNOTATIONS, type BBToolContext } from './util.js';

export function registerAnnouncementTools(server: McpServer, ctx: BBToolContext): void {
  server.registerTool(
    'get_announcements',
    {
      title: 'Get Blackboard course announcements',
      description: 'List announcements for one Blackboard course, newest first. Optionally filter to items created or modified after a date. Read-only.',
      inputSchema: {
        course_id: z.string().describe('Blackboard course id from list_courses, e.g. "_26184_1" (course code also accepted).'),
        since: z.string().optional().describe('ISO date (e.g. "2026-08-01") — only announcements created/modified on or after this instant.'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      try {
        const items = await ctx.callBB((http) =>
          getAnnouncements(http, args.course_id, { since: args.since }),
        );
        return jsonResult({
          course_id: args.course_id,
          since: args.since ?? null,
          count: items.length,
          announcements: items.map((a) => ({
            id: a.id,
            title: a.title,
            body: a.bodyText,
            created: a.created,
            modified: a.modified,
            url: a.url,
          })),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
