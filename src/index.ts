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
import { registerLinkTools } from './tools/links.js';
import type { BBToolContext } from './tools/util.js';

export const VERSION = '0.1.0';

export function createBlackboardServer(
  callBB: BBToolContext['callBB'],
  openSignIn?: BBToolContext['openSignIn'],
): McpServer {
  const server = new McpServer({ name: 'blackboard-mcp', version: VERSION });
  const ctx: BBToolContext = { callBB, openSignIn };
  registerCourseTools(server, ctx);
  registerContentTools(server, ctx);
  registerAnnouncementTools(server, ctx);
  registerAssignmentTools(server, ctx);
  registerGradeTools(server, ctx);
  registerAttachmentTools(server, ctx);
  registerStudentTools(server, ctx);
  registerLinkTools(server, ctx);
  return server;
}

// ---------------------------------------------------------------------------
// Session lifecycle: at most one browser at a time, shared across tool calls,
// closed after an idle timeout so the server stays quiet between requests.
// ---------------------------------------------------------------------------

const IDLE_CLOSE_MS = 5 * 60_000;

let session: BlackboardSession | null = null;
let idleTimer: NodeJS.Timeout | null = null;
/** Tool calls currently using the browser; the idle close waits for zero. */
let inFlight = 0;
/** A close in progress. A new launch must wait for it, or Chrome still holds the profile. */
let closing: Promise<void> | null = null;

/** A sign-in window left open is closed after this long anyway. */
const SIGN_IN_WINDOW_MAX_MS = 20 * 60_000;
let signInOpenedAt = 0;

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Never pull the browser out from under a call that is still running
    // (a large download can take minutes), or from a student who is still
    // signing in; check again later instead.
    const signingIn = session?.hasOpenSignInTab() && Date.now() - signInOpenedAt < SIGN_IN_WINDOW_MAX_MS;
    if (inFlight > 0 || signingIn) scheduleIdleClose();
    else void closeSession(undefined, { force: true });
  }, IDLE_CLOSE_MS);
  idleTimer.unref();
}

/**
 * Close the shared browser. With `only`, close it only if it is still that
 * browser: a call that failed on an old browser must not close the fresh one
 * another call has just started using.
 */
function closeSession(only?: BlackboardSession, opts: { force?: boolean } = {}): Promise<void> {
  if (only && session !== only) return closing ?? Promise.resolve();
  // A student mid-sign-in keeps their window; failures elsewhere must not
  // snatch it away (the retry path closes sessions on errors).
  if (!opts.force && session?.hasOpenSignInTab()) return closing ?? Promise.resolve();
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const current = session;
  session = null;
  if (!current) return closing ?? Promise.resolve();
  const done = current.close().finally(() => {
    if (closing === done) closing = null;
  });
  closing = done;
  return done;
}

let acquiring: Promise<BlackboardSession> | null = null;

