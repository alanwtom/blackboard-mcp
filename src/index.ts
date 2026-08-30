import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BlackboardSession, type BBHttp } from './blackboard/session.js';
import { BlackboardError, isBlackboardError } from './blackboard/errors.js';
import { registerCourseTools } from './tools/courses.js';
import { registerContentTools } from './tools/content.js';
import { registerAnnouncementTools } from './tools/announcements.js';
import { registerAssignmentTools } from './tools/assignments.js';
import { registerGradeTools } from './tools/grades.js';
import { registerAttachmentTools } from './tools/attachments.js';
import { registerStudentTools } from './tools/student.js';
import type { BBToolContext } from './tools/util.js';

export const VERSION = '0.1.0';

export function createBlackboardServer(callBB: BBToolContext['callBB']): McpServer {
  const server = new McpServer({ name: 'blackboard-mcp', version: VERSION });
  const ctx: BBToolContext = { callBB };
  registerCourseTools(server, ctx);
  registerContentTools(server, ctx);
  registerAnnouncementTools(server, ctx);
  registerAssignmentTools(server, ctx);
  registerGradeTools(server, ctx);
  registerAttachmentTools(server, ctx);
  registerStudentTools(server, ctx);
  return server;
}

// ---------------------------------------------------------------------------
// Session lifecycle: at most one browser at a time, shared across tool calls,
// closed after an idle timeout so the server stays quiet between requests.
// ---------------------------------------------------------------------------

const IDLE_CLOSE_MS = 5 * 60_000;

let session: BlackboardSession | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void closeSession();
  }, IDLE_CLOSE_MS);
  idleTimer.unref();
}

async function closeSession(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const current = session;
  session = null;
  if (current) await current.close();
}

let acquiring: Promise<BlackboardSession> | null = null;

async function getBB(): Promise<BlackboardSession> {
  if (session) {
    scheduleIdleClose();
    return session;
  }
  // Single-flight: concurrent tool calls must not each launch a browser on
  // the same profile.
  if (!acquiring) {
    acquiring = (async () => {
      const s = await BlackboardSession.acquire({ headless: process.env.BB_HEADLESS !== '0' });
      // Validate (and silently re-establish via SSO if possible) before the
      // first tool call, so tools never start from an unauthenticated session.
      const identity = await s.probe().catch(() => null);
      if (!identity) {
        await s.close();
        throw BlackboardError.sessionExpired();
      }
      return s;
    })()
      .then((s) => {
        session = s;
        return s;
      })
      .finally(() => {
        acquiring = null;
      });
  }
  const s = await acquiring;
  scheduleIdleClose();
  return s;
}

export async function callBB<T>(fn: (http: BBHttp) => Promise<T>): Promise<T> {
  try {
    return await fn(await getBB());
  } catch (err) {
    // Drop the browser on auth failures so the next call starts fresh after
    // the student re-logs in with npm run login.
    if (
      isBlackboardError(err) &&
      (err.code === 'BLACKBOARD_SESSION_EXPIRED' ||
        err.code === 'NOT_LOGGED_IN' ||
        err.code === 'BROWSER_PROFILE_BUSY')
    ) {
      await closeSession();
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const server = createBlackboardServer(callBB);
  await server.connect(new StdioServerTransport());
  // Everything logged here goes to stderr; stdout carries only MCP protocol.
  console.error('blackboard-mcp: running on stdio (local-first, read-only)');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.on('unhandledRejection', (err) => {
    console.error('blackboard-mcp: unhandled rejection:', err);
  });
  main().catch((err) => {
    console.error('blackboard-mcp failed to start:', err);
    process.exit(1);
  });
}
