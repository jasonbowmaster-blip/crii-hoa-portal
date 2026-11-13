import { describe, expect, it } from 'vitest';
import { buildExportFiles, toCsv } from './export.ts';

describe('export', () => {
  it('quotes commas, quotes and newlines; empties null', () => {
    expect(toCsv([{ a: 'x,y', b: 'say "hi"', c: null, d: 'l1\nl2' }])).toBe('a,b,c,d\n"x,y","say ""hi""",,"l1\nl2"\n');
  });
  it('neutralises spreadsheet formulas', () => {
    expect(toCsv([{ a: '=SUM(A1)' }])).toBe("a\n'=SUM(A1)\n");
  });
  it('builds csv and json per table', () => {
    const files = buildExportFiles({ lots: [{ id: 1 }] }, '2027-01-01');
    expect(files.map((f) => f.path)).toEqual(['2027-01-01/lots.csv', '2027-01-01/lots.json']);
  });
});
