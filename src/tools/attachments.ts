import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { downloadAttachmentRef, downloadAttachment, listContentFiles } from '../blackboard/attachments.js';
import { globalCache } from '../blackboard/cache.js';
import { getCourseContent } from '../blackboard/content.js';
import { findCourse } from '../blackboard/courses.js';
import { extractText, textWindow, type ExtractedText } from '../blackboard/extract.js';
import type { AttachmentRef, AttachmentSaveResult } from '../blackboard/types.js';
import { errorResult, jsonResult, READ_ONLY_ANNOTATIONS, type BBToolContext } from './util.js';

const TEXT_CACHE_MS = 20 * 60_000;

interface Fetched {
  saved: Omit<AttachmentSaveResult, 'bytes'>;
  extracted: ExtractedText | null;
  available: AttachmentRef[];
  chosen?: AttachmentRef;
}

export function registerAttachmentTools(server: McpServer, ctx: BBToolContext): void {
  server.registerTool(
    'get_attachment',
    {
      title: 'Get Blackboard course attachment',
      description:
        'Download a course file (PDF, Word, PowerPoint, Excel, notebooks, text, images, ...) from Blackboard and return its ' +
        'contents as text, plus the local path where it was saved (~/.blackboard-mcp/downloads). PDFs come back page by page, ' +
        'slides with speaker notes, spreadsheets as CSV per sheet. Long files come in pages: pass next_offset back as offset ' +
        'to keep reading. Nothing is sent anywhere. Read-only.',
      inputSchema: {
        course_id: z.string().describe('Blackboard course id from list_courses, e.g. "_26184_1" (course code also accepted).'),
        content_id: z.string().describe('Blackboard content id from get_course_content or get_assignments, e.g. "_3001_1".'),
        file_id: z
          .string()
          .optional()
          .describe('Which file, when a content item has several (a file_id or file_name from available_files).'),
        offset: z.number().int().min(0).optional().describe('Character offset to continue a long file (from next_offset).'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      try {
        const cacheKey = `attachtext:${args.course_id}:${args.content_id}:${args.file_id ?? ''}`;
        let fetched = args.offset ? globalCache.get<Fetched>(cacheKey) : undefined;
        if (!fetched) {
          fetched = await ctx.callBB(async (http): Promise<Fetched> => {
            const course = await findCourse(http, args.course_id);
            // The content listing already carries each file's name, type and
            // download link. Same options as read_link's course scan, so the
            // two share one cached listing.
            const items = await getCourseContent(http, course.id, { depth: 4, maxItems: 800, includeAttachments: false });
            const item = items.find((i) => i.id === args.content_id);
            let refs = item?.attachments ?? [];
            if (refs.length === 0) {
              refs = await listContentFiles(http, course.id, args.content_id, item?.descriptionHtml).catch(() => []);
            }
            const chosen =
              refs.length > 0
                ? args.file_id
                  ? refs.find((r) => r.fileId === args.file_id) ?? refs.find((r) => r.fileName === args.file_id)
                  : refs[0]
                : undefined;
            const subfolder = course.courseCode ?? course.id;
            const saved = chosen
              ? await downloadAttachmentRef(http, chosen, { subfolder })
              : await downloadAttachment(http, { courseId: course.id, contentId: args.content_id, fileId: args.file_id, subfolder });
            const extracted = saved.bytes ? await extractText(saved.bytes, saved.fileName, saved.mimeType) : null;
            const { bytes: _bytes, ...rest } = saved;
            return { saved: rest, extracted, available: refs, chosen };
          });
          if (fetched.extracted?.text) globalCache.set(cacheKey, fetched, TEXT_CACHE_MS);
        }

        const { saved, extracted, available, chosen } = fetched;
        const page = extracted?.text ? textWindow(extracted.text, args.offset ?? 0) : null;
        const others = available.filter((a) => a !== chosen);
        return jsonResult({
          path: saved.path,
          file_name: saved.fileName,
          size_bytes: saved.sizeBytes,
          mime_type: saved.mimeType ?? null,
          format: extracted?.format ?? null,
          text: page?.text ?? null,
          offset: page?.offset,
          total_chars: page?.total_chars,
          next_offset: page?.next_offset ?? null,
          available_files: available.map((a) => ({ file_id: a.fileId ?? null, file_name: a.fileName ?? null })),
          note: [
            page ? null : 'This file type has no readable text (for example an image or video); it was saved locally.',
            !args.file_id && others.length > 0
              ? `This item has ${available.length} files; this is the first. Pass file_id (or a file_name from available_files) for the others.`
              : null,
          ]
            .filter(Boolean)
            .join(' ') || undefined,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
