import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/**
 * All persistent state lives under ~/.blackboard-mcp, outside the repository.
 * The Chrome profile directory IS the stored authentication state: cookies and
 * browser storage stay in the normal browser profile, are never serialized
 * into other files, and are never exposed through MCP or logs.
 */
export function blackboardHome() {
    // An override that is present but blank must not be honoured: `??` would
    // accept "" and every path below would become relative, writing the cookie
    // snapshot into whatever directory the command happened to run from.
    const override = process.env.BLACKBOARD_MCP_HOME?.trim();
    if (override)
        return path.resolve(override);
    return path.join(os.homedir(), '.blackboard-mcp');
}
export const paths = {
    get home() {
        return blackboardHome();
    },
    /** Chrome's profile (the original name, kept so existing sign-ins carry over). */
    get profileDir() {
        return path.join(blackboardHome(), 'chrome-profile');
    },
    /**
     * One profile folder per browser. Chrome and Edge must never share one:
     * each would try to upgrade the other's files in its own way.
     */
    profileDirFor(browser) {
        return path.join(blackboardHome(), browser === 'chrome' ? 'chrome-profile' : `${browser.replace(/[^a-z0-9-]/gi, '')}-profile`);
    },
    get allProfileDirs() {
        return ['chrome', 'msedge', 'chromium'].map((b) => this.profileDirFor(b));
    },
    get downloadsDir() {
        return path.join(blackboardHome(), 'downloads');
    },
    get metaFile() {
        return path.join(blackboardHome(), 'session-meta.json');
    },
    get browserStateFile() {
        return path.join(blackboardHome(), 'browser-state.json');
    },
    get lastDiscoverFile() {
        return path.join(blackboardHome(), 'discover-last.txt');
    },
};
export async function ensureDirs() {
    await fs.mkdir(blackboardHome(), { recursive: true });
    await fs.mkdir(paths.downloadsDir, { recursive: true });
}
export async function hasProfileData() {
    for (const dir of paths.allProfileDirs) {
        try {
            if ((await fs.readdir(dir)).length > 0)
                return true;
        }
        catch {
            /* not created */
        }
    }
    return false;
}
/** Sites the student signed into with `npm run connect` (e.g. "zoom.us"). */
export async function connectedSites() {
    const meta = await readMeta().catch(() => ({}));
    return Array.isArray(meta.connectedSites) ? meta.connectedSites : [];
}
export async function readMeta() {
    try {
        const raw = await fs.readFile(paths.metaFile, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
export async function writeMeta(patch) {
    await ensureDirs();
    const merged = { ...(await readMeta()), ...patch };
    await fs.writeFile(paths.metaFile, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
}
export async function saveCookies(cookies) {
    await ensureDirs();
    const payload = JSON.stringify({ savedAt: new Date().toISOString(), cookies }, null, 2);
    // Write-then-rename: a crash mid-write must not leave half a file behind,
    // which would read as "no cookies" and quietly sign the student out.
    const tmp = `${paths.browserStateFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    try {
        await fs.rename(tmp, paths.browserStateFile);
    }
    catch (err) {
        // Windows refuses the rename while another process has the file open;
        // do not leave a stray copy of the cookies behind.
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
    }
    // The mode above only applies when a file is created; tighten an older one too.
    await fs.chmod(paths.browserStateFile, 0o600).catch(() => undefined);
}
export async function loadCookies() {
    try {
        const raw = await fs.readFile(paths.browserStateFile, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed.cookies) ? parsed.cookies : [];
    }
    catch {
        return [];
    }
}
export async function hasStoredCookies() {
    return (await loadCookies()).length > 0;
}
/**
 * Whether any Blackboard session state exists on this machine.
 *
 * The cookie snapshot alone is enough to be signed in — the Chrome profile is
 * a cache that gets rebuilt on first launch, not the credential. Gating on the
 * profile directory alone therefore got both directions wrong: a student who
 * carried their session to a new machine was told to log in again, and
 * `logout` reported nothing to remove while leaving live cookies on disk.
 */
export async function hasSession() {
    if (await hasProfileData())
        return true;
    return hasStoredCookies();
}
/**
 * Whether a Chrome is using the profile right now (the AI app's server, or
 * another npm run command). Chrome marks the profile with a SingletonLock
 * link naming "host-pid"; a lock left by a crashed Chrome names a dead pid.
 */
export async function isProfileInUse() {
    for (const dir of paths.allProfileDirs) {
        if (await isDirInUse(dir))
            return true;
    }
    return false;
}
async function isDirInUse(dir) {
    try {
        const target = await fs.readlink(path.join(dir, 'SingletonLock'));
        const pid = Number(/-(\d+)$/.exec(target)?.[1]);
        if (!pid)
            return true;
        try {
            process.kill(pid, 0);
            return true;
        }
        catch (err) {
            return err.code === 'EPERM';
        }
    }
    catch {
        return false; // no lock (or Windows, which reports busy as EBUSY on delete)
    }
}
/**
 * Wipes the saved session (logout). The cookie snapshot goes first: it alone
 * is enough to be signed in, so it must not survive a profile delete that
 * fails half way (Windows refuses to delete files an open Chrome holds).
 */
export async function clearProfile() {
    await fs.rm(paths.browserStateFile, { force: true });
    await fs.rm(paths.metaFile, { force: true });
    for (const dir of paths.allProfileDirs)
        await fs.rm(dir, { recursive: true, force: true });
}
