import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { BrowserContext, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { BlackboardError, isBlackboardError, truncate } from './errors.js';
import { isBlackboardHost, isDownloadHost, BLACKBOARD_HOSTS } from './hosts.js';
import type { BBIdentity } from './types.js';
import { connectedSites, readMeta, writeMeta, loadCookies, saveCookies } from '../storage/session-store.js';

export const BASE_URL = process.env.BB_BASE_URL ?? 'https://blackboard.syr.edu';

/**
 * Syracuse's "SU NetID Login" SAML entry (the target of #netid-login on the
 * login page). Following it re-establishes the Blackboard session silently
 * whenever the browser's persistent Microsoft session allows it — no
 * credentials are ever entered by this tool.
 */
const SSO_ENTRY_URL =
  process.env.BB_SSO_ENTRY_URL ??
  'https://blackboard.syracuse.edu/auth-saml/saml/login?apId=_3987_1&redirectUrl=https%3A%2F%2Fblackboard.syracuse.edu%2Fultra%2Fcourses';

export { BLACKBOARD_HOSTS } from './hosts.js';

/** A red banner (and tab title) that says what to do in this tab. Pure UI aid. */
async function markPage(page: Page, instruction: string): Promise<void> {
  await page
    .evaluate(
      `((text) => {
        const title = '▶ SIGN IN HERE — blackboard-mcp';
        if (document.title !== title) document.title = title;
        if (document.body && !document.getElementById('bbmcp-login-banner')) {
          const banner = document.createElement('div');
          banner.id = 'bbmcp-login-banner';
          banner.textContent = '▶ blackboard-mcp: ' + text;
          banner.style.cssText =
            'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#c5221f;color:#fff;padding:12px 18px;font:600 15px/1.4 -apple-system,system-ui,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:none;';
          document.body.appendChild(banner);
        }
      })(${JSON.stringify(instruction)})`,
    )
    .catch(() => undefined);
}

/**
 * Record the sites a sign-in touched so their cookies are kept across
 * restarts (many sign-ins, Zoom's included, are session cookies that Chrome
 * drops when it closes).
 *
 * Google is left out on purpose: its sign-in cookies already last for years
 * inside the profile, and a copy in a plain file would be a key to the
 * student's whole Google account. Microsoft and Blackboard are always kept.
 */
export async function rememberConnectedSites(hosts: string[]): Promise<void> {
  const sites = new Set(await connectedSites());
  const before = sites.size;
  for (const host of hosts) {
    const site = host.toLowerCase().split('.').slice(-2).join('.');
    if (!site.includes('.') || /^(google|gstatic|googleusercontent|youtube)\.com$/.test(site)) continue;
    sites.add(site);
  }
  if (sites.size !== before) await writeMeta({ connectedSites: [...sites] }).catch(() => undefined);
}

/** Cookie domains worth carrying across browser restarts (see saveSnapshot). */
export function isSnapshotCookieDomain(domain: string, extraSites: string[] = []): boolean {
  const d = domain.replace(/^\./, '').toLowerCase();
  const keep = [...BLACKBOARD_HOSTS, 'syr.edu', 'syracuse.edu', 'login.microsoftonline.com', 'microsoftonline.com', 'login.live.com', ...extraSites];
  return keep.some((k) => d === k || d.endsWith(`.${k}`));
}

/** Serialized init that survives page.evaluate's structured clone. */
export interface BBRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface BBJsonResponse {
  status: number;
  contentType: string | null;
  text: string;
  url: string;
}

export interface BBBufferResponse {
  status: number;
  contentType: string | null;
  bytes: Buffer;
  filename?: string;
}

/**
 * Minimal HTTP surface the blackboard domain modules depend on. Implemented by
 * BlackboardSession; tests substitute fakes.
 */
export interface BBHttp {
  fetchJson(path: string, init?: BBRequestInit): Promise<BBJsonResponse>;
  fetchBuffer(pathOrUrl: string): Promise<BBBufferResponse>;
  /** Normalize a returned pagination href to a same-origin path. */
  toSameOriginPath(href: string): string;
  /** Resolve an /ultra/redirect link through the real page and capture the file. */
  captureRedirectDownload(pathOrUrl: string, timeoutMs?: number): Promise<BBBufferResponse>;
  /**
   * Outside sites (Google, Zoom, OneDrive, ...), reached with the dedicated
   * browser's own sign-ins. Optional so test fakes that only model Blackboard
   * stay small; link tools report a clear error when it is missing.
   */
  external?: ExternalHttp;
}

export interface ExternalResponse {
  status: number;
  contentType: string | null;
  bytes: Buffer;
  /** Where the request ended up after redirects. */
  finalUrl: string;
  filename?: string;
}

export interface RenderedPage {
  finalUrl: string;
  title: string;
  /** What a person would read on the page (main content first). */
  text: string;
  /** Links on the rendered page, absolute URLs. */
  links: { url: string; label?: string }[];
  /** JSON/text responses the page loaded whose URL matched `capture`. */
  captured: { url: string; status: number; body: string }[];
  /** Set when the page tried to navigate to a file instead of a page. */
  fileUrl?: string;
  /** Result of the optional in-page script. */
  evaluated?: unknown;
}

export interface RenderOptions {
  /** Keep the bodies of responses whose URL matches (e.g. a player's info API). */
  capture?: RegExp;
  /** Script (a function body returning a value) to run once the page settles. */
  evaluate?: string;
  /** Extra settle time after load, for pages that fetch their content late. */
  settleMs?: number;
}

export interface ExternalHttp {
  /** Plain GET with the dedicated browser's cookies; redirects are checked hop by hop. */
  fetch(url: string, opts?: { maxBytes?: number }): Promise<ExternalResponse>;
  /** Open the page in a real tab, let it render, and read what it shows. */
  render(url: string, opts?: RenderOptions): Promise<RenderedPage>;
}

/**
 * Hosts an outside link must never reach: this machine and private networks.
 * A professor's link is a public web page; anything pointing inward is either
 * a mistake or an attempt to use the student's browser as a way in.
 */
export function isPrivateHost(hostname: string): boolean {
  // "localhost." (trailing dot) is still localhost to the resolver.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) {
    // IPv6 literal: anything starting "::" (loopback, unspecified, IPv4-
    // compatible and IPv4-mapped forms), link-local and site-local (fe80–
    // feff), unique-local (fc/fd), and NAT64 (64:ff9b::), which can wrap
    // any IPv4 address including private ones.
    return h.startsWith('::') || /^fe[89a-f]/.test(h) || /^f[cd]/.test(h) || h.startsWith('64:ff9b:');
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

const resolvedPrivate = new Map<string, Promise<boolean>>();

/**
 * Whether a hostname resolves to a private address. A public-looking name
 * can still point at 192.168.x.x; checking the name alone missed that.
 * Cached per host for the life of the process. A name that does not resolve
 * is not "private" — the request will simply fail.
 */
export function resolvesToPrivate(hostname: string): Promise<boolean> {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (isPrivateHost(h)) return Promise.resolve(true);
  if (isIP(h)) return Promise.resolve(false);
  let hit = resolvedPrivate.get(h);
  if (!hit) {
    hit = lookup(h, { all: true })
      .then((addrs) => addrs.some((a) => isPrivateHost(a.address)))
      .catch(() => false);
    resolvedPrivate.set(h, hit);
  }
  return hit;
}

/** Like assertPublicUrl, and also refuses names that resolve to private addresses. */
export async function assertPublicDestination(raw: string): Promise<URL> {
  const u = assertPublicUrl(raw);
  if (await resolvesToPrivate(u.hostname)) {
    throw new BlackboardError('INVALID_INPUT', 'Refusing to open a link to this computer or a private network.');
  }
  return u;
}

/** Parse Set-Cookie headers into cookies the browser context can store. */
type NewCookie = Parameters<BrowserContext['addCookies']>[0][number];

export function parseSetCookies(headers: string[], url: string): NewCookie[] {
  const out: NewCookie[] = [];
  const host = new URL(url).hostname;
  for (const header of headers) {
    const [pair, ...attrs] = header.split(';');
    const eq = pair?.indexOf('=') ?? -1;
    if (!pair || eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let domain: string | undefined;
    let cookiePath = '/';
    let expires = -1;
    let secure = false;
    let httpOnly = false;
    let sameSite: 'Strict' | 'Lax' | 'None' | undefined;
    for (const attr of attrs) {
      const [k, ...v] = attr.split('=');
      const key = (k ?? '').trim().toLowerCase();
      const val = v.join('=').trim();
      if (key === 'domain' && val) domain = val.replace(/^\./, '');
      else if (key === 'path' && val) cookiePath = val;
      else if (key === 'max-age' && val) expires = Math.floor(Date.now() / 1000) + Number(val);
      else if (key === 'expires' && val && expires === -1) {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) expires = Math.floor(t / 1000);
      } else if (key === 'secure') secure = true;
      else if (key === 'httponly') httpOnly = true;
      else if (key === 'samesite') {
        const s = val.toLowerCase();
        sameSite = s === 'strict' ? 'Strict' : s === 'none' ? 'None' : 'Lax';
      }
    }
    // A cookie may only be set for the responding host or a parent of it.
    if (domain && host !== domain && !host.endsWith(`.${domain}`)) continue;
    out.push({
      name,
      value,
      domain: domain ? `.${domain}` : host,
      path: cookiePath,
      expires,
      secure,
      httpOnly,
      ...(sameSite ? { sameSite } : {}),
    });
  }
  return out;
}

/** Throws unless the URL is an ordinary public http(s) address. */
export function assertPublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlackboardError('INVALID_INPUT', 'That is not a valid web address.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new BlackboardError('INVALID_INPUT', `Only web links can be opened (got ${u.protocol}).`);
  }
  if (isPrivateHost(u.hostname)) {
    throw new BlackboardError('INVALID_INPUT', 'Refusing to open a link to this computer or a private network.');
  }
  return u;
}

interface EvaluateResult {
  status: number;
  contentType: string | null;
  text: string;
  url: string;
  error?: string;
}

function looksLikeLoginPage(url: URL): boolean {
  if (!isBlackboardHost(url)) return true;
  const p = url.pathname;
  return p.startsWith('/webapps/login') || p.startsWith('/login') || p === '/ultra/session-expired';
}

/**
 * Hard ceiling on a single attachment. Shared with the attachment writer so
 * the limit is enforced once on the declared size (before buffering) and once
 * on the real size (after), rather than drifting between the two.
 */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/**
 * How long the page may sit idle before we conclude a download link is never
 * going to resolve. Progress resets it, so this is a quiet period, not a
 * deadline — see the wait loop in resolveDownloadUrls.
 */
const RESOLVE_QUIET_MS = 6_000;

/** Ceiling on one hostname, for a page that keeps chattering without resolving. */
const ORIGIN_CAP_MS = 25_000;

/** A main-frame navigation to one of these is a file, not a page to render. */
const FILE_PATH = /\.(pdf|docx?|pptx?|xlsx?|zip|mp4|mov|m4a|mp3|ipynb|csv|txt)$/i;

/**
 * True when a URL is the file itself rather than an app or API route.
 *
 * Blackboard's own hostnames serve the whole web app, and some of its API
 * endpoints (telemetry, in particular) answer with a file-ish content type —
 * so on those hosts only /bbcswebdav/ is ever a real attachment. Anything
 * else has to be on the content CDN, which serves nothing but files.
 */
export function isFileCandidateUrl(url: URL): boolean {
  if (!isDownloadHost(url)) return false;
  if (isBlackboardHost(url)) return url.pathname.startsWith('/bbcswebdav/');
  return true;
}

/**
 * Whether a request the page is about to make is the attachment link itself.
 *
 * The decisive test is `isNavigation`. The file is always a main-frame
 * navigation; everything else the page pulls in is noise — and that noise is
 * not distinguishable by content type, because the Ultra error page serves its
 * campus banner from the same CDN with `Content-Disposition: inline;
 * filename=...`. Without the navigation check a failed download quietly
 * yields a PNG of the quad instead of an error.
 *
 * Pure, so the rule is testable without driving a browser.
 */
export function isFileNavigation(r: { isNavigation: boolean; url: URL }): boolean {
  if (!r.isNavigation) return false;
  return isFileCandidateUrl(r.url);
}

function parseContentDispositionFilename(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const utf8 = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1].trim());
    } catch {
      return utf8[1].trim();
    }
  }
  const plain = /filename="?([^";]+)"?/.exec(header);
  return plain ? plain[1].trim() : undefined;
}

