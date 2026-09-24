import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { extractText, serialToDate, textWindow } from '../src/blackboard/extract.js';
import { captionsToText, looksLikeCaptions } from '../src/blackboard/external.js';

const zip = (files: Record<string, string>): Buffer =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));

describe('extractText', () => {
  it('reads Word paragraphs in order', async () => {
    const docx = zip({
      'word/document.xml':
        '<w:document><w:body><w:p><w:r><w:t>Essay 2</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Due </w:t></w:r><w:r><w:t>Friday &amp; late</w:t></w:r></w:p></w:body></w:document>',
    });
    const out = await extractText(docx, 'prompt.docx');
    expect(out).toMatchObject({ format: 'docx' });
    expect(out?.text).toBe('Essay 2\nDue Friday & late');
  });

  it('reads PowerPoint slides in numeric order, with speaker notes', async () => {
    const pptx = zip({
      'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>Ten</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Two</a:t></a:r></a:p></p:sld>',
      'ppt/notesSlides/notesSlide2.xml': '<p:notes><a:p><a:r><a:t>Say this</a:t></a:r></a:p></p:notes>',
    });
    const out = await extractText(pptx, 'lecture.pptx');
    expect(out?.format).toBe('pptx (2 slides)');
    expect(out?.text).toBe('--- Slide 1 ---\nTwo\n[Speaker notes] Say this\n\n--- Slide 2 ---\nTen');
  });

  it('reads every sheet of a workbook, with dates as dates', async () => {
    const xlsx = zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Office Hours" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Room</t></si><si><t>Bowne, 103</t></si></sst>',
      'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" s="1"><v>46289</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>3.5</v></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hi</t></is></c></row></sheetData></worksheet>',
    });
    const out = await extractText(xlsx, 'sheet.xlsx');
    expect(out?.format).toBe('xlsx (2 sheets)');
    expect(out?.text).toBe('--- Sheet: Office Hours ---\nRoom,,2026-09-24\n"Bowne, 103",3.5\n\n--- Sheet: Notes ---\nhi');
  });

  it('reads Jupyter / Colab notebooks', async () => {
    const nb = Buffer.from(JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# Lab 0'] }, { cell_type: 'code', source: 'print(1)' }] }));
    const out = await extractText(nb, 'Lab0a.ipynb');
    expect(out?.text).toBe('# Lab 0\n\n[code]\nprint(1)');
  });

  it('never unpacks embedded media, only the text parts', async () => {
    const pptx = zip({
      'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Hi</a:t></a:r></a:p></p:sld>',
      'ppt/media/lecture.mp4': 'x'.repeat(2_000_000),
    });
    const out = await extractText(pptx, 'deck.pptx');
    expect(out?.text).toBe('--- Slide 1 ---\nHi');
  });

  it('returns null for things that are not text, instead of throwing', async () => {
    expect(await extractText(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'photo.png', 'image/png')).toBeNull();
    expect(await extractText(Buffer.from('PK\u0003\u0004garbage'), 'broken.docx')).toBeNull();
  });
});

describe('spreadsheet dates', () => {
  it('turns day counts into dates and times', () => {
    expect(serialToDate(46289, 'date')).toBe('2026-09-24');
    expect(serialToDate(0.5, 'time')).toBe('12:00');
    expect(serialToDate(46289.75, 'datetime')).toBe('2026-09-24 18:00');
  });
});

describe('textWindow', () => {
  it('pages through long text and signals the end', () => {
    const text = 'a'.repeat(25);
    expect(textWindow(text, 0, 10)).toMatchObject({ text: 'a'.repeat(10), next_offset: 10, total_chars: 25 });
    expect(textWindow(text, 20, 10)).toMatchObject({ text: 'a'.repeat(5), next_offset: null });
  });
});

describe('captions', () => {
  it('recognises SRT and VTT but not a script that mentions "-->"', () => {
    expect(looksLikeCaptions('1\n00:00:06,200 --> 00:00:08,320\nUs\n')).toBe(true);
    expect(looksLikeCaptions('WEBVTT\n\n00:01.000 --> 00:02.000\nhi')).toBe(true);
    expect(looksLikeCaptions('mw.loader.implement("x", function(){ /* <!-- --> */ })')).toBe(false);
  });

  it('groups captions into timestamped paragraphs', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:05,000 --> 00:00:06,000\nclass\n\n3\n00:00:40,000 --> 00:00:41,000\nNext';
    expect(captionsToText(srt)).toBe('[0:01] Hello class\n[0:40] Next');
  });
});
