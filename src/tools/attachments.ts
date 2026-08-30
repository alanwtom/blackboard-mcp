import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { downloadAttachmentRef, downloadAttachment, listContentFiles } from '../blackboard/attachments.js';
import { getCourseContent } from '../blackboard/content.js';
import { findCourse } from '../blackboard/courses.js';
import { errorResult, jsonResult, READ_ONLY_ANNOTATIONS, type BBToolContext } from './util.js';

export function registerAttachmentTools(server: McpServer, ctx: BBToolContext): void {
  server.registerTool(
    'get_attachment',
    {
      title: 'Get Blackboard course attachment',
      description:
        'Download a course file (PDF, DOCX, PPTX, images, ...) from Blackboard to this machine and return its local path. ' +
        'Files are saved under ~/.blackboard-mcp/downloads only when you call this tool; nothing is sent anywhere. ' +
        'Small text files also include a text excerpt. Read-only.',
      inputSchema: {
        course_id: z.string().describe('Blackboard course id from list_courses, e.g. "_26184_1" (course code also accepted).'),
        content_id: z.string().describe('Blackboard content id from get_course_content or get_assignments, e.g. "_3001_1".'),
        file_id: z.string().optional().describe('Specific file id when a content item has several attachments (see available_files in the result).'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      try {
        const course = await ctx.callBB((http) => findCourse(http, args.course_id));
        // Preferred path: the content listing already carries handler
        // attachment data (name, type, and the /ultra/redirect download link).
        const items = await ctx.callBB((http) =>
          getCourseContent(http, course.id, { depth: 3, maxItems: 400 }),
        );
        const item = items.find((i) => i.id === args.content_id);
        const refs = item?.attachments ?? [];
        const chosen =
          refs.length > 0
            ? args.file_id
              ? refs.find((r) => r.fileId === args.file_id) ?? refs.find((r) => r.fileName === args.file_id)
              : refs[0]
            : undefined;

        const saved = await ctx.callBB(async (http) => {
          if (chosen) {
            return downloadAttachmentRef(http, chosen, {
              subfolder: course.courseCode ?? course.id,
            });
          }
          // Fallback for deployments that expose content-files endpoints.
          return downloadAttachment(http, {
            courseId: course.id,
            contentId: args.content_id,
            fileId: args.file_id,
            subfolder: course.courseCode ?? course.id,
          });
        });

        const available = refs.length > 0 ? refs : await ctx.callBB((http) => listContentFiles(http, course.id, args.content_id));
        return jsonResult({
          path: saved.path,
          file_name: saved.fileName,
          size_bytes: saved.sizeBytes,
          mime_type: saved.mimeType ?? null,
          text_excerpt: saved.textExcerpt,
          available_files: available.map((a) => ({
            file_id: a.fileId ?? null,
            file_name: a.fileName ?? null,
          })),
          note: 'The file is saved locally for the MCP client to open. It is never uploaded or shared anywhere.',
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