/**
 * One authenticated Blackboard browsing session.
 *
 * Requests are made through a page running on blackboard.syr.edu so every call
 * is identical to what the Blackboard web app itself sends (same cookies,
 * same origin, browser-generated headers). Nothing about credentials is ever
 * read, logged, or stored outside the browser profile.
 */
export class BlackboardSession implements BBHttp {
  private constructor(
    private readonly context: BrowserContext,
    private worker: Page | null = null,
    private readonly headless: boolean = true,
    /** Origin that actually holds the session (persisted after login/probe). */
    private authOrigin: string | null = null,
  ) {}

  /** Processes queue here so the profile is never opened twice concurrently. */
  private static launchChain: Promise<unknown> = Promise.resolve();

  static acquire(opts: { headless?: boolean } = {}): Promise<BlackboardSession> {
    const task = BlackboardSession.launchChain.then(
      () => BlackboardSession.doAcquire(opts),
      () => BlackboardSession.doAcquire(opts),
    );
    BlackboardSession.launchChain = task.catch(() => undefined);
    return task;
  }

  private static async doAcquire(opts: { headless?: boolean }): Promise<BlackboardSession> {
    const context = await launchBrowser({ headless: opts.headless ?? true });
    const session = new BlackboardSession(context, null, opts.headless ?? true);
    const meta = await readMeta().catch(() => ({}) as { authOrigin?: string });
    if (meta.authOrigin) session.authOrigin = meta.authOrigin;
    // Restore the cookie snapshot: Blackboard's session cookie does not
    // survive a browser restart on its own.
    const cookies = await loadCookies();
    if (cookies.length > 0) {
      await context
        .addCookies(cookies as unknown as Parameters<BrowserContext['addCookies']>[0])
        .catch(() => undefined);
    }
    return session;
  }

