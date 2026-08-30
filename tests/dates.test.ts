import { describe, expect, it } from 'vitest';
import { parseBBDate, stripHtml, titlesMatch, withinWindow } from '../src/blackboard/util.js';

describe('parseBBDate', () => {
  it('parses ISO strings', () => {
    const d = parseBBDate('2026-09-05T23:59:00.000Z');
    expect(d?.toISOString()).toBe('2026-09-05T23:59:00.000Z');
  });

  it('parses date-only strings', () => {
    const d = parseBBDate('2026-08-24');
    expect(d?.getUTCFullYear()).toBe(2026);
    expect(d?.getUTCMonth()).toBe(7);
    expect(d?.getUTCDate()).toBe(24);
  });

  it('parses epoch millis numbers', () => {
    const d = parseBBDate(1788000000000);
    expect(d?.getTime()).toBe(1788000000000);
  });

  it('parses legacy .NET /Date(...) strings', () => {
    const d = parseBBDate('/Date(1788000000000)/');
    expect(d?.getTime()).toBe(1788000000000);
  });

  it('returns undefined for garbage and empties', () => {
    expect(parseBBDate('not a date')).toBeUndefined();
    expect(parseBBDate('')).toBeUndefined();
    expect(parseBBDate(null)).toBeUndefined();
    expect(parseBBDate(undefined)).toBeUndefined();
    expect(parseBBDate(0)).toBeUndefined();
  });
});

describe('withinWindow', () => {
  it('includes dates inside the window', () => {
    expect(withinWindow('2026-09-05T23:59:00.000Z', { after: '2026-09-01', before: '2026-09-10' })).toBe(true);
  });

  it('excludes dates before "after"', () => {
    expect(withinWindow('2026-08-01', { after: '2026-09-01' })).toBe(false);
  });

  it('excludes dates after "before"', () => {
    expect(withinWindow('2026-10-01', { before: '2026-09-10' })).toBe(false);
  });

  it('excludes undated items', () => {
    expect(withinWindow(undefined, {})).toBe(false);
  });
});

describe('stripHtml', () => {
  it('strips tags and decodes entities', () => {
    // </p> and <br> each render a newline; adjacent block tags give a blank line.
    expect(stripHtml('<p>Hello &amp; welcome</p><br>Second line')).toBe('Hello & welcome\n\nSecond line');
  });

  it('removes script and style blocks', () => {
    expect(stripHtml('<script>alert(1)</script><style>.x{}</style><p>Text</p>')).toBe('Text');
  });
});

describe('titlesMatch', () => {
  it('matches leniently across formatting', () => {
    expect(titlesMatch('Problem Set 1', 'problem set 1!')).toBe(true);
  });

  it('does not match different titles or short strings', () => {
    expect(titlesMatch('Problem Set 1', 'Problem Set 2')).toBe(false);
    expect(titlesMatch('HW', 'HW')).toBe(false);
    expect(titlesMatch(undefined, 'Problem Set 1')).toBe(false);
  });
});
