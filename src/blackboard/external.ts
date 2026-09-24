import { saveToDownloads } from './attachments.js';
import { BlackboardError } from './errors.js';
import { extractText } from './extract.js';
import { allowSameSiteLinks } from './link-registry.js';
import { classifyLink, type LinkKind, type LinkRef } from './links.js';
import type { BBHttp, ExternalHttp, ExternalResponse, RenderedPage } from './session.js';
import { stripHtml } from './util.js';

/**
 * Read what's behind a link a professor posted: a Google Sheet, a Colab
 * notebook, a YouTube video's transcript, a Zoom recording's transcript, a
 * PDF on a course website, and so on.
 *
 * Everything goes through the dedicated browser, so any site the student has
 * signed into in that window (Google, Zoom, Microsoft) works the same as it
 * would for them. Nothing is ever submitted, joined, or typed: forms are only
 * read, and a live meeting link is reported, not opened.
 */

export type LinkReadStatus = 'ok' | 'needs_sign_in' | 'needs_passcode' | 'no_access' | 'live_meeting' | 'not_readable';

export interface LinkReadResult {
  url: string;
  kind: LinkKind;
  status: LinkReadStatus;
  finalUrl?: string;
  title?: string;
  /** How the text was obtained, e.g. "google sheet (3 tabs)", "youtube transcript". */
  format?: string;
  text?: string;
  /** Local copy, when the link was a file. */
  savedPath?: string;
  /** Links found inside (a Drive folder's files, a course site's pages). */
  links?: LinkRef[];
  /** Plain-language next step for the student when status is not "ok". */
  note?: string;
  /** Which sign-in is needed, when status is needs_sign_in / needs_passcode. */
  signIn?: { service: string; connect: string };
}

const SIGN_IN_HOSTS: { test: RegExp; service: string; connect: string }[] = [
  { test: /(^|\.)accounts\.google\.com$/, service: 'Google', connect: 'google' },
  { test: /(^|\.)login\.microsoftonline\.com$|(^|\.)login\.live\.com$/, service: 'Microsoft (SU NetID)', connect: 'microsoft' },
  { test: /(^|\.)zoom\.us$/, service: 'Zoom', connect: 'zoom' },
  { test: /(^|\.)github\.com$/, service: 'GitHub', connect: 'github' },
  { test: /(^|\.)box\.com$/, service: 'Box', connect: 'box' },
  { test: /(^|\.)dropbox\.com$/, service: 'Dropbox', connect: 'dropbox' },
];

/** A sign-in page, judged by where we ended up. */
function signInService(finalUrl: string): { service: string; connect: string } | null {
  let u: URL;
  try {
    u = new URL(finalUrl);
  } catch {
    return null;
  }
  const looksLikeLogin = /sign[-_]?in|login|servicelogin|oauth|saml|authorize|\/sso/i.test(u.pathname + u.search);
  for (const entry of SIGN_IN_HOSTS) {
    if (!entry.test.test(u.hostname)) continue;
    if (entry.connect === 'google' || entry.connect === 'microsoft' || looksLikeLogin) return entry;
  }
  if (/(^|\.)(idp|sso|shib|login|auth)\./i.test(u.hostname) || /\/(idp|shibboleth|saml2?)\//i.test(u.pathname)) {
    return { service: 'your university sign-in', connect: 'microsoft' };
  }
  return null;
}

function needsSignIn(url: string, kind: LinkKind, service: { service: string; connect: string }, finalUrl?: string): LinkReadResult {
  return {
    url,
    kind,
    status: 'needs_sign_in',
    finalUrl,
    signIn: service,
    note:
      `This link needs the student to be signed in to ${service.service}. Ask again in a moment and a sign-in window ` +
      'will open for them. They only need to do this once.',
  };
}

