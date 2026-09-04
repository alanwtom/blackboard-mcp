import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { classifyLaunchError } from '../src/blackboard/browser.js';
import {
  IS_WINDOWS,
  chromeInstallCandidates,
  claudeDesktopConfigPath,
  findExecutable,
  runCommand,
} from '../src/platform.js';

// The exact text Playwright produces on Windows when Chrome refuses to open a
// user-data-dir that another process already holds. Captured from a real run:
// Chrome logs nothing about the lock and exits with code 21, so the only
// evidence is the control pipe closing.
const WINDOWS_PROFILE_BUSY = [
  'browserType.launchPersistentContext: Target page, context or browser has been closed',
  'Browser logs:',
  '',
  '<launching> C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe --disable-field-trial-config --user-data-dir=C:\\Users\\student\\.blackboard-mcp\\chrome-profile',
  '<launched> pid=18688',
  'Call log:',
  '  - [pid=18688] <process did exit: exitCode=21, signal=null>',
].join('\n');

const POSIX_PROFILE_BUSY =
  'browserType.launchPersistentContext: Failed to create SingletonLock: profile directory is already in use';

describe('classifyLaunchError', () => {
  it('recognises a locked profile on Windows', () => {
    const err = classifyLaunchError(new Error(WINDOWS_PROFILE_BUSY));
    expect(err.code).toBe('BROWSER_PROFILE_BUSY');
  });

  it('recognises a locked profile on macOS and Linux', () => {
    expect(classifyLaunchError(new Error(POSIX_PROFILE_BUSY)).code).toBe('BROWSER_PROFILE_BUSY');
  });

  it('recognises a missing Chrome on either platform wording', () => {
    const windows = new Error(
      "browserType.launchPersistentContext: Chromium distribution 'chrome' is not found at C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    );
    const mac = new Error("browserType.launchPersistentContext: Chromium distribution 'chrome' is not found at /Applications/Google Chrome.app");
    for (const err of [windows, mac]) {
      const classified = classifyLaunchError(err);
      expect(classified.code).toBe('BROWSER_LAUNCH_FAILED');
      expect(classified.message).toContain('Google Chrome was not found');
    }
  });

  it('keeps the message short instead of dumping the Chrome command line', () => {
    const noisy = new Error(`Something broke\n${'--some-chrome-flag '.repeat(400)}`);
    const classified = classifyLaunchError(noisy);
    expect(classified.message).toBe('Failed to launch browser: Something broke');
  });
});

describe('platform lookups', () => {
  it('points at this OS\'s Claude Desktop config', () => {
    const configPath = claudeDesktopConfigPath();
    expect(path.basename(configPath)).toBe('claude_desktop_config.json');
    expect(path.isAbsolute(configPath)).toBe(true);
    if (IS_WINDOWS) expect(configPath).toContain('AppData');
  });

  it('lists absolute Chrome install candidates for this OS', () => {
    const candidates = chromeInstallCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => path.isAbsolute(c))).toBe(true);
    if (IS_WINDOWS) expect(candidates.every((c) => c.endsWith('chrome.exe'))).toBe(true);
  });

  it('finds node on PATH and misses a command that does not exist', () => {
    expect(findExecutable('node')).toBeTruthy();
    expect(findExecutable('definitely-not-a-real-command-xyz')).toBeNull();
  });

  it.runIf(IS_WINDOWS)('prefers a runnable shim over the extensionless one', () => {
    // `where npx` lists ...\npx (a shell script Node cannot execute) before
    // ...\npx.cmd, so resolution must skip to the PATHEXT match.
    const npx = findExecutable('npx');
    expect(npx).toBeTruthy();
    const pathExt = (process.env.PATHEXT ?? '').toLowerCase();
    expect(pathExt).toContain(path.extname(npx as string).toLowerCase());
  });

  it.runIf(IS_WINDOWS)('executes a .cmd shim whose path contains spaces', () => {
    const npx = findExecutable('npx') as string;
    const result = runCommand(npx, ['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\./);
  });

  it('runs a command and captures its output', () => {
    const result = runCommand(process.execPath, ['-e', 'process.stdout.write("hi")']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('hi');
  });
});
