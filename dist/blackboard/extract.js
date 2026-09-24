import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { stripHtml } from './util.js';
const MAX_EXTRACT_CHARS = 2_000_000;
function extOf(fileName) {
    return fileName ? path.extname(fileName).toLowerCase() : '';
}
function decodeXml(s) {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&amp;/g, '&');
}
/** Only the XML parts that hold text, never embedded media. */
const TEXT_PART = /^(word\/[^/]+\.xml|ppt\/(slides|notesSlides)\/[^/]+\.xml|xl\/[^/]+\.xml|xl\/worksheets\/[^/]+\.xml|xl\/_rels\/workbook\.xml\.rels)$/;
const MAX_PART_BYTES = 50 * 1024 * 1024;
function unzip(bytes) {
    try {
        // Unpacking everything meant a slide deck full of video (or a tiny file
        // built to expand to gigabytes) was blown up in memory in full.
        return unzipSync(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
            filter: (f) => TEXT_PART.test(f.name) && f.originalSize <= MAX_PART_BYTES,
        });
    }
    catch {
        return null;
    }
}
/** Paragraph-aware text out of Office XML (Word runs <w:t>, PowerPoint runs <a:t>). */
function officeXmlText(xml, runTag, paraTag) {
    return decodeXml(xml
        .replace(new RegExp(`</${paraTag}>`, 'g'), '\n')
        .replace(/<w:tab\/>|<a:tab\/>/g, '\t')
        .replace(/<w:br\/>|<a:br\/>/g, '\n')
        .replace(new RegExp(`<(?!/?${runTag}[ >])[^>]+>`, 'g'), '')
        .replace(new RegExp(`</?${runTag}[^>]*>`, 'g'), ''))
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
function numbered(files, prefix) {
    return Object.keys(files)
        .filter((n) => prefix.test(n))
        .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0));
}
function docxText(files) {
    const doc = files['word/document.xml'];
    if (!doc)
        return null;
    const parts = [officeXmlText(strFromU8(doc), 'w:t', 'w:p')];
    for (const name of Object.keys(files).filter((n) => /^word\/(footnotes|endnotes)\.xml$/.test(n))) {
        const t = officeXmlText(strFromU8(files[name]), 'w:t', 'w:p');
        if (t)
            parts.push(t);
    }
    return { text: parts.join('\n\n'), format: 'docx' };
}
function pptxText(files) {
    const slides = numbered(files, /^ppt\/slides\/slide\d+\.xml$/);
    if (slides.length === 0)
        return null;
    const out = slides.map((name, i) => {
        const body = officeXmlText(strFromU8(files[name]), 'a:t', 'a:p');
        const notesName = `ppt/notesSlides/notesSlide${/(\d+)\.xml$/.exec(name)?.[1]}.xml`;
        const notes = files[notesName] ? officeXmlText(strFromU8(files[notesName]), 'a:t', 'a:p') : '';
        return `--- Slide ${i + 1} ---\n${body}${notes ? `\n[Speaker notes] ${notes}` : ''}`;
    });
    return { text: out.join('\n\n'), format: `pptx (${slides.length} slides)` };
}
function columnIndex(ref) {
    const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
    let n = 0;
    for (const ch of letters)
        n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}