function isHtml(resp: ExternalResponse): boolean {
  const ct = (resp.contentType ?? '').toLowerCase();
  if (ct.includes('text/html')) return true;
  const head = resp.bytes.subarray(0, 200).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

function fileNameFrom(resp: ExternalResponse, fallback: string): string {
  if (resp.filename) return resp.filename;
  try {
    const last = decodeURIComponent(new URL(resp.finalUrl).pathname.split('/').pop() ?? '');
    if (/\.[a-z0-9]{1,6}$/i.test(last)) return last;
  } catch {
    /* fall through */
  }
  return fallback;
}

interface Ctx {
  http: BBHttp;
  ext: ExternalHttp;
  url: string;
  kind: LinkKind;
  subfolder: string;
}

/** Save a fetched file and turn it into text. */
async function fileResult(ctx: Ctx, resp: ExternalResponse, fallbackName: string, extra: Partial<LinkReadResult> = {}): Promise<LinkReadResult> {
  const name = fileNameFrom(resp, fallbackName);
  const saved = await saveToDownloads(resp.bytes, name, ctx.subfolder, resp.contentType);
  const extracted = await extractText(resp.bytes, name, resp.contentType ?? undefined);
  const mime = (resp.contentType ?? '').toLowerCase();
  let note: string | undefined;
  if (!extracted) {
    note = mime.startsWith('video/') || mime.startsWith('audio/')
      ? 'This is a video or audio file. It was saved, but it has no text to read (no transcript came with it).'
      : 'The file was saved, but its contents are not a format that can be read as text.';
  } else if (!extracted.text) {
    note = `The file was saved, but it has no readable text (${extracted.format}).`;
  }
  return {
    url: ctx.url,
    kind: ctx.kind,
    status: extracted?.text ? 'ok' : 'not_readable',
    finalUrl: resp.finalUrl,
    title: saved.fileName,
    format: extracted?.format ?? mime ?? 'file',
    text: extracted?.text || undefined,
    savedPath: saved.path,
    note,
    ...extra,
  };
}

/** Fetch an export/download URL and classify the three outcomes. */
async function fetchFileOrSignIn(
  ctx: Ctx,
  fetchUrl: string,
  fallbackName: string,
  extra: Partial<LinkReadResult> = {},
): Promise<LinkReadResult | { html: ExternalResponse }> {
  const resp = await ctx.ext.fetch(fetchUrl);
  const service = signInService(resp.finalUrl);
  if (service) return needsSignIn(ctx.url, ctx.kind, service, resp.finalUrl);
  if (resp.status === 401 || resp.status === 403) {
    return {
      url: ctx.url,
      kind: ctx.kind,
      status: 'no_access',
      finalUrl: resp.finalUrl,
      note: 'The site says the student does not have access. If it is a Google or Microsoft file, they may need to sign in with their SU account, or ask the professor to share it.',
    };
  }
  if (resp.status === 404) {
    return { url: ctx.url, kind: ctx.kind, status: 'not_readable', note: 'The link is broken (the site says it does not exist).' };
  }
  if (resp.status >= 400) {
    return { url: ctx.url, kind: ctx.kind, status: 'not_readable', note: `The site returned an error (HTTP ${resp.status}). Try again later.` };
  }
  if (isHtml(resp)) return { html: resp };
  return fileResult(ctx, resp, fallbackName, extra);
}

// ---------------------------------------------------------------------------
// Rendered pages
// ---------------------------------------------------------------------------

function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Read a page in the browser; also handles sign-in walls and file links. */
async function readRendered(ctx: Ctx, target: string, opts: Parameters<ExternalHttp['render']>[1] = {}): Promise<{ page: RenderedPage } | LinkReadResult> {
  const page = await ctx.ext.render(target, opts);
  const service = signInService(page.finalUrl);
  if (service) return needsSignIn(ctx.url, ctx.kind, service, page.finalUrl);
  if (page.fileUrl) {
    const got = await fetchFileOrSignIn(ctx, page.fileUrl, 'download');
    if ('html' in got) return { page };
    return got;
  }
  return { page };
}

async function readWebPage(ctx: Ctx, target = ctx.url): Promise<LinkReadResult> {
  // A plain fetch first: many links are really files (a PDF on a course site)
  // and a server-rendered page is quicker to read without a browser tab.
  let fetched: LinkReadResult | { html: ExternalResponse } | null = null;
  try {
    fetched = await fetchFileOrSignIn(ctx, target, 'download');
  } catch (err) {
    if (err instanceof BlackboardError && err.code === 'CONTENT_NOT_AVAILABLE') throw err;
    fetched = null;
  }
  if (fetched && !('html' in fetched) && fetched.status !== 'not_readable') return fetched;
  if (fetched && !('html' in fetched) && fetched.savedPath) return fetched;

  const rendered = await readRendered(ctx, target);
  if (!('page' in rendered)) return rendered;
  // The site said "does not exist" and the browser did not land on a
  // sign-in page either: report a broken link, not the text of an error page.
  if (fetched && !('html' in fetched) && /does not exist/.test(fetched.note ?? '')) return fetched;
  const { page } = rendered;
  let text = tidy(page.text);
  // Pages that build nothing without scripts still have their server HTML.
  if (text.length < 40 && fetched && 'html' in fetched) text = stripHtml(fetched.html.bytes.toString('utf8'));
  const sameSite = allowSameSiteLinks(page.finalUrl || target, page.links.map((l) => l.url));
  const links = page.links
    .filter((l) => sameSite.includes(l.url))
    .slice(0, 100)
    .map((l) => ({ url: l.url, label: l.label, kind: classifyLink(l.url) }));
  return {
    url: ctx.url,
    kind: ctx.kind,
    status: text ? 'ok' : 'not_readable',
    finalUrl: page.finalUrl,
    title: page.title || undefined,
    format: 'web page',
    text: text || undefined,
    links: links.length > 0 ? links : undefined,
    note: text ? undefined : 'The page loaded but showed no readable text.',
  };
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

function googleId(url: URL): string | undefined {
  return /\/d\/(?:e\/)?([A-Za-z0-9_-]{10,})/.exec(url.pathname)?.[1]
    ?? /\/folders\/([A-Za-z0-9_-]{10,})/.exec(url.pathname)?.[1]
    ?? url.searchParams.get('id')
    ?? /\/drive\/([A-Za-z0-9_-]{10,})/.exec(url.pathname)?.[1]
    ?? undefined;
}

async function readGoogleExport(ctx: Ctx, exportUrl: string, fallbackName: string, format: string): Promise<LinkReadResult> {
  const got = await fetchFileOrSignIn(ctx, exportUrl, fallbackName);
  if (!('html' in got)) {
    if (got.status === 'ok') return { ...got, format: `${format}, read as ${got.format}` };
    if (got.status === 'needs_sign_in') return got;
    // Google answers a download it will not give you with a bare 404 or 403,
    // whether the file is private or gone. The file's own page says which:
    // it sends a signed-out visitor to the sign-in page.
    return readWebPage(ctx);
  }
  // Google answers an export it will not serve with an HTML page: a sign-in
  // wall, or "you need access". Read the original link to tell which.
  return readWebPage(ctx);
}

async function readDriveFile(ctx: Ctx, id: string): Promise<LinkReadResult> {
  const first = await fetchFileOrSignIn(ctx, `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`, `drive-${id}`);
  if (!('html' in first)) return first;
  // Large files get a "can't scan for viruses" page with a confirm form.
  const html = first.html.bytes.toString('utf8');
  const form = /<form[^>]*id="download-form"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (form) {
    const action = new URL(form[1]!.replace(/&amp;/g, '&'));
    for (const input of form[2]!.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)) {
      action.searchParams.set(input[1]!, input[2]!.replace(/&amp;/g, '&'));
    }
    const second = await fetchFileOrSignIn(ctx, action.toString(), `drive-${id}`);
    if (!('html' in second)) return second;
  }
  return readWebPage(ctx);
}

async function readDriveFolder(ctx: Ctx, id: string): Promise<LinkReadResult> {
  const got = await fetchFileOrSignIn(ctx, `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`, 'folder');
  if (!('html' in got)) return got;
  const html = got.html.bytes.toString('utf8');
  const entries: LinkRef[] = [];
  for (const m of html.matchAll(/<div class="flip-entry" id="entry-([A-Za-z0-9_-]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([\s\S]*?)<\/div>/g)) {
    const url = m[2]!.replace(/&amp;/g, '&');
    entries.push({ url, label: stripHtml(m[3]!), kind: classifyLink(url) });
  }
  if (entries.length === 0) return readWebPage(ctx);
  allowSameSiteLinks(ctx.url, entries.map((e) => e.url));
  return {
    url: ctx.url,
    kind: ctx.kind,
    status: 'ok',
    title: /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim(),
    format: `google drive folder (${entries.length} items)`,
    text: entries.map((e) => `- ${e.label} (${e.kind})`).join('\n'),
    links: entries,
    note: 'Open any of these with this same tool.',
  };
}

async function readColab(ctx: Ctx, url: URL): Promise<LinkReadResult> {
  const gh = /^\/github\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
  if (gh) {
    const raw = `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`;
    const got = await fetchFileOrSignIn(ctx, raw, gh[3]!.split('/').pop() ?? 'notebook.ipynb');
    return 'html' in got ? readWebPage(ctx) : got;
  }
  const id = /\/drive\/([A-Za-z0-9_-]{10,})/.exec(url.pathname)?.[1];
  if (!id) return readWebPage(ctx);
  const got = await fetchFileOrSignIn(ctx, `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`, `colab-${id}.ipynb`);
  if ('html' in got) return readWebPage(ctx);
  // Drive serves the notebook without a file extension; read it as one.
  if (got.status !== 'ok' && got.savedPath) {
    return { ...got, note: 'The notebook was saved but could not be read as text.' };
  }
  return { ...got, format: 'colab notebook' };
}

// ---------------------------------------------------------------------------
// Video: YouTube, Zoom, Panopto, Kaltura
// ---------------------------------------------------------------------------

function youtubeId(url: URL): string | undefined {
  if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0] || undefined;
  return url.searchParams.get('v') ?? /\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{6,})/.exec(url.pathname)?.[1] ?? undefined;
}

