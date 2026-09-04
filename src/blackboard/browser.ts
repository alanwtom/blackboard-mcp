import { chromium, type BrowserContext } from 'playwright';
import { BlackboardError } from './errors.js';
import { ensureDirs, paths } from '../storage/session-store.js';

/**
 * Chrome is required (the project standard). The dedicated profile directory
 * under ~/.blackboard-mcp/chrome-profile holds the authenticated session —
 * it is NOT the student's normal Chrome profile, so the student's personal
 * browsing, cookies, and saved passwords stay untouched.
 */
export const CHROME_CHANNEL = process.env.BB_BROWSER_CHANNEL ?? 'chrome';

function isProfileBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/singleton|process.*still.*running|profile directory is already in use/i.test(msg)) return true;
  // Windows locks the user-data-dir with a plain lockfile instead of the POSIX
  // SingletonLock symlink: Chrome prints nothing and exits with code 21, so
  // Playwright only reports the control pipe closing. Without this branch a
  // second blackboard-mcp process looks like a random crash.
  return /has been closed/i.test(msg) && /exitCode=21\b/.test(msg);
}

function isChannelMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /executable doesn't exist|can't find.*chrome|chrome.*(?:not found|is not found at)/i.test(msg);
}

/**
 * Playwright appends the full Chrome command line and browser log to launch
 * failures — several kilobytes of flags on Windows. Only the first line says
 * anything useful to a student.
 */
function launchFailureSummary(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0]?.trim() || 'unknown error';
}

/** Turn a raw Playwright launch failure into a coded, student-readable error. */
export function classifyLaunchError(err: unknown): BlackboardError {
  if (isProfileBusyError(err)) {
    return new BlackboardError(
      'BROWSER_PROFILE_BUSY',
      'The Blackboard browser profile is already in use by another blackboard-mcp process (CLI or MCP server). Close that process and try again.',
    );
  }
  if (isChannelMissingError(err) && CHROME_CHANNEL === 'chrome') {
    return new BlackboardError(
      'BROWSER_LAUNCH_FAILED',
      'Google Chrome was not found. Install it from https://www.google.com/chrome/, or set BB_BROWSER_CHANNEL=chromium and run: npx playwright install chromium',
    );
  }
  return new BlackboardError('BROWSER_LAUNCH_FAILED', `Failed to launch browser: ${launchFailureSummary(err)}`);
}

export async function launchBrowser(opts: { headless?: boolean } = {}): Promise<BrowserContext> {
  await ensureDirs();
  const headless = opts.headless ?? true;
  try {
    return await chromium.launchPersistentContext(paths.profileDir, {
      channel: CHROME_CHANNEL,
      headless,
      acceptDownloads: true,
      viewport: { width: 1440, height: 900 },
      timeout: 60_000,
    });
  } catch (err) {
    throw classifyLaunchError(err);
  }
}
