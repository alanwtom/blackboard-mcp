import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clearProfile,
  hasProfileData,
  hasSession,
  hasStoredCookies,
  paths,
  saveCookies,
} from '../src/storage/session-store.js';

const COOKIE = {
  name: 'BbRouter',
  value: 'expires:0,id:example,signature:example',
  domain: 'blackboard.syr.edu',
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
};

let home: string;

beforeEach(async () => {
  home = path.join(os.tmpdir(), `bb-session-state-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.BLACKBOARD_MCP_HOME = home;
  await fs.mkdir(home, { recursive: true });
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  delete process.env.BLACKBOARD_MCP_HOME;
});

describe('hasSession', () => {
  it('is false on a genuinely fresh machine', async () => {
    expect(await hasSession()).toBe(false);
  });

  it('is true from the cookie snapshot alone, with no browser profile', async () => {
    // Carrying browser-state.json to a new machine is enough to be signed in:
    // the Chrome profile is rebuilt on first launch. Reporting "no session"
    // here sent a signed-in student back through NetID and Duo for nothing.
    await saveCookies([COOKIE]);
    expect(await hasProfileData()).toBe(false);
    expect(await hasStoredCookies()).toBe(true);
    expect(await hasSession()).toBe(true);
  });

  it('is true from a browser profile alone', async () => {
    await fs.mkdir(paths.profileDir, { recursive: true });
    await fs.writeFile(path.join(paths.profileDir, 'Preferences'), '{}');
    expect(await hasStoredCookies()).toBe(false);
    expect(await hasSession()).toBe(true);
  });
});

describe('blackboardHome', () => {
  it('keeps every path absolute so a session is never written to the working directory', async () => {
    const { blackboardHome, paths } = await import('../src/storage/session-store.js');
    for (const blank of ['', '   ']) {
      process.env.BLACKBOARD_MCP_HOME = blank;
      expect(path.isAbsolute(blackboardHome())).toBe(true);
      // A relative cookie file would land in the repo, where it is one
      // `git add .` away from publishing a live session.
      expect(path.isAbsolute(paths.browserStateFile)).toBe(true);
    }
    process.env.BLACKBOARD_MCP_HOME = home;
  });

  it('honours a real override', async () => {
    const { blackboardHome } = await import('../src/storage/session-store.js');
    process.env.BLACKBOARD_MCP_HOME = home;
    expect(blackboardHome()).toBe(path.resolve(home));
  });
});

describe('logout', () => {
  it('erases the cookie snapshot even when no profile directory exists', async () => {
    // `logout` used to report "nothing to remove" in this state and leave a
    // live session on disk — the one promise a logout has to keep.
    await saveCookies([COOKIE]);
    expect(await hasSession()).toBe(true);

    await clearProfile();

    expect(await hasStoredCookies()).toBe(false);
    expect(await hasSession()).toBe(false);
    await expect(fs.access(paths.browserStateFile)).rejects.toThrow();
  });
});