/**
 * Runs inside the YouTube watch page: metadata plus the transcript, if any.
 *
 * As of Sep 2026 YouTube answers caption requests from an automated browser
 * with an empty body (and its own "Show transcript" button fails there too),
 * so in practice this returns title, channel, length and description. The
 * caption attempt is kept because it costs one request and starts working
 * again the day YouTube relaxes that. Disguising the browser to get past the
 * check is deliberately not done.
 */
const YOUTUBE_SCRIPT = `(async () => {
  const pr = window.ytInitialPlayerResponse || {};
  const vd = pr.videoDetails || {};
  const out = { title: vd.title, author: vd.author, seconds: Number(vd.lengthSeconds) || undefined, description: vd.shortDescription, lines: [] };
  const tracks = (((pr.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks) || [];
  const pick = tracks.find(t => /^en/.test(t.languageCode) && t.kind !== 'asr') || tracks.find(t => /^en/.test(t.languageCode)) || tracks[0];
  if (pick && pick.baseUrl) {
    try {
      const r = await fetch(pick.baseUrl + '&fmt=json3', { credentials: 'include' });
      const j = await r.json();
      for (const ev of j.events || []) {
        const t = (ev.segs || []).map(s => s.utf8).join('').trim();
        if (t) out.lines.push([Math.floor((ev.tStartMs || 0) / 1000), t]);
      }
    } catch (e) {}
  }
  out.language = pick ? pick.languageCode : undefined;
  return out;
})()`;

function stamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(h > 0 ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
}

/** Group caption lines into ~30 second paragraphs with a timestamp each. */
function transcriptText(lines: [number, string][]): string {
  const out: string[] = [];
  let bucketStart = -1;
  let bucket: string[] = [];
  for (const [t, text] of lines) {
    if (bucketStart < 0) bucketStart = t;
    if (t - bucketStart >= 30 && bucket.length > 0) {
      out.push(`[${stamp(bucketStart)}] ${bucket.join(' ')}`);
      bucket = [];
      bucketStart = t;
    }
    bucket.push(text.replace(/\s+/g, ' '));
  }
  if (bucket.length > 0) out.push(`[${stamp(bucketStart)}] ${bucket.join(' ')}`);
  return out.join('\n');
}

/** True for a WebVTT or SRT file, as opposed to a script that mentions "-->". */
export function looksLikeCaptions(body: string): boolean {
  const head = body.replace(/^\uFEFF/, '').trimStart().slice(0, 200);
  return /^WEBVTT/.test(head) || /^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(head);
}

/** WebVTT / SRT captions to timestamped text. */
export function captionsToText(vtt: string): string {
  const lines: [number, string][] = [];
  const blocks = vtt.replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const m = /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,]\d{3}\s*-->/.exec(block);
    if (!m) continue;
    const seconds = Number(m[1] ? m[1].slice(0, -1) : 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    const text = block
      .split('\n')
      .filter((l) => !/-->/.test(l) && !/^\d+$/.test(l.trim()) && !/^WEBVTT/.test(l))
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (text) lines.push([seconds, text]);
  }
  return transcriptText(lines);
}