  get isHeadless(): boolean {
    return this.headless;
  }

  private closed = false;

  /** False once Chrome has gone away (crash, window closed, killed). */
  isAlive(): boolean {
    if (this.closed) return false;
    try {
      const browser = this.context.browser();
      return browser ? browser.isConnected() : true;
    } catch {
      return false;
    }
  }

  onClose(cb: () => void): void {
    this.context.on('close', () => {
      this.closed = true;
      cb();
    });
  }

  /**
   * True when the last navigation never reached any web page: no network,
   * DNS failure, or a timeout. Chrome leaves the tab on about:blank or its
   * own error page in that case.
   */
  isOffline(): boolean {
    try {
      const url = this.worker && !this.worker.isClosed() ? this.worker.url() : this.context.pages()[0]?.url() ?? '';
      return !/^https?:/.test(url);
    } catch {
      return false;
    }
  }

  private workerBuilding: Promise<Page> | null = null;

  /** True once the worker page exists and sits on a real web page. */
  async ensureWorker(preferredOrigin?: string): Promise<Page> {
    // Parallel requests share one rebuild instead of each opening a page.
    if (this.workerBuilding) return this.workerBuilding;
    this.workerBuilding = this.buildWorker(preferredOrigin).finally(() => {
      this.workerBuilding = null;
    });
    return this.workerBuilding;
  }

  private async buildWorker(preferredOrigin?: string): Promise<Page> {
    if (this.worker && !this.worker.isClosed()) {
      const url = new URL(this.worker.url());
      // Any real page counts — including an SSO page the student is mid-way
      // through. Never yank the page out from under an in-flight login.
      if (url.protocol === 'https:' || url.protocol === 'http:') return this.worker;
      this.worker = null;
    }
    const target = preferredOrigin ?? this.authOrigin ?? BASE_URL;
    const pages = this.context.pages();
    const page = pages.length > 0 ? pages[0] : await this.context.newPage();
    await page.goto(`${target}/ultra/courses`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
    this.worker = page;
    return page;
  }

  /**
   * Make sure we are actually logged in. Throws NOT_LOGGED_IN when the browser
   * sits on an SSO/login page. Never attempts any credential entry or MFA
   * automation — re-authentication is always the student, in a visible window.
   */
  async ensureReady(): Promise<void> {
    const page = await this.ensureWorker();
    const url = new URL(page.url());
    if (looksLikeLoginPage(url)) {
      throw BlackboardError.notLoggedIn();
    }
  }

  /**
   * Start the SSO flow in the dedicated window: navigate to the classic login
   * entry, which forwards to the institution's sign-in provider. Only
   * navigation — the student types every credential themselves.
   */
  async startLoginFlow(): Promise<void> {
    const page = await this.ensureWorker();
    await page
      .goto(`${BASE_URL}/webapps/login?new_loc=%2Fultra%2Fcourses`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      })
      .catch(() => undefined);
  }

