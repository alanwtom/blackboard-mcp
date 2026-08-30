import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getCourseContent } from '../blackboard/content.js';
import { errorResult, jsonResult, READ_ONLY_ANNOTATIONS, type BBToolContext } from './util.js';

export function registerContentTools(server: McpServer, ctx: BBToolContext): void {
  server.registerTool(
    'get_course_content',
    {
      title: 'Get Blackboard course content',
      description:
        'List a course’s content items (folders, documents, files, assignments, tests, links) from Blackboard. ' +
        'Hierarchy is expanded a couple of folder levels; pass folder_id to go deeper into one folder. Read-only.',
      inputSchema: {
        course_id: z.string().describe('Blackboard course id from list_courses, e.g. "_26184_1" (course code also accepted).'),
        folder_id: z.string().optional().describe('Content id of a folder to list instead of the course root.'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      try {
        const items = await ctx.callBB((http) =>
          getCourseContent(http, args.course_id, { folderId: args.folder_id }),
        );
        return jsonResult({
          course_id: args.course_id,
          folder_id: args.folder_id ?? null,
          count: items.length,
          items: items.map((i) => ({
            content_id: i.id,
            title: i.title,
            type: i.type,
            parent_id: i.parentId ?? null,
            has_children: i.hasChildren,
            description: i.descriptionText,
            due_date: i.dueDate,
            attachments: i.attachments.map((a) => ({
              file_id: a.fileId ?? null,
              file_name: a.fileName ?? null,
              size_bytes: a.sizeBytes ?? null,
              mime_type: a.mimeType ?? null,
            })),
            modified: i.modified,
            url: i.url ?? null,
          })),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
