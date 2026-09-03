import { describe, expect, it } from 'vitest';
import { isBlackboardHost, isDownloadHost } from '../src/blackboard/hosts.js';
import { isFileCandidateUrl, isFileNavigation } from '../src/blackboard/session.js';

const u = (s: string): URL => new URL(s);

const CDN_FILE = u('https://learn-us-east-1-prod-fleet01-beaker-xythos.content.blackboardcdn.com/5956621d575cd/14531277');
const CDN_BANNER = u('https://learn-us-east-1-prod-fleet01-beaker-xythos.content.blackboardcdn.com/5956621d575cd/20993873');

describe('isDownloadHost', () => {
  it('accepts Blackboard hostnames and the content CDN', () => {
    expect(isDownloadHost(u('https://blackboard.syr.edu/bbcswebdav/xid-1_1'))).toBe(true);
    expect(isDownloadHost(u('https://blackboard.syracuse.edu/x'))).toBe(true);
    expect(isDownloadHost(u('https://learn-us-east-1-prod-fleet01-beaker-xythos.content.blackboardcdn.com/a/b'))).toBe(true);
  });

  it('rejects plain http, so a resolved link can never downgrade', () => {
    expect(isDownloadHost(u('http://blackboard.syr.edu/bbcswebdav/xid-1_1'))).toBe(false);
  });

  it('rejects unrelated and look-alike hosts', () => {
    expect(isDownloadHost(u('https://evil.com/x'))).toBe(false);
    // Suffix matching must not be fooled by a prefix or a longer parent domain.
    expect(isDownloadHost(u('https://notblackboardcdn.com/x'))).toBe(false);
    expect(isDownloadHost(u('https://blackboardcdn.com.evil.com/x'))).toBe(false);
    expect(isDownloadHost(u('https://blackboard.syr.edu.evil.com/x'))).toBe(false);
  });
});

describe('isFileCandidateUrl', () => {
  it('treats /bbcswebdav/ on a Blackboard host as a file', () => {
    expect(isFileCandidateUrl(u('https://blackboard.syr.edu/bbcswebdav/xid-16632656_1_1'))).toBe(true);
  });

  it('rejects Blackboard app and API routes that answer with file-ish types', () => {
    // Regression: the telemetry endpoint replies with a file-like content type
    // and was being collected as a download candidate.
    expect(isFileCandidateUrl(u('https://blackboard.syracuse.edu/telemetry/api/v1/browser/interactions'))).toBe(false);
    expect(isFileCandidateUrl(u('https://blackboard.syr.edu/learn/api/public/v1/courses'))).toBe(false);
    expect(isFileCandidateUrl(u('https://blackboard.syr.edu/ultra/redirect?redirectType=nautilus'))).toBe(false);
    expect(isFileCandidateUrl(u('https://blackboard.syr.edu/ultra/courses'))).toBe(false);
  });

  it('accepts any path on the content CDN, which serves only files', () => {
    expect(
      isFileCandidateUrl(u('https://learn-us-east-1-prod-fleet01-beaker-xythos.content.blackboardcdn.com/5956621d575cd/14531277?x=1')),
    ).toBe(true);
  });

  it('rejects hosts outside the allowlist entirely', () => {
    expect(isFileCandidateUrl(u('https://evil.com/bbcswebdav/xid-1_1'))).toBe(false);
    expect(isFileCandidateUrl(u('http://learn.content.blackboardcdn.com/a'))).toBe(false);
  });

  it('agrees with isBlackboardHost about what counts as Blackboard', () => {
    const bb = u('https://blackboard.syr.edu/bbcswebdav/x');
    expect(isBlackboardHost(bb)).toBe(true);
    expect(isFileCandidateUrl(bb)).toBe(true);
  });
});

describe('isFileNavigation', () => {
  it('accepts the main-frame navigation to the file', () => {
    // The real resolved link: same-origin /bbcswebdav/, reached after the SPA
    // finishes bouncing.
    expect(
      isFileNavigation({
        isNavigation: true,
        url: u('https://blackboard.syracuse.edu/bbcswebdav/pid-13066507-dt-content-rid-164784021_1/xid-164784021_1'),
      }),
    ).toBe(true);
    expect(isFileNavigation({ isNavigation: true, url: CDN_FILE })).toBe(true);
  });

  it('rejects a page subresource even when it looks exactly like a file', () => {
    // Regression: the Ultra 404 page serves Ultra_Banner_Campus.png from the
    // same CDN with `Content-Disposition: inline; filename=...`. Without the
    // navigation check a failed download returned that banner as the file.
    expect(isFileNavigation({ isNavigation: false, url: CDN_BANNER })).toBe(false);
    // ...and it is only the navigation flag that saves us: same host, same
    // shape of URL as the genuine article.
    expect(isFileNavigation({ isNavigation: false, url: CDN_FILE })).toBe(false);
  });

  it('rejects navigations to app and API routes', () => {
    expect(
      isFileNavigation({ isNavigation: true, url: u('https://blackboard.syr.edu/ultra/redirect?redirectType=nautilus') }),
    ).toBe(false);
    expect(
      isFileNavigation({ isNavigation: true, url: u('https://blackboard.syr.edu/learn/api/public/v1/courses') }),
    ).toBe(false);
    // The LTI launches the redirect page fires on its way through.
    expect(
      isFileNavigation({ isNavigation: true, url: u('https://developer.blackboard.com/ltiStorage') }),
    ).toBe(false);
  });

  it('rejects a navigation to a host outside the allowlist', () => {
    expect(isFileNavigation({ isNavigation: true, url: u('https://evil.com/x.pdf') })).toBe(false);
  });
});