  /**
   * Poll passively until the student finishes SSO + Duo. No automation of
   * credentials. Watches every tab of the dedicated window without ever
   * navigating them, so the student's login flow is never interrupted.
   */
  async waitForLogin(opts: { timeoutMs?: number; onTick?: (status: string) => void } = {}): Promise<BBIdentity> {
    const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
    const deadline = Date.now() + timeoutMs;
    await this.ensureWorker();
    let lastReported = '';
    let lastState = '';
    while (Date.now() < deadline) {
      // On a Mac, closing the last window leaves Chrome running with no tabs
      // (no "close" event), so no open tabs also means the student closed it.
      if (this.closed || this.openPageCount() === 0) {
        throw new BlackboardError('NOT_LOGGED_IN', 'The sign-in window was closed before signing in. Ask again to reopen it.');
      }
      const pages = this.context.pages();

      const watched = pages[pages.length - 1];
      if (watched) {
        try {
          const u = new URL(watched.url());
          const where = `${u.host}${u.pathname}`;
          if (where !== lastReported) {
            lastReported = where;
            opts.onTick?.(`${looksLikeLoginPage(u) ? 'sign-in page' : 'page'} at ${where}`);
          }
        } catch {
          /* ignore */
        }
      }

      // Probe every open tab without navigating any of them — SSO sometimes
      // completes in a new tab.
      let identity: BBIdentity | null = null;
      let probeError = '';
      let sawLogin = false;
      let sawBlackboard = false;
      for (const p of pages) {
        let url: URL;
        try {
          url = new URL(p.url());
        } catch {
          continue;
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
        if (looksLikeLoginPage(url)) {
          sawLogin = true;
          continue;
        }
        if (!isBlackboardHost(url)) continue;
        sawBlackboard = true;
        const savedWorker = this.worker;
        this.worker = p;
        try {
          identity = await this.fetchMe();
        } catch (err) {
          probeError = err instanceof Error ? err.message : String(err);
        } finally {
          this.worker = savedWorker;
        }
        if (identity) {
          this.worker = p;
          break;
        }
      }

      if (identity) {
        await writeMeta({
          lastLoginAt: new Date().toISOString(),
          displayName: identity.displayName,
          userName: identity.userName,
          lastVerifiedAt: new Date().toISOString(),
        });
        return identity;
      }

      const state = sawLogin ? 'on-sign-in-page' : sawBlackboard ? (probeError ? 'probe-error' : 'not-signed-in') : 'no-pages';
      if (state !== lastState) {
        lastState = state;
        if (state === 'on-sign-in-page') {
          opts.onTick?.('Syracuse sign-in page is open — enter your NetID and approve Duo there; I will detect the moment you land back on Blackboard');
        } else if (state === 'not-signed-in') {
          opts.onTick?.('Blackboard is reachable but NOT signed in — click "Sign In" in this window and complete SSO + Duo here');
        } else if (state === 'probe-error') {
          opts.onTick?.(`can't verify the session yet (${truncate(probeError, 120)})`);
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new BlackboardError('NOT_LOGGED_IN', 'Timed out waiting for the Blackboard sign-in. Ask again to reopen the sign-in window.');
  }

  /**
   * Lightweight authenticated probe that may navigate across Syracuse's two
   * Blackboard hostnames to find the live session, and — when it can be done
   * silently — re-establish the Blackboard session through the institution's
   * SSO (the browser's persistent Microsoft session answers without any user
   * interaction). Used by headless flows.
   */
  async probe(opts: { ssoBounce?: boolean } = {}): Promise<BBIdentity | null> {
    const direct = await this.probeCandidates();
    if (direct) return direct;
    if (opts.ssoBounce === false) return null;
    // The Blackboard session cookie does not survive browser restarts, but
    // the SSO provider session usually does. Follow Syracuse's SAML entry: if
    // the provider re-authenticates silently, we come back logged in; if it
    // demands credentials, we land on its sign-in page and report exactly
    // that. No credential entry ever happens here.
    const page = await this.ensureWorker();
    await page.goto(SSO_ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
    // Wait to land back on Blackboard, but give up as soon as the page has
    // sat still on a non-Blackboard page (the sign-in form wanting a
    // password). A silent re-sign-in hops through the provider in about a
    // second per step; waiting the full 30 s made every "please log in"
    // answer slow enough for the AI app to time out first.
    const deadline = Date.now() + 30_000;
    let lastUrl = '';
    let stillSince = Date.now();
    while (Date.now() < deadline) {
      const now = page.url();
      if (/blackboard\.(syr|syracuse)\.edu\/(ultra|webapps\/portal)/.test(now)) break;
      if (now !== lastUrl) {
        lastUrl = now;
        stillSince = Date.now();
      } else if (Date.now() - stillSince > 5_000) {
        break;
      }
      await page.waitForTimeout(500).catch(() => undefined);
    }
    await page.waitForTimeout(1500).catch(() => undefined);
    const finalUrl = new URL(page.url());
    if (!isBlackboardHost(finalUrl) || looksLikeLoginPage(finalUrl)) return null;
    return this.probeCandidates();
  }

  /** Try each Blackboard hostname without triggering SSO. */
  private async probeCandidates(): Promise<BBIdentity | null> {
    for (const origin of this.probeOrigins()) {
      const page = await this.ensureWorker(origin);
      if (new URL(page.url()).origin !== origin) {
        await page.goto(`${origin}/ultra/courses`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
      }
      if (new URL(page.url()).origin !== origin) continue; // bounced to SSO or elsewhere
      // Any per-origin failure (401, CORS, SPA 404 pages) just means "not
      // this host" — move on to the next candidate.
      const identity = await this.fetchMe().catch(() => null);
      if (identity) return identity;
    }
    return null;
  }

  /** Probe without navigating: whatever page the worker is on right now. */
  async probeCurrentPage(): Promise<BBIdentity | null> {
    const page = await this.ensureWorker();
    if (looksLikeLoginPage(new URL(page.url()))) return null;
    return this.fetchMe();
  }

  /** Fetch /users/me from the worker's current origin; never navigates. */
  private async fetchMe(): Promise<BBIdentity | null> {
    const me = await this.fetchJson('/learn/api/public/v1/users/me');
    const originOf = (): string => {
      try {
        if (this.worker && !this.worker.isClosed()) return new URL(this.worker.url()).origin;
      } catch {
        /* fall through */
      }
      return new URL(BASE_URL).origin;
    };
    if (me.status === 200 && me.contentType?.includes('json')) {
      const data = JSON.parse(me.text) as Record<string, unknown>;
      const userId = typeof data.id === 'string' ? data.id : undefined;
      if (!userId) return null;
      const given = typeof data.givenName === 'string' ? data.givenName : '';
      const family = typeof data.familyName === 'string' ? data.familyName : '';
      await this.rememberAuthOrigin(originOf());
      return {
        userId,
        userName: typeof data.userName === 'string' ? data.userName : undefined,
        displayName: [given, family].filter(Boolean).join(' ') || undefined,
      };
    }
    if (me.status === 404 && me.contentType?.includes('json')) {
      // /users/me alias missing — try an authenticated courses call instead.
      const courses = await this.fetchJson('/learn/api/public/v1/courses?limit=1');
      if (courses.status === 200 && courses.contentType?.includes('json')) {
        await this.rememberAuthOrigin(originOf());
        return { userId: 'unknown' };
      }
    }
    return null;
  }

  /** Hostname candidates to try, most likely first. */
  private probeOrigins(): string[] {
    const list: string[] = [];
    const push = (origin: string | undefined | null): void => {
      if (origin && !list.includes(origin)) list.push(origin);
    };
    try {
      if (this.worker && !this.worker.isClosed()) {
        const current = new URL(this.worker.url());
        if (isBlackboardHost(current)) push(current.origin);
      }
    } catch {
      /* ignore */
    }
    push(this.authOrigin);
    push(new URL(BASE_URL).origin);
    for (const host of BLACKBOARD_HOSTS) push(`https://${host}`);
    return list;
  }

  private async rememberAuthOrigin(origin: string): Promise<void> {
    this.authOrigin = origin;
    await writeMeta({ authOrigin: origin }).catch(() => undefined);
    await this.saveSnapshot();
  }

  /**
   * Snapshot the sign-in cookies so the next launch stays signed in even
   * though Blackboard's session cookie is browser-session scoped.
   *
   * Only Blackboard's, the SU / Microsoft sign-in's, and sites the student
   * deliberately signed into with `npm run connect` are written. Anything
   * else the browser picked up while reading links stays out: copying it
   * into a plain JSON file would only widen what that one file gives away
   * if it ever leaked.
   */
  async saveSnapshot(): Promise<void> {
    const extra = await connectedSites();
    await this.context
      .storageState()
      .then((state) => saveCookies(state.cookies.filter((c) => isSnapshotCookieDomain(c.domain, extra))))
      .catch(() => undefined);
  }

  /** Hostnames of the tabs open right now (the connect CLI records them). */
  openPageHosts(): string[] {
    try {
      return this.context
        .pages()
        .map((p) => {
          try {
            return new URL(p.url()).hostname;
          } catch {
            return '';
          }
        })
        .filter((h) => h !== '');
    } catch {
      return [];
    }
  }

  /** How many tabs the window has open (the connect CLI waits for zero). */
  openPageCount(): number {
    try {
      return this.context.pages().length;
    } catch {
      return 0;
    }
  }

  private static async evaluateFetch(
    page: Page,
    payload: { url: string; init: { method: string; headers: Record<string, string>; body?: string } },
  ): Promise<EvaluateResult> {
    return page.evaluate(async ({ url, init: req }): Promise<EvaluateResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(url, {
          method: req.method,
          headers: { Accept: 'application/json', ...req.headers },
          body: req.body,
          credentials: 'include',
          signal: controller.signal,
        });
        const text = await res.text();
        return {
          status: res.status,
          contentType: res.headers.get('content-type'),
          text,
          url: res.url,
        };
      } catch (e) {
        return { status: 0, contentType: null, text: '', url: '', error: String(e) };
      } finally {
        clearTimeout(timer);
      }
    }, payload);
  }

  async fetchJson(path: string, init: BBRequestInit = {}): Promise<BBJsonResponse> {
    const reqInit = { method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body };
    let page = await this.ensureWorker();
    // Resolve against the page actually in use, after it exists: resolving
    // first could aim at one Blackboard hostname while the page sits on the
    // other, which the browser then blocks as cross-origin.
    let result: EvaluateResult;
    try {
      result = await BlackboardSession.evaluateFetch(page, { url: this.toSameOriginUrl(path), init: reqInit });
    } catch {
      // A navigation destroyed the page's script context mid-request. Let it
      // settle and retry once on the same page. Closing it here (as before)
      // also killed every other request running in parallel on it.
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
      page = await this.ensureWorker();
      try {
        result = await BlackboardSession.evaluateFetch(page, { url: this.toSameOriginUrl(path), init: reqInit });
      } catch {
        throw new BlackboardError('BLACKBOARD_REQUEST_FAILED', 'Blackboard reloaded in the middle of a request. Please try again.');
      }
    }
    if (result.error) {
      // The page was bounced to the sign-in provider: that is an expired
      // session, surfacing as a blocked cross-origin fetch.
      let onBlackboard = true;
      try {
        onBlackboard = isBlackboardHost(new URL(page.url()));
      } catch {
        /* keep true */
      }
      if (!onBlackboard) throw BlackboardError.sessionExpired('the Blackboard page was sent to the sign-in page');
      throw new BlackboardError('BLACKBOARD_REQUEST_FAILED', `Blackboard request failed: ${result.error}`);
    }
    return { status: result.status, contentType: result.contentType, text: result.text, url: result.url };
  }

  /**
   * Binary fetch (attachments). Uses the context's API request context, which
   * shares the same cookie jar as the logged-in browser session.
   */
  async fetchBuffer(pathOrUrl: string): Promise<BBBufferResponse> {
    await this.ensureWorker();
    const url = this.toSameOriginUrl(pathOrUrl);
    const res = await this.streamGet(url, { maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: 180_000, label: 'Attachment' });
    return { status: res.status, contentType: res.contentType, bytes: res.bytes, filename: res.filename };
  }

  private userAgent: string | null = null;

  /**
   * GET with the browser's cookies, streaming the body so the size limit is
   * enforced while downloading rather than after.
   *
   * Playwright's request API reads the whole response into memory before
   * returning, so a 2 GB lecture recording was fully buffered (or timed out)
   * before the 200 MB limit was ever checked. Redirects are followed one hop
   * at a time so every hop can be checked (`checkHop`) and gets the cookies
   * for its own host.
   */
  private async streamGet(
    url: string,
    opts: { maxBytes: number; timeoutMs: number; label: string; checkHop?: (u: URL) => void | Promise<void> },
  ): Promise<ExternalResponse> {
    if (!this.userAgent) {
      const page = this.context.pages()[0];
      this.userAgent = page ? await page.evaluate<string>('navigator.userAgent').catch(() => null) : null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    const tooBig = (mb?: number): BlackboardError =>
      new BlackboardError(
        'CONTENT_NOT_AVAILABLE',
        `${opts.label} is too large to download (${mb ? `${mb} MB, ` : 'over '}limit ${Math.round(opts.maxBytes / 1024 / 1024)} MB).`,
      );
    try {
      let current = url;
      for (let hop = 0; hop < 10; hop += 1) {
        await opts.checkHop?.(new URL(current));
        const cookies = await this.context.cookies(current);
        const headers: Record<string, string> = { Accept: '*/*' };
        if (cookies.length > 0) headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        if (this.userAgent) headers['User-Agent'] = this.userAgent;
        let res: Response;
        try {
          res = await fetch(current, { headers, redirect: 'manual', signal: controller.signal });
        } catch (err) {
          if (controller.signal.aborted) throw new BlackboardError('BLACKBOARD_REQUEST_FAILED', `${opts.label} download timed out.`);
          throw new BlackboardError('BLACKBOARD_REQUEST_FAILED', `${opts.label} download failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Keep cookies set along the way (share links often set one on the
        // redirect and expect it on the next hop), exactly as the browser would.
        const setCookies = res.headers.getSetCookie();
        if (setCookies.length > 0) {
          await this.context.addCookies(parseSetCookies(setCookies, current)).catch(() => undefined);
        }
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
          await res.body?.cancel().catch(() => undefined);
          current = new URL(location, current).toString();
          continue;
        }
        const declared = Number(res.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          await res.body?.cancel().catch(() => undefined);
          throw tooBig(Math.round(declared / 1024 / 1024));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > opts.maxBytes) {
              await reader.cancel().catch(() => undefined);
              throw tooBig();
            }
            chunks.push(Buffer.from(value));
          }
        }
        return {
          status: res.status,
          contentType: res.headers.get('content-type'),
          bytes: Buffer.concat(chunks),
          finalUrl: current,
          filename: parseContentDispositionFilename(res.headers.get('content-disposition') ?? undefined),
        };
      }
      throw new BlackboardError('BLACKBOARD_REQUEST_FAILED', `${opts.label} link redirected too many times.`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Resolve an /ultra/redirect content link and return the file's bytes.
   *
   * The link only exists at runtime: fetching it statically returns the Ultra
   * SPA shell, so the page has to follow it. But the page must not be allowed
   * to actually *load* the file it lands on. Two separate things go wrong if
   * it does:
   *
   *   - Reading the bytes back out of the response fails for anything large.
   *     Chromium buffers response bodies in a bounded "inspector cache" and
   *     evicts big ones, so response.body() throws "Request content was
   *     evicted from inspector cache" on exactly the big lecture decks this
   *     matters for.
   *   - Worse, a file served as an attachment becomes a browser download,
   *     which closes the tab — and on a persistent context that tears down
   *     the whole browser mid-call.
   *
   * So we intercept instead: watch for the main-frame navigation to the file,
   * record its URL, and abort it before a byte is transferred. Then fetch that
   * URL over HTTP through the same cookie jar, where there is no size ceiling
   * and nothing to race.
   */
  async captureRedirectDownload(pathOrUrl: string, timeoutMs = 45_000): Promise<BBBufferResponse> {
    const fileUrls = await this.resolveDownloadUrls(pathOrUrl, timeoutMs);

    // "Too large" is a real answer about the file, not a failed strategy —
    // hold it and report it rather than falling through to "not found".
    let sizeRefusal: unknown = null;
    for (const url of fileUrls) {
      const fetched = await this.fetchDownloadUrl(url).catch((err: unknown) => {
        if (isBlackboardError(err) && err.code === 'CONTENT_NOT_AVAILABLE') sizeRefusal = err;
        return null;
      });
      if (fetched && fetched.status === 200 && fetched.bytes.length > 0) {
        if (process.env.BB_DEBUG === '1') {
          console.error(`[bb-debug] fetched ${fetched.bytes.length}b from ${url.slice(0, 100)}`);
        }
        return fetched;
      }
    }
    if (sizeRefusal) throw sizeRefusal;

    throw new BlackboardError(
      'ATTACHMENT_NOT_FOUND',
      'Download link did not resolve to a file. The item may have been removed, or it may not be a downloadable attachment.',
    );
  }

  /**
   * Drive the SPA until it points the main frame at the file, collecting the
   * link(s) it aims for without letting any of them load.
   */
  private async resolveDownloadUrls(pathOrUrl: string, timeoutMs: number): Promise<string[]> {
    await this.ensureWorker();
    // A fresh page per download so no in-flight request from one capture can
    // leak into the next.
    const page = await this.context.newPage();
    const debug = process.env.BB_DEBUG === '1';
    const fileUrls: string[] = [];

    // How long the page has been doing nothing. Waiting a fixed number of
    // seconds does not work for both cases at once: a course item resolves in
    // about two seconds, while an organization site runs several LTI launches
    // and an OAuth handshake first and only reaches the file around ten. So
    // wait for as long as the page is still making requests, and give up once
    // it falls quiet.
    let lastActivity = Date.now();
    page.on('request', () => {
      lastActivity = Date.now();
    });

    await page.route('**/*', async (route, request) => {
      lastActivity = Date.now();
      try {
        if (isFileNavigation({ isNavigation: request.isNavigationRequest(), url: new URL(request.url()) })) {
          if (!fileUrls.includes(request.url())) {
            fileUrls.push(request.url());
            if (debug) console.error(`[bb-debug] file link ${request.url().slice(0, 110)}`);
          }
          // Abort rather than continue: loading it here would start a download
          // and take the browser down with it.
          await route.abort();
          return;
        }
      } catch {
        /* unparseable URL — treat as ordinary traffic */
      }
      await route.continue().catch(() => undefined);
    });

    try {
      const redirectUrl = new URL(pathOrUrl, BASE_URL);
      const redirectPath = `${redirectUrl.pathname}${redirectUrl.search}`;
      const overallDeadline = Date.now() + timeoutMs;

      // The webdav file store is per-hostname; try each Blackboard host until
      // one resolves the link.
      for (const origin of this.probeOrigins()) {
        const remaining = overallDeadline - Date.now();
        if (remaining <= 0) break;
        if (debug) console.error(`[bb-debug] trying ${origin}${redirectPath.slice(0, 60)}`);
        await page
          .goto(`${origin}${redirectPath}`, {
            waitUntil: 'domcontentloaded',
            timeout: Math.min(30_000, remaining),
          })
          .catch(() => undefined);

        // Wait while the page is still working, and stop once it goes quiet —
        // a dead link stops making requests, so this gives up promptly without
        // cutting off a slow-but-progressing resolve. ORIGIN_CAP_MS bounds the
        // pathological case of a page that never stops chattering.
        lastActivity = Date.now();
        const originDeadline = Math.min(Date.now() + ORIGIN_CAP_MS, overallDeadline);
        while (
          fileUrls.length === 0 &&
          Date.now() < originDeadline &&
          Date.now() - lastActivity < RESOLVE_QUIET_MS
        ) {
          await new Promise((r) => setTimeout(r, 250));
        }
        if (fileUrls.length > 0) break;
        if (debug) console.error(`[bb-debug] nothing from ${origin} (page at ${page.url().slice(0, 90)})`);
      }
    } finally {
      await page.close().catch(() => undefined);
    }
    return fileUrls;
  }

  /**
   * Fetch a resolved download link through the context's request API, which
   * shares the browser's cookie jar. May be cross-origin (the content CDN), so
   * the host is re-checked against the allowlist here as well.
   */
  private async fetchDownloadUrl(url: string): Promise<BBBufferResponse> {
    const parsed = new URL(url);
    if (!isFileCandidateUrl(parsed)) {
      throw new BlackboardError('INVALID_INPUT', `Refusing to fetch a download from ${parsed.hostname}${parsed.pathname}.`);
    }
    const res = await this.streamGet(url, { maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: 300_000, label: 'Attachment' });
    // An expired or unauthorized link comes back as an HTML page rather than a
    // 4xx, so treat HTML as "not the file" and let the caller move on.
    if ((res.contentType ?? '').includes('text/html')) {
      throw new BlackboardError('ATTACHMENT_NOT_FOUND', 'Download URL returned a page instead of a file.');
    }
    return { status: res.status, contentType: res.contentType, bytes: res.bytes, filename: res.filename };
  }

  readonly external: ExternalHttp = {
    fetch: (url, opts) => this.fetchExternal(url, opts),
    render: (url, opts) => this.renderExternal(url, opts),
  };

  /**
   * GET an outside URL through the browser's cookie jar, following redirects
   * one hop at a time so none of them can land on a private address.
   */
  private async fetchExternal(url: string, opts: { maxBytes?: number } = {}): Promise<ExternalResponse> {
    return this.streamGet(assertPublicUrl(url).toString(), {
      maxBytes: opts.maxBytes ?? MAX_DOWNLOAD_BYTES,
      timeoutMs: 180_000,
      label: 'That file',
      checkHop: async (u) => {
        await assertPublicDestination(u.toString());
      },
    });
  }

  /**
   * Open an outside page in its own tab and read it the way a person would.
   *
   * Same guard rails as attachment capture: a navigation to a file is noted
   * and aborted rather than allowed to become a browser download, requests to
   * private addresses are refused, and video/audio streams are skipped since
   * only the page (or its transcript) is wanted.
   */
  private async renderExternal(url: string, opts: RenderOptions = {}): Promise<RenderedPage> {
    await assertPublicDestination(url);
    const page = await this.context.newPage();
    // Popups escape the page's request guard and can start downloads; a
    // professor's page has no business opening new windows while being read.
    page.on('popup', (p) => void p.close().catch(() => undefined));
    await page
      .routeWebSocket(/.*/, async (ws) => {
        try {
          if (await resolvesToPrivate(new URL(ws.url()).hostname)) {
            await ws.close();
            return;
          }
        } catch {
          await ws.close().catch(() => undefined);
          return;
        }
        ws.connectToServer();
      })
      .catch(() => undefined);
    const captured: RenderedPage['captured'] = [];
    const pendingCaptures: Promise<void>[] = [];
    let fileUrl: string | undefined;
    let lastActivity = Date.now();

    await page.route('**/*', async (route, request) => {
      lastActivity = Date.now();
      try {
        const u = new URL(request.url());
        if ((u.protocol === 'http:' || u.protocol === 'https:') && (await resolvesToPrivate(u.hostname))) {
          await route.abort();
          return;
        }
        if (request.resourceType() === 'media') {
          await route.abort();
          return;
        }
        if (request.isNavigationRequest() && request.frame() === page.mainFrame() && FILE_PATH.test(u.pathname)) {
          fileUrl ??= request.url();
          await route.abort();
          return;
        }
      } catch {
        /* unparseable URL: ordinary traffic */
      }
      await route.continue().catch(() => undefined);
    });
    page.on('download', (d) => {
      fileUrl ??= d.url();
      void d.cancel().catch(() => undefined);
    });
    if (opts.capture) {
      const pattern = opts.capture;
      page.on('response', (r) => {
        if (!pattern.test(r.url())) return;
        pendingCaptures.push(
          r
            .text()
            .then((body) => {
              captured.push({ url: r.url(), status: r.status(), body: body.slice(0, 2_000_000) });
            })
            .catch(() => undefined),
        );
      });
    }

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
      // Wait until the page stops fetching (most sites build their content
      // with scripts after load), bounded so a chatty page cannot hang us.
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && Date.now() - lastActivity < 1_500 && !fileUrl) {
        await new Promise((r) => setTimeout(r, 250));
      }
      while (Date.now() < deadline && Date.now() - lastActivity < 1_500) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (opts.settleMs) await page.waitForTimeout(opts.settleMs);
      // A captured response that never finishes (a stream) must not hang the read.
      await Promise.race([Promise.all(pendingCaptures), new Promise((r) => setTimeout(r, 5_000))]);

      // A string, not a function: this project compiles without DOM types.
      const read = await page
        .evaluate<{ title: string; text: string; links: { url: string; label?: string }[] }>(`(() => ({
          title: document.title,
          text: document.body ? document.body.innerText : '',
          links: Array.from(document.querySelectorAll('a[href]')).slice(0, 500).map((a) => ({
            url: a.href,
            label: (a.innerText || '').trim().slice(0, 200) || undefined,
          })),
        }))()`)
        .catch(() => ({ title: '', text: '', links: [] as { url: string; label?: string }[] }));
      let evaluated: unknown;
      if (opts.evaluate) {
        evaluated = await page.evaluate(opts.evaluate).catch(() => undefined);
      }
      return {
        finalUrl: page.url(),
        title: read.title,
        text: read.text.slice(0, 2_000_000),
        links: read.links.filter((l) => /^https?:/i.test(l.url)),
        captured,
        fileUrl,
        evaluated,
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /** Enforce same-origin so this session can never be used as a generic proxy. */
  toSameOriginUrl(pathOrUrl: string): string {
    // Resolve relative paths against the page's own origin: after SSO the app
    // may sit on either Blackboard hostname, and the session cookies (and API)
    // live on that host.
    let origin = this.authOrigin ?? BASE_URL;
    if (this.worker && !this.worker.isClosed()) {
      try {
        const current = new URL(this.worker.url());
        if (isBlackboardHost(current)) origin = current.origin;
      } catch {
        /* fall back to BASE_URL */
      }
    }
    const resolved = new URL(pathOrUrl, origin);
    if (!isBlackboardHost(resolved)) {
      throw new BlackboardError('INVALID_INPUT', `Refusing to fetch non-Blackboard URL: ${resolved.origin}`);
    }
    return resolved.toString();
  }

  toSameOriginPath(href: string): string {
    const resolved = new URL(href, BASE_URL);
    if (!isBlackboardHost(resolved)) {
      throw new BlackboardError('BLACKBOARD_REQUEST_FAILED', 'Blackboard returned a pagination link for a different host; refusing to follow.');
    }
    return `${resolved.pathname}${resolved.search}`;
  }

  /** Open (or reuse) the main page and navigate to a URL — used by the discover CLI. */
  async openPage(url: string): Promise<Page> {
    const pages = this.context.pages();
    const page = pages.length > 0 ? pages[0] : await this.context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
    return page;
  }

  /**
   * Make the login window visually unmistakable: distinct title + banner.
   * Re-applies every call so it survives SSO navigations. Pure UI aid — the
   * student still does all the typing.
   */
  async markLoginWindow(): Promise<void> {
    // Mark only a window that is still open: going through ensureWorker here
    // re-created the tab every few seconds after the student closed it.
    const page = this.worker && !this.worker.isClosed() ? this.worker : this.context.pages()[0];
    if (!page || page.isClosed()) return;
    await markPage(page, 'sign in with your NetID + Duo in THIS window (it has no bookmarks bar — that is how you know)');
  }

  private signInTabs = 0;

  /** True while a sign-in tab opened by openSignInTab is still open. */
  hasOpenSignInTab(): boolean {
    return this.signInTabs > 0;
  }

  /**
   * Open a visible tab on a link that needs a sign-in, so the student can
   * sign in right away instead of quitting their AI app. Only navigation and
   * a banner: the student does every bit of typing. `onClosed` runs when the
   * student closes the tab. While it is open, the sites it visits are
   * remembered (like `npm run connect`) so their sign-in survives restarts.
   */
  async openSignInTab(url: string, service: string, onClosed: () => void): Promise<void> {
    await assertPublicDestination(url);
    const page = await this.context.newPage();
    this.signInTabs += 1;
    const hosts = new Set<string>();
    const remember = (): void => {
      try {
        hosts.add(new URL(page.url()).hostname);
      } catch {
        /* not a web page yet */
      }
      void rememberConnectedSites([...hosts]).then(() => this.saveSnapshot());
    };
    const label = `sign in to ${service} in THIS tab, then close the tab and ask your AI again`;
    const timer = setInterval(() => {
      remember();
      void markPage(page, label);
    }, 2500);
    page.on('close', () => {
      clearInterval(timer);
      this.signInTabs -= 1;
      onClosed();
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
    await page.bringToFront().catch(() => undefined);
    await markPage(page, label);
  }

  /** Bring the login window to the front (once, at start of the login flow). */
  async focusLoginWindow(): Promise<void> {
    // Like markLoginWindow: never re-create a window the student closed.
    const page = this.worker && !this.worker.isClosed() ? this.worker : this.context.pages()[0];
    const target = page && !page.isClosed() ? page : await this.ensureWorker();
    await target.bringToFront().catch(() => undefined);
  }

  async markVerified(): Promise<void> {
    await writeMeta({ lastVerifiedAt: new Date().toISOString() }).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.context.close();
    } catch {
      /* already closed */
    }
    this.worker = null;
  }
}
