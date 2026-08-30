import type { BrowserContext, Page } from 'playwright';
import { launchBrowser } from './browser.js';
import { BlackboardError, truncate } from './errors.js';
import { isBlackboardHost, BLACKBOARD_HOSTS } from './hosts.js';
import type { BBIdentity } from './types.js';
import { readMeta, writeMeta, loadCookies, saveCookies } from '../storage/session-store.js';

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

  /** True once the worker page exists and sits on a real web page. */
  async ensureWorker(preferredOrigin?: string): Promise<Page> {
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
    throw new BlackboardError('NOT_LOGGED_IN', 'Timed out waiting for Blackboard login. Run npm run login and complete SSO + Duo in the browser window.');
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
    await page
      .waitForURL(/blackboard\.(syr|syracuse)\.edu\/(ultra|webapps\/portal)/, { timeout: 30_000 })
      .catch(() => undefined);
    await page.waitForTimeout(1500);
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
    // Snapshot the authenticated cookies so the next launch stays signed in
    // even though Blackboard's session cookie is browser-session scoped.
    await this.context
      .storageState()
      .then((state) => saveCookies(state.cookies))
      .catch(() => undefined);
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
    const url = this.toSameOriginUrl(path);
    const payload = {
      url,
      init: { method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body },
    };
    let page = await this.ensureWorker();
    let result: EvaluateResult;
    try {
      result = await BlackboardSession.evaluateFetch(page, payload);
    } catch {
      // Navigations can destroy the JS context mid-flight; rebuild once.
      if (this.worker) {
        try {
          await this.worker.close();
        } catch {
          /* ignore */
        }
      }
      this.worker = null;
      page = await this.ensureWorker();
      result = await BlackboardSession.evaluateFetch(page, payload);
    }
    if (result.error) {
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
    const res = await this.context.request.get(url, { timeout: 90_000 });
    const bytes = await res.body();
    const headers = res.headers();
    return {
      status: res.status(),
      contentType: headers['content-type'] ?? null,
      bytes,
      filename: parseContentDispositionFilename(headers['content-disposition']),
    };
  }

  /** Enforce same-origin so this session can never be used as a generic proxy. */
  toSameOriginUrl(pathOrUrl: string): string {
    // Resolve relative paths against the page's own origin: after SSO the app
    // may sit on either Blackboard hostname, and the session cookies (and API)
    // live on that host.
    let origin = BASE_URL;
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
    const page = await this.ensureWorker();
    await page
      .evaluate(`(() => {
        const title = '▶ SIGN IN HERE — blackboard-mcp';
        if (document.title !== title) document.title = title;
        if (document.body && !document.getElementById('bbmcp-login-banner')) {
          const banner = document.createElement('div');
          banner.id = 'bbmcp-login-banner';
          banner.textContent = '▶ blackboard-mcp: sign in with your NetID + Duo in THIS window (it has no bookmarks bar — that is how you know)';
          banner.style.cssText =
            'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#c5221f;color:#fff;padding:12px 18px;font:600 15px/1.4 -apple-system,system-ui,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.4);';
          document.body.appendChild(banner);
        }
      })()`)
      .catch(() => undefined);
  }

  /** Bring the login window to the front (once, at start of the login flow). */
  async focusLoginWindow(): Promise<void> {
    const page = await this.ensureWorker();
    await page.bringToFront().catch(() => undefined);
  }

  async markVerified(): Promise<void> {
    await writeMeta({ lastVerifiedAt: new Date().toISOString() }).catch(() => undefined);
  }

  async close(): Promise<void> {
    try {
      await this.context.close();
    } catch {
      /* already closed */
    }
    this.worker = null;
  }
}
