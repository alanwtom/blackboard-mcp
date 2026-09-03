/**
 * Syracuse serves Blackboard under two hostnames (blackboard.syr.edu and
 * blackboard.syracuse.edu) and can land the browser on either during SSO.
 * All same-origin checks trust both.
 */
export const BLACKBOARD_HOSTS = process.env.BB_BASE_URL
  ? [new URL(process.env.BB_BASE_URL).hostname]
  : ['blackboard.syr.edu', 'blackboard.syracuse.edu'];

export function isBlackboardHost(url: URL): boolean {
  return BLACKBOARD_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
}

/**
 * Attachment bytes come from Blackboard's content CDN (Xythos), not from the
 * Blackboard hostname itself — a download link resolves to something like
 * learn-us-east-1-prod-...content.blackboardcdn.com. Refetching a resolved
 * link has to accept those hosts, but ONLY those: a page that wanders
 * somewhere unexpected must never make us fetch an arbitrary URL.
 */
const CONTENT_HOSTS = ['blackboardcdn.com', 'bbcdn.com'];

export function isDownloadHost(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  if (isBlackboardHost(url)) return true;
  return CONTENT_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
}
