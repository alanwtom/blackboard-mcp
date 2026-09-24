import { beforeEach, describe, expect, it } from 'vitest';
import { classifyLink, extractLinks } from '../src/blackboard/links.js';
import { allowedUrl, allowLinks, allowSameSiteLinks, clearAllowedLinks, isLinkAllowed } from '../src/blackboard/link-registry.js';
import { assertPublicUrl, isPrivateHost, parseSetCookies, resolvesToPrivate } from '../src/blackboard/session.js';

describe('classifyLink', () => {
  // Real link shapes found in Syracuse courses (Sep 2026 scan).
  it.each([
    ['https://docs.google.com/spreadsheets/d/1Q1o9qUHqCOnapi-BUyU1tw/edit?gid=0#gid=0', 'google-sheet'],
    ['https://docs.google.com/document/d/1-kfMxZ0898sFdihPF9NA4V18/edit?usp=sharing', 'google-doc'],
    ['https://docs.google.com/presentation/d/1abcDEFghiJKLmno/edit', 'google-slides'],
    ['https://drive.google.com/drive/folders/1YMMAF-xMMe2GwlGZnCnbMhTfVqlLMjUG?usp=sharing', 'google-drive-folder'],
    ['https://drive.google.com/file/d/1RaBejy6rr89SbkN4Cihfhxj4WhB6X6kv/view?usp=sharing', 'google-drive-file'],
    ['https://colab.research.google.com/drive/1WVi3XAwTlrLcOVCZkzZn2tbuK45Ex4kP?usp=share_link', 'google-colab'],
    ['https://forms.gle/abc123', 'google-form'],
    ['https://syracuseuniversity.zoom.us/j/9242076065', 'zoom-meeting'],
    ['https://syracuseuniversity.zoom.us/meetings/9242076065/invitations?signature=x', 'zoom-meeting'],
    ['https://syracuseuniversity.zoom.us/rec/share/abcDEF123', 'zoom-recording'],
    ['http://www.youtube.com/watch?v=6tKlUl-Ia_Y', 'youtube'],
    ['https://youtu.be/aircAruvnKk?si=XLOkcTiezJufYEYo', 'youtube'],
    ['https://video.syr.edu/media/t/1_uid783fc', 'kaltura'],
    ['https://forms.office.com/r/0Bax5TxxQ7', 'microsoft-form'],
    ['https://syr-my.sharepoint.com/:w:/g/personal/x/EaBc?e=1', 'microsoft-365'],
    ['https://github.com/academicpages/academicpages.github.io', 'github'],
    ['https://arxiv.org/pdf/2401.03910.pdf', 'file'],
    ['https://plato.stanford.edu/entries/connectionism/', 'web-page'],
    ['https://blackboard.syracuse.edu/bbcswebdav/pid-1-dt-content-rid-2_1/xid-3_1', 'blackboard-file'],
    ['https://blackboard.syr.edu/ultra/courses/_1_1/outline', 'blackboard-page'],
  ])('%s → %s', (url, kind) => {
    expect(classifyLink(url)).toBe(kind);
  });
});

describe('extractLinks', () => {
  it('finds anchors with their text, embeds, and plain-text URLs', () => {
    const html =
      '<p>Sign up <a href="https://docs.google.com/spreadsheets/d/1Q1o9qUHqCOnapi/edit?gid=0">here</a>.</p>' +
      '<iframe src="https://www.youtube.com/embed/aircAruvnKk"></iframe>' +
      '<p>Watch https://youtu.be/aircAruvnKk?si=XLOk. then read https://plato.stanford.edu/entries/connectionism/,</p>';
    const links = extractLinks(html);
    expect(links.map((l) => l.url)).toEqual([
      'https://docs.google.com/spreadsheets/d/1Q1o9qUHqCOnapi/edit?gid=0',
      'https://www.youtube.com/embed/aircAruvnKk',
      'https://youtu.be/aircAruvnKk?si=XLOk',
      'https://plato.stanford.edu/entries/connectionism/',
    ]);
    expect(links[0]).toMatchObject({ label: 'here', kind: 'google-sheet' });
  });

  it('skips mail, script, anchor-only and Blackboard template links, and decodes entities', () => {
    const html =
      '<a href="mailto:prof@syr.edu">email</a><a href="javascript:void(0)">x</a><a href="#top">top</a>' +
      '<a href="@X@EmbeddedFile.requestUrlStub@X@bbcswebdav/xid-1">file</a>' +
      '<a href="https://example.edu/a?x=1&amp;y=2">ok</a>';
    expect(extractLinks(html).map((l) => l.url)).toEqual(['https://example.edu/a?x=1&y=2']);
  });

  it('dedupes a link that appears as an anchor and as its own text', () => {
    const html = '<a href="https://arxiv.org/abs/2401.03910">https://arxiv.org/abs/2401.03910</a>';
    expect(extractLinks(html)).toHaveLength(1);
  });
});

