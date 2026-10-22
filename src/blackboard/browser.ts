import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { BlackboardError } from './errors.js';
import { ensureDirs, paths, readMeta, writeMeta } from '../storage/session-store.js';
import { BROWSER_NAMES, installedBrowsers, isBrowserInstalled, type BrowserId } from '../platform.js';

/**
 * Which browser to drive: Chrome, else Edge, else the private Chromium setup
 * can download. Its profile under ~/.blackboard-mcp holds the session — it
 * is NOT the student's everyday browser profile, so their personal browsing,
 * cookies, and saved passwords stay untouched.
 *
 * Once a machine has used one, it keeps using it (its sign-ins live in that
 * browser's profile), unless it disappears. BB_BROWSER_CHANNEL forces one.
 */
export async function chooseBrowser(): Promise<string> {
  const forced = process.env.BB_BROWSER_CHANNEL?.trim();
  if (forced) return forced;
  const meta = await readMeta().catch(() => ({}) as { browser?: string });
  if (meta.browser && isBrowserInstalled(meta.browser as BrowserId)) return meta.browser;
  const first = installedBrowsers()[0];
  if (!first) {
    throw new BlackboardError(
      'BROWSER_NOT_INSTALLED',
      'No browser this tool can use was found (it needs Google Chrome, Microsoft Edge, or its own downloaded Chromium).',
    );
  }
  await writeMeta({ browser: first }).catch(() => undefined);
  return first;
}

let downloading: Promise<boolean> | null = null;
let lastDownloadFailed = false;
const DOWNLOAD_TIME_LIMIT_MS = 10 * 60_000;

/**
 * Whether this process can start the browser download at all. Inside Claude
 * Desktop the tool runs in the app's own process (Electron), and "starting
 * Node" there means starting the Claude app itself — a test did exactly
 * that and opened extra copies of Claude. So there the student is asked to
 * install Chrome instead; only a normal Node (terminal installs) downloads.
 */
export function canDownloadBrowser(): boolean {
  return !process.versions.electron;
}

/** True once, after a download attempt failed, so the student hears about it. */
export function takeDownloadFailure(): boolean {
  const failed = lastDownloadFailed;
  lastDownloadFailed = false;
  return failed;
}

/**
 * Fetch the tool's own Chromium in the background (no Chrome or Edge on this
 * computer), so the student is only told to ask again in a minute or two.
 * One download at a time, stopped after ten minutes; a failure is reported
 * on the next question (see takeDownloadFailure) rather than hidden.
 */
export function downloadPrivateBrowser(): Promise<boolean> {
  if (downloading) return downloading;
  if (!canDownloadBrowser()) return Promise.resolve(false);
  const attempt = new Promise<boolean>((resolve) => {
    let cli: string;
    try {
      cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
    } catch {
      resolve(false);
      return;
    }
    // Output is discarded: in the MCP server stdout is the protocol channel.
    // The environment is passed through so this works under the Node that
    // ships inside Claude Desktop as well as a normal one.
    const child = spawn(process.execPath, [cli, 'install', '--no-shell', 'chromium'], { stdio: 'ignore', env: process.env });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, DOWNLOAD_TIME_LIMIT_MS);
    timer.unref();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && isBrowserInstalled('chromium'));
    });
  });
  downloading = attempt.then((ok) => {
    downloading = null;
    if (!ok) lastDownloadFailed = true;
    return ok;
  });
  return downloading;
}

export function isDownloadingBrowser(): boolean {
  return downloading !== null;
}

export function browserName(id: string): string {
  return BROWSER_NAMES[id as BrowserId] ?? id;
}

function isProfileBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/singleton|process.*still.*running|profile directory is already in use/i.test(msg)) return true;
  // Windows locks the user-data-dir with a plain lockfile instead of the POSIX
  // SingletonLock symlink: Chrome prints nothing and exits with code 21, so
  // Playwright only reports the control pipe closing. Without this branch a
  // second blackboard-mcp process looks like a random crash.
  return /has been closed/i.test(msg) && /exitCode=21\b/.test(msg);
}

/**
 * A bare Linux install often lacks the shared libraries Chromium links against
 * (libnspr4, libnss3, ...). Playwright reports that in the browser log, not on
 * the first line, so this checks the whole message.
 */
function isMissingSystemLibraryError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /error while loading shared libraries|cannot open shared object file/i.test(msg);
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
export function classifyLaunchError(err: unknown, browser = 'chrome'): BlackboardError {
  if (isProfileBusyError(err)) {
    return new BlackboardError(
      'BROWSER_PROFILE_BUSY',
      'Blackboard is already open in another app (for example Claude Desktop and Claude Code at the same time). ' +
        'It lets go after 5 idle minutes; or quit the other app and try again.',
    );
  }
  if (isMissingSystemLibraryError(err)) {
    return new BlackboardError(
      'BROWSER_LAUNCH_FAILED',
      `${browserName(browser)} is missing system libraries on this Linux computer. ` +
        'Run this once in the project folder, then try again: sudo npx playwright install-deps chromium',
    );
  }
  if (isChannelMissingError(err)) {
    return new BlackboardError(
      'BROWSER_LAUNCH_FAILED',
      `${browserName(browser)} could not be found any more. Ask again and another browser will be used (or downloaded).`,
    );
  }
  return new BlackboardError('BROWSER_LAUNCH_FAILED', `Failed to launch browser: ${launchFailureSummary(err)}`);
}

export async function launchBrowser(opts: { headless?: boolean } = {}): Promise<BrowserContext> {
  await ensureDirs();
  const headless = opts.headless ?? true;
  const browser = await chooseBrowser();
  try {
    return await chromium.launchPersistentContext(paths.profileDirFor(browser), {
      // "chromium" is the downloaded copy, run in the same full headless mode.
      channel: browser,
      headless,
      acceptDownloads: true,
      viewport: { width: 1440, height: 900 },
      timeout: 60_000,
    });
  } catch (err) {
    throw classifyLaunchError(err, browser);
  }
}