function csvCell(v) {
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
/**
 * Which cell styles are dates or times. Spreadsheets store a date as a day
 * count (46289 = 2026-09-21) and only the style says so; without this, a
 * schedule or office-hours sheet reads as a column of meaningless numbers.
 */
function dateStyles(files) {
    const out = new Map();
    const styles = files['xl/styles.xml'];
    if (!styles)
        return out;
    const xml = strFromU8(styles);
    const custom = new Map();
    for (const m of xml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g))
        custom.set(Number(m[1]), decodeXml(m[2]));
    const kindOf = (id) => {
        if ((id >= 14 && id <= 17) || (id >= 27 && id <= 36) || (id >= 50 && id <= 58))
            return 'date';
        if (id === 22)
            return 'datetime';
        if ((id >= 18 && id <= 21) || (id >= 45 && id <= 47))
            return 'time';
        const code = custom.get(id)?.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '').toLowerCase();
        if (!code)
            return null;
        const hasDate = /[dy]/.test(code) || /(^|[^h:])m{3,}/.test(code);
        const hasTime = /h|ss/.test(code);
        if (hasDate && hasTime)
            return 'datetime';
        if (hasDate)
            return 'date';
        if (hasTime)
            return 'time';
        return null;
    };
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
    [...xfs.matchAll(/<xf\b[^>]*?numFmtId="(\d+)"/g)].forEach((m, i) => {
        const kind = kindOf(Number(m[1]));
        if (kind)
            out.set(i, kind);
    });
    return out;
}
/** A spreadsheet day count as a readable date and/or time. */
export function serialToDate(serial, kind) {
    const ms = Math.round((serial - 25569) * 86400) * 1000;
    const iso = new Date(ms).toISOString();
    if (kind === 'date')
        return iso.slice(0, 10);
    if (kind === 'time')
        return iso.slice(11, 16);
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
function xlsxText(files) {
    const workbook = files['xl/workbook.xml'];
    if (!workbook)
        return null;
    const shared = [];
    const sst = files['xl/sharedStrings.xml'];
    if (sst) {
        for (const si of strFromU8(sst).match(/<si>[\s\S]*?<\/si>/g) ?? []) {
            shared.push(decodeXml((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
        }
    }
    // Sheet names live in workbook.xml; which file holds each sheet is in its rels.
    const rels = files['xl/_rels/workbook.xml.rels'] ? strFromU8(files['xl/_rels/workbook.xml.rels']) : '';
    const target = (rid) => {
        const m = new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels);
        const t = m?.[1] ?? m?.[2];
        return t ? `xl/${t.replace(/^\/?xl\//, '')}` : undefined;
    };
    const dates = dateStyles(files);
    const sheets = [...strFromU8(workbook).matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)];
    const out = [];
    sheets.forEach(([, name, rid], i) => {
        const file = files[target(rid) ?? `xl/worksheets/sheet${i + 1}.xml`];
        if (!file)
            return;
        const rows = [];
        for (const row of strFromU8(file).match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
            const cells = [];
            for (const c of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
                const ref = /\br="([A-Z]+\d+)"/.exec(c)?.[1] ?? '';
                const type = /\bt="([^"]+)"/.exec(c)?.[1];
                const v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1];
                let value = '';
                if (type === 's' && v !== undefined)
                    value = shared[Number(v)] ?? '';
                else if (type === 'inlineStr')
                    value = decodeXml((c.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join(''));
                else if (v !== undefined) {
                    const style = dates.get(Number(/\bs="(\d+)"/.exec(c)?.[1] ?? -1));
                    const n = Number(v);
                    value = style && type !== 'str' && type !== 'e' && Number.isFinite(n) ? serialToDate(n, style) : decodeXml(v);
                }
                const idx = ref ? columnIndex(ref) : cells.length;
                while (cells.length < idx)
                    cells.push('');
                cells[idx] = csvCell(value);
            }
            if (cells.some((c) => c !== ''))
                rows.push(cells.join(','));
        }
        out.push(`--- Sheet: ${decodeXml(name ?? `Sheet${i + 1}`)} ---\n${rows.join('\n')}`);
    });
    return out.length > 0 ? { text: out.join('\n\n'), format: `xlsx (${out.length} sheets)` } : null;
}
function notebookText(bytes) {
    try {
        const nb = JSON.parse(bytes.toString('utf8'));
        if (!Array.isArray(nb.cells))
            return null;
        const text = nb.cells
            .map((c) => {
            const src = Array.isArray(c.source) ? c.source.join('') : (c.source ?? '');
            return c.cell_type === 'code' ? `[code]\n${src}` : src;
        })
            .join('\n\n');
        return { text, format: 'jupyter notebook' };
    }
    catch {
        return null;
    }
}
async function pdfText(bytes) {
    try {
        const { extractText, getDocumentProxy } = await import('unpdf');
        // verbosity 0: errors only. pdf.js prints its warnings with console.log,
        // and in the MCP server stdout is the protocol channel itself.
        const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
        const { totalPages, text } = await extractText(pdf, { mergePages: false });
        const pages = text.map((t, i) => `--- Page ${i + 1} ---\n${t.trim()}`);
        const joined = pages.join('\n\n');
        // A scanned PDF has pages but no text layer; say so rather than return blanks.
        if (joined.replace(/--- Page \d+ ---/g, '').trim().length === 0) {
            return { text: '', format: `pdf (${totalPages} pages, scanned images with no text layer)` };
        }
        return { text: joined, format: `pdf (${totalPages} pages)` };
    }
    catch {
        return null;
    }
}
const PLAIN_TEXT_EXT = new Set([
    '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.log', '.srt', '.vtt', '.py', '.java', '.c', '.cpp', '.h',
    '.js', '.ts', '.r', '.sql', '.tex', '.yml', '.yaml', '.rtf', '.sh', '.rb', '.go', '.rs', '.kt', '.swift',
]);
/** Best-effort text for any file Blackboard or a linked site hands back. */
export async function extractText(bytes, fileName, mimeType) {
    const ext = extOf(fileName);
    const mime = (mimeType ?? '').toLowerCase().split(';')[0].trim();
    let result = null;
    const isPdf = ext === '.pdf' || mime === 'application/pdf' || bytes.subarray(0, 5).toString('latin1') === '%PDF-';
    const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
    if (isPdf) {
        result = await pdfText(bytes);
    }
    else if (ext === '.ipynb') {
        result = notebookText(bytes);
    }
    else if (isZip && ['.docx', '.pptx', '.xlsx', ''].includes(ext) || mime.includes('officedocument')) {
        const files = unzip(bytes);
        if (files)
            result = docxText(files) ?? pptxText(files) ?? xlsxText(files);
    }
    else if (ext === '.html' || ext === '.htm' || mime === 'text/html') {
        result = { text: stripHtml(bytes.toString('utf8')), format: 'html' };
    }
    else if (PLAIN_TEXT_EXT.has(ext) || mime.startsWith('text/') || mime === 'application/json') {
        result = { text: bytes.toString('utf8'), format: ext ? ext.slice(1) : 'text' };
    }
    if (result && result.text.length > MAX_EXTRACT_CHARS) {
        result = { ...result, text: result.text.slice(0, MAX_EXTRACT_CHARS) };
    }
    return result;
}
/** Default size of one page of text handed back to the AI. */
export const TEXT_PAGE_CHARS = 20_000;
/**
 * One window of a long text, so a 90-page PDF can be read in pieces instead
 * of being cut off after the first screen. `next_offset` is null at the end.
 */
export function textWindow(text, offset = 0, size = TEXT_PAGE_CHARS) {
    const start = Math.max(0, Math.min(offset, text.length));
    const end = Math.min(text.length, start + size);
    return { text: text.slice(start, end), offset: start, total_chars: text.length, next_offset: end < text.length ? end : null };
}