async function readYouTube(ctx: Ctx, url: URL): Promise<LinkReadResult> {
  const id = youtubeId(url);
  if (!id) return readWebPage(ctx);
  const rendered = await readRendered(ctx, `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, { evaluate: YOUTUBE_SCRIPT });
  if (!('page' in rendered)) return rendered;
  const info = (rendered.page.evaluated ?? {}) as {
    title?: string;
    author?: string;
    seconds?: number;
    description?: string;
    lines?: [number, string][];
  };
  const header = [
    info.title ? `Title: ${info.title}` : null,
    info.author ? `Channel: ${info.author}` : null,
    info.seconds ? `Length: ${stamp(info.seconds)}` : null,
    info.description ? `Description: ${info.description}` : null,
  ].filter(Boolean).join('\n');
  const transcript = info.lines && info.lines.length > 0 ? transcriptText(info.lines) : '';
  return {
    url: ctx.url,
    kind: ctx.kind,
    status: header || transcript ? 'ok' : 'not_readable',
    finalUrl: rendered.page.finalUrl,
    title: info.title ?? (rendered.page.title || undefined),
    format: transcript ? 'youtube video with transcript' : 'youtube video (no transcript available)',
    text: [header, transcript ? `Transcript:\n${transcript}` : ''].filter(Boolean).join('\n\n') || undefined,
    note: transcript
      ? undefined
      : 'YouTube does not hand transcripts to automated tools, so only the title, channel, length and description are included. ' +
        'To get the transcript, open the video, click "...more" under it, then "Show transcript", and paste it in.',
  };
}

function findStrings(obj: unknown, keyTest: RegExp, out: string[] = []): string[] {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'string' && keyTest.test(k) && v.length > 0) out.push(v);
    else if (v && typeof v === 'object') findStrings(v, keyTest, out);
  }
  return out;
}

async function readZoomRecording(ctx: Ctx): Promise<LinkReadResult> {
  const rendered = await readRendered(ctx, ctx.url, { capture: /\/(nws\/recording|rec\/play|rec\/share)\/.*(info|transcript|vtt)/i, settleMs: 1500 });
  if (!('page' in rendered)) return rendered;
  const { page } = rendered;
  if (/passcode/i.test(page.text) && page.text.length < 3000) {
    return {
      url: ctx.url,
      kind: ctx.kind,
      status: 'needs_passcode',
      finalUrl: page.finalUrl,
      signIn: { service: 'Zoom (passcode)', connect: ctx.url },
      note:
        'This Zoom recording is protected by a passcode (usually posted next to the link). Ask again in a moment and a ' +
        'window will open on the recording for the student to type the passcode. Zoom remembers it after that.',
    };
  }
  // The player's info API names the transcript and caption files.
  const candidates: string[] = [];
  for (const c of page.captured) {
    if (looksLikeCaptions(c.body)) candidates.unshift(c.url);
    try {
      candidates.push(...findStrings(JSON.parse(c.body), /^(transcriptUrl|ccUrl|vttUrl|transcript_url)$/i));
    } catch {
      /* not JSON */
    }
  }
  const title = findStrings(page.captured.map((c) => { try { return JSON.parse(c.body) as unknown; } catch { return null; } }), /^topic$/i)[0] ?? page.title;
  for (const candidate of candidates) {
    try {
      const abs = new URL(candidate, page.finalUrl).toString();
      const resp = await ctx.ext.fetch(abs, { maxBytes: 20 * 1024 * 1024 });
      const body = resp.bytes.toString('utf8');
      if (resp.status === 200 && looksLikeCaptions(body)) {
        return {
          url: ctx.url,
          kind: ctx.kind,
          status: 'ok',
          finalUrl: page.finalUrl,
          title,
          format: 'zoom recording transcript',
          text: captionsToText(body),
        };
      }
    } catch {
      /* try the next one */
    }
  }
  return {
    url: ctx.url,
    kind: ctx.kind,
    status: 'not_readable',
    finalUrl: page.finalUrl,
    title,
    format: 'zoom recording (no transcript)',
    text: tidy(page.text) || undefined,
    note: 'This Zoom recording has no transcript (the host did not turn on audio transcripts), so only the page text is included.',
  };
}

async function readPanopto(ctx: Ctx, url: URL): Promise<LinkReadResult> {
  const id = url.searchParams.get('id');
  if (id) {
    try {
      const srt = await ctx.ext.fetch(`${url.origin}/Panopto/Pages/Transcription/GenerateSRT.ashx?id=${encodeURIComponent(id)}&language=0`);
      const body = srt.bytes.toString('utf8');
      if (srt.status === 200 && looksLikeCaptions(body)) {
        return { url: ctx.url, kind: ctx.kind, status: 'ok', finalUrl: srt.finalUrl, format: 'panopto captions', text: captionsToText(body) };
      }
    } catch {
      /* fall back to the page */
    }
  }
  return readWebPage(ctx);
}

async function readCaptionedVideoPage(ctx: Ctx, label: string): Promise<LinkReadResult> {
  // Kaltura and Vimeo players fetch caption files as they load; keep them.
  const rendered = await readRendered(ctx, ctx.url, { capture: /caption|subtitle|\.vtt|\.srt|texttrack/i, settleMs: 3000 });
  if (!('page' in rendered)) return rendered;
  const { page } = rendered;
  const caption = page.captured.find((c) => looksLikeCaptions(c.body));
  const pageText = tidy(page.text);
  if (caption) {
    return {
      url: ctx.url,
      kind: ctx.kind,
      status: 'ok',
      finalUrl: page.finalUrl,
      title: page.title || undefined,
      format: `${label} with captions`,
      text: `${pageText.slice(0, 1500)}\n\nTranscript:\n${captionsToText(caption.body)}`,
    };
  }
  return {
    url: ctx.url,
    kind: ctx.kind,
    status: pageText ? 'ok' : 'not_readable',
    finalUrl: page.finalUrl,
    title: page.title || undefined,
    format: `${label} (no captions found)`,
    text: pageText || undefined,
    note: 'No captions were found for this video, so only the page text is included.',
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ReadLinkOptions {
  /** Downloads subfolder, e.g. the course code. */
  subfolder?: string;
}

export async function readLink(http: BBHttp, rawUrl: string, opts: ReadLinkOptions = {}): Promise<LinkReadResult> {
  const ext = http.external;
  if (!ext) {
    throw new BlackboardError('BLACKBOARD_REQUEST_FAILED', 'Opening outside links is not available in this session.');
  }
  const url = new URL(rawUrl);
  const kind = classifyLink(rawUrl);
  const ctx: Ctx = { http, ext, url: rawUrl, kind, subfolder: opts.subfolder ?? 'links' };
  const id = googleId(url);

  switch (kind) {
    case 'zoom-meeting':
      return {
        url: rawUrl,
        kind,
        status: 'live_meeting',
        note: 'This is a link to join a live Zoom meeting (class or office hours), not a recording. It was not opened. The meeting ID is in the link.',
      };
    case 'blackboard-file': {
      // Through the Blackboard session itself, which knows which of SU's two
      // Blackboard hostnames holds the sign-in; a copied link may name the other.
      const resp = await http.fetchBuffer(`${url.pathname}${url.search}`);
      if (resp.status !== 200) {
        return { url: rawUrl, kind, status: 'not_readable', note: `Blackboard would not hand over that file (HTTP ${resp.status}).` };
      }
      return fileResult(ctx, { ...resp, finalUrl: rawUrl }, url.pathname.split('/').pop() || 'file');
    }
    case 'blackboard-page':
      return {
        url: rawUrl,
        kind,
        status: 'not_readable',
        note: 'This is a page inside Blackboard. Use get_course_content, get_announcements or get_assignment_context instead.',
      };
    case 'google-doc':
      return id ? readGoogleExport(ctx, `https://docs.google.com/document/d/${id}/export?format=docx`, `${id}.docx`, 'google doc') : readWebPage(ctx);
    case 'google-sheet':
      // xlsx rather than csv: csv only ever returns one tab.
      return id ? readGoogleExport(ctx, `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, `${id}.xlsx`, 'google sheet') : readWebPage(ctx);
    case 'google-slides':
      // pptx keeps the speaker notes, which are often where the lecture is.
      return id ? readGoogleExport(ctx, `https://docs.google.com/presentation/d/${id}/export/pptx`, `${id}.pptx`, 'google slides') : readWebPage(ctx);
    case 'google-drive-file':
      return id ? readDriveFile(ctx, id) : readWebPage(ctx);
    case 'google-drive-folder':
      return id ? readDriveFolder(ctx, id) : readWebPage(ctx);
    case 'google-colab':
      return readColab(ctx, url);
    case 'youtube':
      return readYouTube(ctx, url);
    case 'zoom-recording':
      return readZoomRecording(ctx);
    case 'panopto':
      return readPanopto(ctx, url);
    case 'kaltura':
      return readCaptionedVideoPage(ctx, 'video');
    case 'vimeo':
      return readCaptionedVideoPage(ctx, 'vimeo video');
    case 'dropbox': {
      const direct = new URL(rawUrl);
      direct.searchParams.set('dl', '1');
      return readWebPage(ctx, direct.toString());
    }
    case 'microsoft-365': {
      // SharePoint/OneDrive share links hand back the file itself with download=1.
      if (/sharepoint\.com$/i.test(url.hostname) && /\/:[a-z]:\//i.test(url.pathname)) {
        const direct = new URL(rawUrl);
        direct.searchParams.set('download', '1');
        const got = await fetchFileOrSignIn(ctx, direct.toString(), 'document').catch(() => null);
        if (got && !('html' in got)) return got;
      }
      return readWebPage(ctx);
    }
    case 'github': {
      const blob = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
      if (url.hostname === 'github.com' && blob) {
        return readWebPage(ctx, `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`);
      }
      // A repository's front page is mostly menus; its README is the content.
      const repo = /^\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
      if (url.hostname === 'github.com' && repo) {
        const readme = await ctx.ext.fetch(`https://raw.githubusercontent.com/${repo[1]}/${repo[2]}/HEAD/README.md`).catch(() => null);
        if (readme && readme.status === 200 && !isHtml(readme)) {
          return {
            url: ctx.url,
            kind: ctx.kind,
            status: 'ok',
            finalUrl: ctx.url,
            title: `${repo[1]}/${repo[2]}`,
            format: 'github repository README',
            text: readme.bytes.toString('utf8'),
          };
        }
      }
      return readWebPage(ctx);
    }
    case 'google-form':
    case 'microsoft-form':
      // Read the questions only. Nothing is ever filled in or submitted.
      return readWebPage(ctx).then((r) => ({
        ...r,
        format: r.status === 'ok' ? 'form (questions only, nothing submitted)' : r.format,
      }));
    default:
      return readWebPage(ctx);
  }
}
