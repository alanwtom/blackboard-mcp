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
