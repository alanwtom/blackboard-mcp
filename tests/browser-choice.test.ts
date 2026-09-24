import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { canDownloadBrowser, chooseBrowser, downloadPrivateBrowser } from '../src/blackboard/browser.js';
import { paths, readMeta, writeMeta } from '../src/storage/session-store.js';
import { BROWSER_PREFERENCE, installedBrowsers, isBrowserInstalled } from '../src/platform.js';

let saved: string | undefined;
beforeEach(() => {
  process.env.BLACKBOARD_MCP_HOME = path.join(os.tmpdir(), `bb-mcp-browser-${process.pid}-${Math.random()}`);
  saved = process.env.BB_BROWSER_CHANNEL;
  delete process.env.BB_BROWSER_CHANNEL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.BB_BROWSER_CHANNEL;
  else process.env.BB_BROWSER_CHANNEL = saved;
});

describe('choosing a browser', () => {
  it('prefers Chrome, then Edge, then the downloaded Chromium', () => {
    expect(BROWSER_PREFERENCE).toEqual(['chrome', 'msedge', 'chromium']);
    const found = installedBrowsers();
    expect(found).toEqual(BROWSER_PREFERENCE.filter((b) => found.includes(b)));
  });

  it('gives every browser its own profile folder, keeping Chrome’s original one', () => {
    expect(path.basename(paths.profileDirFor('chrome'))).toBe('chrome-profile');
    expect(path.basename(paths.profileDirFor('msedge'))).toBe('msedge-profile');
    expect(new Set(paths.allProfileDirs).size).toBe(3);
  });

  it.runIf(installedBrowsers().length > 0)('picks the best installed browser and remembers it', async () => {
    const picked = await chooseBrowser();
    expect(picked).toBe(installedBrowsers()[0]);
    expect((await readMeta()).browser).toBe(picked);
  });

  it.runIf(isBrowserInstalled('msedge'))('keeps using the browser a machine was set up with', async () => {
    await writeMeta({ browser: 'msedge' });
    expect(await chooseBrowser()).toBe('msedge');
  });

  it.runIf(installedBrowsers().length > 0 && !isBrowserInstalled('chromium'))(
    'moves on when the remembered browser is gone',
    async () => {
      await writeMeta({ browser: 'chromium' });
      expect(await chooseBrowser()).toBe(installedBrowsers()[0]);
    },
  );

  it('honours a forced choice', async () => {
    process.env.BB_BROWSER_CHANNEL = 'msedge';
    expect(await chooseBrowser()).toBe('msedge');
  });
});

describe('downloading a browser', () => {
  it('never tries inside Claude Desktop, where starting "node" would start the Claude app', async () => {
    const versions = process.versions as Record<string, string | undefined>;
    const had = Object.getOwnPropertyDescriptor(process.versions, 'electron');
    Object.defineProperty(process.versions, 'electron', { value: '44.4.3', configurable: true });
    try {
      expect(canDownloadBrowser()).toBe(false);
      expect(await downloadPrivateBrowser()).toBe(false);
    } finally {
      if (had) Object.defineProperty(process.versions, 'electron', had);
      else delete versions.electron;
    }
    expect(canDownloadBrowser()).toBe(true);
  });
});
