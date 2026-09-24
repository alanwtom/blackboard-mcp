import { isBlackboardHost } from './hosts.js';
import { BASE_URL } from './session.js';

/**
 * Links professors post: the URL of a "link" content item, and every link,
 * embedded video, or iframe inside a document body, assignment instructions,
 * or announcement. Before this existed those bodies were flattened to plain
 * text, so a Google Sheet behind "click here" reached the AI as just the
 * words "click here".
 */

export type LinkKind =
  | 'google-doc'
  | 'google-sheet'
  | 'google-slides'
  | 'google-form'
  | 'google-drive-file'
  | 'google-drive-folder'
  | 'google-colab'
  | 'zoom-recording'
  | 'zoom-meeting'
  | 'youtube'
  | 'vimeo'
  | 'panopto'
  | 'kaltura'
  | 'microsoft-365'
  | 'microsoft-form'
  | 'box'
  | 'dropbox'
  | 'github'
  | 'blackboard-file'
  | 'blackboard-page'
  | 'file'
  | 'web-page';

export interface LinkRef {
  url: string;
  /** Visible link text, when the link had any. */
  label?: string;
  kind: LinkKind;
}

/** Extensions that mean "this URL is a file, not a page". */
const FILE_EXT = /\.(pdf|docx?|pptx?|xlsx?|csv|txt|md|rtf|odt|ods|odp|zip|png|jpe?g|gif|mp3|mp4|m4a|mov|ipynb|py|java|c|cpp|h|js|ts|json|xml|html?|tex|r|sql)$/i;

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** What kind of resource a URL points at, judged from the URL alone. */
export function classifyLink(raw: string): LinkKind {
  let u: URL;
  try {
    u = new URL(raw, BASE_URL);
  } catch {
    return 'web-page';
  }
  const host = u.hostname.toLowerCase();
  const p = u.pathname;
  if (isBlackboardHost(u)) {
    return p.startsWith('/bbcswebdav/') ? 'blackboard-file' : 'blackboard-page';
  }
  if (host === 'docs.google.com') {
    if (p.startsWith('/document/')) return 'google-doc';
    if (p.startsWith('/spreadsheets/')) return 'google-sheet';
    if (p.startsWith('/presentation/')) return 'google-slides';
    if (p.startsWith('/forms/')) return 'google-form';
    if (p.startsWith('/file/')) return 'google-drive-file';
  }
  if (host === 'forms.gle') return 'google-form';
  if (host === 'colab.research.google.com') return 'google-colab';
  if (host === 'drive.google.com' || host === 'drive.usercontent.google.com') {
    if (p.includes('/folders/') || u.searchParams.has('folder') || p.startsWith('/embeddedfolderview')) {
      return 'google-drive-folder';
    }
    return 'google-drive-file';
  }
  if (hostIs(host, 'zoom.us')) {
    if (p.startsWith('/rec/')) return 'zoom-recording';
    if (/^\/(j|w|s|my|wc|meeting|meetings)\//.test(p)) return 'zoom-meeting';
  }
  if (hostIs(host, 'youtube.com') || host === 'youtu.be' || hostIs(host, 'youtube-nocookie.com')) return 'youtube';
  if (hostIs(host, 'vimeo.com')) return 'vimeo';
  if (hostIs(host, 'panopto.com') || hostIs(host, 'panopto.eu')) return 'panopto';
  // Kaltura MediaSpace, including Syracuse's own video.syr.edu.
  if (hostIs(host, 'kaltura.com') || host === 'video.syr.edu' || /^\/media\/(t\/)?[^/]+/.test(p) && host.startsWith('video.')) return 'kaltura';
  if (host === 'forms.office.com' || host === 'forms.microsoft.com') return 'microsoft-form';
  if (hostIs(host, 'sharepoint.com') || host === '1drv.ms' || hostIs(host, 'onedrive.live.com') || hostIs(host, 'office.com') || hostIs(host, 'officeapps.live.com')) {
    return 'microsoft-365';
  }
  if (hostIs(host, 'box.com')) return 'box';
  if (hostIs(host, 'dropbox.com') || hostIs(host, 'dropboxusercontent.com')) return 'dropbox';
  if (host === 'github.com' || host === 'raw.githubusercontent.com' || host === 'gist.github.com') return 'github';
  if (FILE_EXT.test(p) && !/\.html?$/i.test(p)) return 'file';
  return 'web-page';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

function labelText(inner: string): string | undefined {
  const text = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text.slice(0, 200) : undefined;
}

/**
 * Turn an href into an absolute http(s) URL, or null for anything that is not
 * a web link (mailto:, javascript:, in-page anchors, Blackboard's own
 * template placeholders).
 */
export function normalizeHref(href: string): string | null {
  const trimmed = decodeEntities(href.trim());
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.includes('@X@')) return null;
  let u: URL;
  try {
    u = new URL(trimmed, BASE_URL);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return u.toString();
}

/** Every web link in a piece of Blackboard HTML, deduplicated, in reading order. */
export function extractLinks(html: string | undefined): LinkRef[] {
  if (!html) return [];
  const out: LinkRef[] = [];
  const seen = new Set<string>();
  const add = (href: string, label?: string): void => {
    const url = normalizeHref(href);
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, label, kind: classifyLink(url) });
  };

  const anchor = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html)) !== null) add(m[2], labelText(m[3]));

  // Embedded players and documents (YouTube, Zoom, Panopto, Google embeds).
  const embed = /<(?:iframe|embed|video|source|audio)\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi;
  while ((m = embed.exec(html)) !== null) add(m[2], 'embedded content');

  // URLs typed as plain text, which Blackboard does not always turn into links.
  const text = html.replace(/<[^>]+>/g, ' ');
  const bare = /\bhttps?:\/\/[^\s"'<>]+/gi;
  while ((m = bare.exec(text)) !== null) add(m[0].replace(/[.,;:!?)\]]+$/, ''));
  return out;
}

/** Merge link lists, keeping the first (best-labelled) copy of each URL. */
export function mergeLinks(...lists: LinkRef[][]): LinkRef[] {
  const seen = new Set<string>();
  const out: LinkRef[] = [];
  for (const list of lists) {
    for (const link of list) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      out.push(link);
    }
  }
  return out;
}
