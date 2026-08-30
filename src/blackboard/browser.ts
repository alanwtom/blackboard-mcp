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
  return /singleton|process.*still.*running|profile directory is already in use/i.test(msg);
}

function isChannelMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /executable doesn't exist|can't find.*chrome|chrome.*not found/i.test(msg);
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
    if (isProfileBusyError(err)) {
      throw new BlackboardError(
        'BROWSER_PROFILE_BUSY',
        'The Blackboard browser profile is already in use by another blackboard-mcp process (CLI or MCP server). Close that process and try again.',
      );
    }
    if (isChannelMissingError(err) && CHROME_CHANNEL === 'chrome') {
      throw new BlackboardError(
        'BROWSER_LAUNCH_FAILED',
        'Google Chrome was not found. Install Chrome, or set BB_BROWSER_CHANNEL=chromium and run: npx playwright install chromium',
      );
    }
    throw new BlackboardError('BROWSER_LAUNCH_FAILED', `Failed to launch browser: ${err instanceof Error ? err.message : String(err)}`);
  }
}
