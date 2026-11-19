import {describe, expect, it} from 'vitest';

import {attachmentHeader, csvCell, csvExport, type CsvValue, parseCsv, toCsv, UTF8_BOM} from '../src/server/csv';

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

describe('csvExport', () => {
  async function* from(pages: CsvValue[][][], log: string[] = []): AsyncGenerator<CsvValue[][]> {
    try {
      for (const page of pages) {
        log.push('read');
        yield page;
      }
    } finally {
      log.push('closed');
    }
  }

  it('reads every page before it resolves: header first, BOM once, CRLF rows', async () => {
    const log: string[] = [];
    const out = await csvExport(['Name'], from([[['a'], ['b']], [], [['c']]], log), 10);
    expect(out).toEqual({csv: `${UTF8_BOM}Name\r\na\r\nb\r\nc\r\n`, rows: 3, truncated: false});
    expect(log).toEqual(['read', 'read', 'read', 'closed']);
  });

  it('writes only the header when there are no rows', async () => {
    expect(await csvExport(['Name', 'Email'], from([]), 5)).toEqual({csv: `${UTF8_BOM}Name,Email\r\n`, rows: 0, truncated: false});
  });

  it('stops at the cap, flags truncation, and ends the page source', async () => {
    const log: string[] = [];
    const out = await csvExport(['n'], from([[[1], [2]], [[3], [4]], [[5]]], log), 3);
    expect(out.rows).toBe(3);
    expect(out.truncated).toBe(true);
    expect(parseCsv(out.csv)).toEqual([['n'], ['1'], ['2'], ['3']]);
    // The third page is never read: the source was closed as soon as the cap was passed.
    expect(log).toEqual(['read', 'read', 'closed']);
  });

  it('is not truncated when the rows end exactly at the cap', async () => {
    const out = await csvExport(['n'], from([[[1], [2]], []]), 2);
    expect(out).toMatchObject({rows: 2, truncated: false});
  });

  it('rejects when a page read fails, so the route answers an error, never a cut file', async () => {
    async function* failing(): AsyncGenerator<CsvValue[][]> {
      yield [['a']];
      throw new Error('db down');
    }
    await expect(csvExport(['n'], failing(), 10)).rejects.toThrow('db down');
  });
});