async function getBB(): Promise<BlackboardSession> {
  if (session && session.isAlive()) {
    scheduleIdleClose();
    return session;
  }
  // Chrome crashed or was closed: forget it and start a fresh one.
  if (session) await closeSession();
  if (closing) await closing;
  // Single-flight: concurrent tool calls must not each launch a browser on
  // the same profile.
  if (!acquiring) {
    acquiring = (async () => {
      const s = await BlackboardSession.acquire({ headless: process.env.BB_HEADLESS !== '0' });
      // Validate (and silently re-establish via SSO if possible) before the
      // first tool call, so tools never start from an unauthenticated session.
      const identity = await s.probe().catch(() => null);
      if (!identity) {
        const offline = s.isOffline();
        await s.close();
        // Being offline is not being logged out: telling a student on a
        // captive-portal Wi-Fi to "log in again" sends them the wrong way.
        if (offline) throw BlackboardError.unreachable();
        throw BlackboardError.sessionExpired();
      }
      s.onClose(() => {
        if (session === s) session = null;
      });
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

/**
 * Show the student a real Chrome window on a link that needs a sign-in.
 *
 * The shared browser runs hidden, and Chrome allows one window per profile,
 * so the hidden one is swapped for a visible one (with the Blackboard
 * session carried over), a tab opens on the link, and once the student
 * closes that tab the next question goes back to a hidden browser. Nothing
 * is typed for them. Returns "busy" rather than interrupting other questions
 * that are still running.
 */
export async function openSignIn(url: string, service: string): Promise<'opened' | 'busy'> {
  if (inFlight > 0) return 'busy';
  const onClosed = (s: BlackboardSession) => (): void => {
    // Back to hidden once the last sign-in tab is gone (unless still in use).
    setTimeout(() => {
      if (!s.hasOpenSignInTab() && inFlight === 0) void closeSession(s, { force: true });
    }, 1_500);
  };
  let s = session && session.isAlive() && !session.isHeadless ? session : null;
  if (!s) {
    await closeSession(undefined, { force: true });
    if (closing) await closing;
    s = await BlackboardSession.acquire({ headless: false });
    const fresh = s;
    fresh.onClose(() => {
      if (session === fresh) session = null;
    });
    // Other questions keep working in this window while it is open.
    session = fresh;
  }
  signInOpenedAt = Date.now();
  await s.openSignInTab(url, service, onClosed(s));
  scheduleIdleClose();
  return 'opened';
}

/** Playwright's wording when the browser, context or page has gone away. */
function isBrowserGone(err: unknown): boolean {
  if (isBlackboardError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /has been closed|Target closed|browser has disconnected|Browser closed/i.test(msg);
}

export async function callBB<T>(fn: (http: BBHttp) => Promise<T>): Promise<T> {
  inFlight += 1;
  /** The browser this call last ran on; failures close that one only. */
  let used: BlackboardSession | undefined;
  try {
    // Failures to start (including "session expired" from the start-up
    // check, which already tried a silent re-sign-in) are not retried:
    // repeating that check only doubled how long "please log in" took.
    const http = await getBB();
    used = http;
    try {
      return await fn(http);
    } catch (err) {
      // Two failures are worth one quiet retry with a fresh browser: Chrome
      // disappearing mid-call, and the Blackboard session lapsing mid-use
      // (a fresh launch re-signs in silently through SSO when it can).
      const expired = isBlackboardError(err) && err.code === 'BLACKBOARD_SESSION_EXPIRED';
      if (isBrowserGone(err) || expired) {
        await closeSession(http);
        used = await getBB();
        return await fn(used);
      }
      throw err;
    }
  } catch (err) {
    // Drop the browser on auth failures so the next call starts fresh after
    // the student re-logs in with npm run login.
    if (
      isBlackboardError(err) &&
      (err.code === 'BLACKBOARD_SESSION_EXPIRED' ||
        err.code === 'NOT_LOGGED_IN' ||
        err.code === 'BROWSER_PROFILE_BUSY')
    ) {
      await closeSession(used);
    }
    if (isBrowserGone(err)) {
      await closeSession(used);
      throw new BlackboardError('BLACKBOARD_REQUEST_FAILED', 'The browser closed unexpectedly. Please ask again.');
    }
    throw err;
  } finally {
    inFlight -= 1;
  }
}

/**
 * Release the browser the moment the AI app goes away. Without this, Chrome
 * kept the profile locked for up to five minutes after the app quit, and a
 * reopened app (or npm run login) hit "profile busy".
 */
function exitWhenClientLeaves(): void {
  let exiting = false;
  const shutdown = (): void => {
    if (exiting) return;
    exiting = true;
    void closeSession(undefined, { force: true }).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * stdout carries the MCP protocol and nothing else. Any library that prints
 * (pdf.js warnings on odd PDFs did, mid-response) corrupts the stream the AI
 * app is reading, so all console output is sent to stderr instead.
 */
function keepStdoutForProtocol(): void {
  const toStderr = (...args: unknown[]): void => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;
}

async function main(): Promise<void> {
  keepStdoutForProtocol();
  const server = createBlackboardServer(callBB, openSignIn);
  await server.connect(new StdioServerTransport());
  exitWhenClientLeaves();
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