describe('link safety list', () => {
  beforeEach(() => clearAllowedLinks());

  it('only allows links that came from Blackboard, ignoring tracking parameters and #fragments', () => {
    allowLinks(['https://docs.google.com/document/d/abc/edit?usp=sharing']);
    expect(isLinkAllowed('https://docs.google.com/document/d/abc/edit')).toBe(true);
    expect(isLinkAllowed('https://docs.google.com/document/d/abc/edit#heading=h.1')).toBe(true);
    expect(isLinkAllowed('https://docs.google.com/document/d/other/edit')).toBe(false);
  });

  it('always opens the professor’s own URL, so data cannot ride along in tags, #fragments or logins', () => {
    allowLinks(['https://prof-blog.example.com/week3']);
    // These match (so the AI can find the link) but map back to the original.
    expect(allowedUrl('https://prof-blog.example.com/week3?utm_source=GRADES_A_MINUS')).toBe('https://prof-blog.example.com/week3');
    expect(allowedUrl('https://prof-blog.example.com/week3#GRADES')).toBe('https://prof-blog.example.com/week3');
    // These do not match at all.
    expect(allowedUrl('https://GRADES:x@prof-blog.example.com/week3')).toBeNull();
    expect(allowedUrl('https://prof-blog.example.com:8443/week3')).toBeNull();
    expect(allowedUrl('https://prof-blog.example.com/week3?grades=A')).toBeNull();
  });

  it('lets an allowed page add its own same-site links, but not links to other sites', () => {
    const kept = allowSameSiteLinks('https://cs.example.edu/course/', [
      'https://cs.example.edu/course/lec1.pdf',
      'https://attacker.example.com/steal?data=1',
    ]);
    expect(kept).toEqual(['https://cs.example.edu/course/lec1.pdf']);
    expect(isLinkAllowed('https://cs.example.edu/course/lec1.pdf')).toBe(true);
    expect(isLinkAllowed('https://attacker.example.com/steal?data=1')).toBe(false);
  });

  it('treats different people on shared hosting as different sites', () => {
    const kept = allowSameSiteLinks('https://prof.github.io/', ['https://prof.github.io/notes', 'https://evil.github.io/x']);
    expect(kept).toEqual(['https://prof.github.io/notes']);
  });
});

describe('private address guard', () => {
  it.each(['localhost.', 'LOCALHOST..', '[::7f00:1]', '[64:ff9b::7f00:1]', '[fec0::1]', 'localhost', '127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '169.254.169.254', '[::1]', '[::ffff:7f00:1]', 'printer.local'])(
    'blocks %s',
    (host) => {
      expect(isPrivateHost(host)).toBe(true);
    },
  );

  it.each(['docs.google.com', '8.8.8.8', 'fdsa.com', 'blackboard.syr.edu'])('allows %s', (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });

  it('checks where a name resolves, not just the name', async () => {
    expect(await resolvesToPrivate('localhost.')).toBe(true);
    expect(await resolvesToPrivate('192.168.1.1')).toBe(true);
    expect(await resolvesToPrivate('no-such-host.invalid')).toBe(false);
  });

  it('rejects non-web and private links with a coded error', () => {
    expect(() => assertPublicUrl('file:///etc/passwd')).toThrow(/Only web links/);
    expect(() => assertPublicUrl('http://127.0.0.1:8080/')).toThrow(/private network/);
    expect(assertPublicUrl('https://arxiv.org/abs/1').hostname).toBe('arxiv.org');
  });
});

describe('cookies set during redirects', () => {
  it('keeps them for the host that set them, and refuses cookies for other sites', () => {
    const cookies = parseSetCookies(
      [
        'guest=abc; Path=/; Secure; HttpOnly; SameSite=None',
        'wide=1; Domain=.sharepoint.com; Max-Age=60',
        'evil=1; Domain=google.com',
      ],
      'https://syr-my.sharepoint.com/:w:/g/x',
    );
    expect(cookies.map((c) => [c.name, c.domain])).toEqual([
      ['guest', 'syr-my.sharepoint.com'],
      ['wide', '.sharepoint.com'],
    ]);
    expect(cookies[0]).toMatchObject({ secure: true, httpOnly: true, sameSite: 'None', expires: -1 });
    expect(cookies[1]?.expires).toBeGreaterThan(Date.now() / 1000);
  });
});
