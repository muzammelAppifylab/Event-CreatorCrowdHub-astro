import {describe, expect, it} from 'vitest';

import {attachmentHeader, csvCell, parseCsv, toCsv, UTF8_BOM} from '../src/server/csv';

describe('csv writer', () => {
  it('quotes commas, quotes and newlines per RFC 4180', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('true');
  });

  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell(-5)).toBe('-5');
  });

  it('starts with a BOM and uses CRLF', () => {
    expect(toCsv([['Name'], ['Zoë']])).toBe(`${UTF8_BOM}Name\r\nZoë\r\n`);
    expect(toCsv([['a']], {bom: false})).toBe('a\r\n');
  });

  it('round-trips through parseCsv', () => {
    const rows = [['a', 'b,c', 'd"e'], ['x\ny', '', 'z']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it('builds a safe attachment header', () => {
    expect(attachmentHeader('guests "x"/y.csv')).toBe('attachment; filename="guests-x-y.csv"');
  });
});
