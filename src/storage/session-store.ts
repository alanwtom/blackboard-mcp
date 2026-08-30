import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * All persistent state lives under ~/.blackboard-mcp, outside the repository.
 * The Chrome profile directory IS the stored authentication state: cookies and
 * browser storage stay in the normal browser profile, are never serialized
 * into other files, and are never exposed through MCP or logs.
 */
export function blackboardHome(): string {
  return process.env.BLACKBOARD_MCP_HOME ?? path.join(os.homedir(), '.blackboard-mcp');
}

export const paths = {
  get home(): string {
    return blackboardHome();
  },
  get profileDir(): string {
    return path.join(blackboardHome(), 'chrome-profile');
  },
  get downloadsDir(): string {
    return path.join(blackboardHome(), 'downloads');
  },
  get metaFile(): string {
    return path.join(blackboardHome(), 'session-meta.json');
  },
  get browserStateFile(): string {
    return path.join(blackboardHome(), 'browser-state.json');
  },
  get lastDiscoverFile(): string {
    return path.join(blackboardHome(), 'discover-last.txt');
  },
};

export async function ensureDirs(): Promise<void> {
  await fs.mkdir(blackboardHome(), { recursive: true });
  await fs.mkdir(paths.downloadsDir, { recursive: true });
}

export async function hasProfileData(): Promise<boolean> {
  try {
    const entries = await fs.readdir(paths.profileDir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

export interface SessionMeta {
  lastLoginAt?: string;
  lastVerifiedAt?: string;
  displayName?: string;
  userName?: string;
  /** Origin (e.g. "https://blackboard.syracuse.edu") that holds the session. */
  authOrigin?: string;
}

export async function readMeta(): Promise<SessionMeta> {
  try {
    const raw = await fs.readFile(paths.metaFile, 'utf8');
    const parsed = JSON.parse(raw) as SessionMeta;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeMeta(patch: SessionMeta): Promise<SessionMeta> {
  await ensureDirs();
  const merged = { ...(await readMeta()), ...patch };
  await fs.writeFile(paths.metaFile, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

/**
 * Cookie snapshot taken from the authenticated browser after each successful
 * verification. Blackboard's session cookie does not survive a browser
 * restart, so this file carries the session between runs. It is just as
 * sensitive as the profile's own cookie store: local-only under
 * ~/.blackboard-mcp, 0600 permissions, gitignored, never exposed through MCP.
 */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}

export async function saveCookies(cookies: StoredCookie[]): Promise<void> {
  await ensureDirs();
  const payload = JSON.stringify({ savedAt: new Date().toISOString(), cookies }, null, 2);
  await fs.writeFile(paths.browserStateFile, payload, { encoding: 'utf8', mode: 0o600 });
}

export async function loadCookies(): Promise<StoredCookie[]> {
  try {
    const raw = await fs.readFile(paths.browserStateFile, 'utf8');
    const parsed = JSON.parse(raw) as { cookies?: StoredCookie[] };
    return Array.isArray(parsed.cookies) ? parsed.cookies : [];
  } catch {
    return [];
  }
}

export async function hasStoredCookies(): Promise<boolean> {
  return (await loadCookies()).length > 0;
}

/** Wipes the dedicated browser profile (logout). Requires no active browser. */
export async function clearProfile(): Promise<void> {
  await fs.rm(paths.profileDir, { recursive: true, force: true });
  await fs.rm(paths.metaFile, { force: true });
  await fs.rm(paths.browserStateFile, { force: true });
}
