/**
 * Normalized internal types. These are the shapes exposed to the MCP layer and
 * CLI. Raw Blackboard API payloads never leak past the blackboard/ modules.
 */

export interface Course {
  /** Blackboard internal course id (primary key), e.g. "_26184_1". */
  id: string;
  name: string;
  /** Blackboard external course key, e.g. "CIS.473.M001.FALL2026". */
  courseCode?: string;
  instructor?: string;
  role?: string;
  term?: string;
  startDate?: string;
  endDate?: string;
  available: boolean;
  url?: string;
  /** When the student last opened the course (from enrollment data). */
  lastAccessed?: string;
}

export type ContentItemType =
  | 'folder'
  | 'document'
  | 'file'
  | 'assignment'
  | 'test'
  | 'survey'
  | 'link'
  | 'page'
  | 'other';

export type AttachmentSource = 'files-api' | 'description' | 'handler';

export interface AttachmentRef {
  /** Blackboard file id, when known. */
  fileId?: string;
  courseId: string;
  contentId: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Same-origin URL (path or absolute) usable with the student's session. */
  url?: string;
  source: AttachmentSource;
}

export interface ContentItem {
  id: string;
  courseId: string;
  title: string;
  type: ContentItemType;
  /** Parent folder id — present when Blackboard returns a flat listing. */
  parentId?: string;
  descriptionHtml?: string;
  descriptionText?: string;
  /** External link target, Ultra redirect link, or course outline URL. */
  url?: string;
  dueDate?: string;
  pointsPossible?: number;
  hasChildren: boolean;
  attachments: AttachmentRef[];
  position?: number;
  modified?: string;
}

export interface Announcement {
  id: string;
  courseId: string;
  title: string;
  bodyText: string;
  bodyHtml?: string;
  created?: string;
  modified?: string;
  url?: string;
}

export type AssignmentStatus = 'not_submitted' | 'submitted' | 'graded' | 'unknown';

export type AssignmentCategory = 'assignment' | 'test' | 'gradebook-column' | 'calendar-item';

export interface Assignment {
  /** Blackboard content id when known (e.g. "_3010_1"); falls back to a slug. */
  id: string;
  /** "<courseId>:<contentId>" — unambiguous reference for get_assignment_context. */
  ref: string;
  courseId: string;
  courseName?: string;
  title: string;
  descriptionText?: string;
  dueDate?: string;
  pointsPossible?: number;
  status?: AssignmentStatus;
  category: AssignmentCategory;
  url?: string;
}

export type GradingStatus = 'graded' | 'not_graded' | 'exempt' | 'unknown';

export interface GradeEntry {
  /** Stable id: "<courseId>:<columnId>". */
  id: string;
  courseId: string;
  columnId: string;
  title: string;
  dueDate?: string;
  score?: number;
  pointsPossible?: number;
  percentage?: number;
  feedback?: string;
  gradingStatus: GradingStatus;
  modified?: string;
}

export interface BBIdentity {
  userId: string;
  userName?: string;
  displayName?: string;
}

export interface CalendarItem {
  id: string;
  courseId?: string;
  title?: string;
  type?: string;
  startDate?: string;
  endDate?: string;
}

export interface AttachmentSaveResult {
  path: string;
  fileName: string;
  sizeBytes: number;
  mimeType?: string;
  /** Included for small text-like files so the agent can read inline. */
  textExcerpt?: string;
}
