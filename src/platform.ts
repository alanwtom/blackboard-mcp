import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Per-OS details the rest of the project should not have to know about:
 * where Chrome and Claude Desktop keep their files, and how to invoke a
 * command-line tool. Everything else in the codebase is platform-neutral.
 */
export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

/**
 * Browsers the tool can drive, in the order it prefers them. All three are
 * Chrome underneath. Edge ships with every copy of Windows 10/11, so Windows
 * students never need Chrome; "chromium" is the private copy setup can
 * download for anyone (typically a Safari-only Mac) who has neither.
 */
export type BrowserId = 'chrome' | 'msedge' | 'chromium';
export const BROWSER_PREFERENCE: BrowserId[] = ['chrome', 'msedge', 'chromium'];
export const BROWSER_NAMES: Record<BrowserId, string> = {
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  chromium: 'Chromium (downloaded for blackboard-mcp)',
};

/** Standard Edge install locations, most likely first. */
export function edgeInstallCandidates(): string[] {
  if (IS_WINDOWS) {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(
      (r): r is string => typeof r === 'string' && r.length > 0,
    );
    return roots.map((root) => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  if (IS_MAC) return ['/Applications/Microsoft Edge.app'];
  return ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'];
}

/** Whether a given browser is available to launch right now. */
export function isBrowserInstalled(id: BrowserId): boolean {
  // Test switch: behave like a Safari-only Mac, so the automatic browser
  // download can be exercised on a machine that has Chrome.
  if (process.env.BB_PRETEND_NO_BROWSERS === '1' && id !== 'chromium') return false;
  if (id === 'chrome') return isChromeInstalled();
  if (id === 'msedge') return edgeInstallCandidates().some((p) => fs.existsSync(p));
  try {
    // Playwright writes this marker last; without it (a download cut off
    // part-way) the browser may be half-unpacked and would never launch.
    const exe = chromium.executablePath();
    const dir = exe.split(path.sep).findIndex((part) => /^chromium-\d+$/.test(part));
    const root = dir >= 0 ? exe.split(path.sep).slice(0, dir + 1).join(path.sep) : path.dirname(exe);
    return fs.existsSync(exe) && fs.existsSync(path.join(root, 'INSTALLATION_COMPLETE'));
  } catch {
    return false;
  }
}

/** Installed browsers, most preferred first. */
export function installedBrowsers(): BrowserId[] {
  return BROWSER_PREFERENCE.filter((id) => isBrowserInstalled(id));
}

/** Standard Chrome install locations, most likely first. */
export function chromeInstallCandidates(): string[] {
  if (IS_WINDOWS) {
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.ProgramW6432,
      process.env.LOCALAPPDATA,
    ].filter((r): r is string => typeof r === 'string' && r.length > 0);
    return roots.map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (IS_MAC) {
    // Only /Applications: Playwright looks for Chrome there and nowhere else,
    // so a copy in ~/Applications passed this check and then failed to launch.
    return ['/Applications/Google Chrome.app'];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
}

export function isChromeInstalled(): boolean {
  if (chromeInstallCandidates().some((p) => fs.existsSync(p))) return true;
  // Linux distributions move the binary around; fall back to PATH lookup.
  return !IS_WINDOWS && !IS_MAC && findExecutable('google-chrome') !== null;
}

/** Where Claude Desktop stores the MCP server list on this OS. */
export function claudeDesktopConfigPath(): string {
  if (IS_WINDOWS) {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  if (IS_MAC) {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

/** "Quit completely" means different keystrokes on different desktops. */
export function quitAppHint(): string {
  if (IS_WINDOWS) return 'Quit it completely (right-click the icon in the system tray and choose Quit, not just the window X)';
  if (IS_MAC) return 'Quit it completely (Cmd + Q)';
  return 'Quit it completely';
}

/**
 * Resolve a command on PATH. Windows has no `which`, and `where` lists every
 * match: for an npm-installed CLI that is the extensionless shell shim first
 * and the runnable `name.cmd` second. Picking the first line would hand Node a
 * file it cannot execute, so a PATHEXT extension wins.
 */
export function findExecutable(name: string): string | null {
  const probe = spawnSync(IS_WINDOWS ? 'where.exe' : 'which', [name], { encoding: 'utf8' });
  if (probe.status !== 0 || !probe.stdout) return null;
  const matches = probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (matches.length === 0) return null;
  if (!IS_WINDOWS) return matches[0] ?? null;
  const pathExt = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith('.'));
  const runnable = matches.find((match) => pathExt.includes(path.extname(match).toLowerCase()));
  return runnable ?? matches[0] ?? null;
}

function quoteForCmd(value: string): string {
  return /[\s&()[\]{}^=;!'+,`~%<>|"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Run a command-line tool and capture its result. On Windows most Node tools
 * are `.cmd` shims, which Node refuses to spawn directly, so those go through
 * cmd.exe with each argument quoted (project paths often contain spaces).
 */
export function runCommand(
  file: string,
  args: string[],
  opts: { cwd?: string; stdio?: 'inherit' | 'pipe' } = {},
): { status: number; stdout: string; stderr: string } {
  const common = { cwd: opts.cwd, encoding: 'utf8' as const, stdio: opts.stdio ?? 'pipe' };
  const needsShell = IS_WINDOWS && /\.(cmd|bat)$/i.test(file);
  const result = needsShell
    ? spawnSync([file, ...args].map(quoteForCmd).join(' '), { ...common, shell: true })
    : spawnSync(file, args, common);
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * The TypeScript compiler shipped in node_modules, invoked as a plain script
 * so no `npx` / `.cmd` shim is involved on any platform.
 */
export function localTscScript(projectRoot: string): string | null {
  const candidate = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  return fs.existsSync(candidate) ? candidate : null;
}
