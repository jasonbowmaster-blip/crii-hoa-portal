import { describe, expect, it } from 'vitest';
import { buildExportFiles, buildManifest, EXPORT_TABLES, fetchAllRows, PAGE_SIZE, toCsv, type PageResult } from './export.ts';

describe('export', () => {
  it('quotes commas, quotes and newlines; empties null', () => {
    expect(toCsv([{ a: 'x,y', b: 'say "hi"', c: null, d: 'l1\nl2' }])).toBe('a,b,c,d\n"x,y","say ""hi""",,"l1\nl2"\n');
  });
  it('neutralises spreadsheet formulas', () => {
    expect(toCsv([{ a: '=SUM(A1)' }])).toBe("a\n'=SUM(A1)\n");
  });
  it('builds csv and json per table', () => {
    const files = buildExportFiles({ lots: [{ id: 1 }] }, '2027-01-01');
    expect(files.map((f) => f.path)).toEqual(['2027-01-01/lots.csv', '2027-01-01/lots.json', '2027-01-01/manifest.json']);
  });
  it('writes the manifest last, with row counts per table', () => {
    const files = buildExportFiles({ lots: [{ id: 1 }, { id: 2 }], holidays: [] }, '2027-01-01', '2027-01-01T03:00:00Z');
    expect(files[files.length - 1].path).toBe('2027-01-01/manifest.json');
    expect(JSON.parse(files[files.length - 1].content)).toEqual({
      folder: '2027-01-01', generated_at: '2027-01-01T03:00:00Z', complete: true, total_rows: 2,
      tables: { lots: { rows: 2, files: ['lots.csv', 'lots.json'] }, holidays: { rows: 0, files: ['holidays.csv', 'holidays.json'] } },
    });
    expect(buildManifest({}, 'f', 't').total_rows).toBe(0);
  });
});

describe('export inventory', () => {
  const names = EXPORT_TABLES.map((t) => t.name);
  it('covers audit history, mail and notice history, holidays and claim-code state', () => {
    for (const n of ['audit_log', 'mail_log', 'notice_consents', 'holidays', 'claim_codes', 'lots', 'owners', 'ledger_entries', 'invoices', 'checks']) expect(names).toContain(n);
  });
  it('has no duplicates and a stable order for every table', () => {
    expect(new Set(names).size).toBe(names.length);
    for (const t of EXPORT_TABLES) expect(t.order.length).toBeGreaterThan(0);
  });
  it('reads claim codes as hashes and dates only, never with *', () => {
    const t = EXPORT_TABLES.find((x) => x.name === 'claim_codes')!;
    expect(t.columns).not.toBe('*');
    expect(t.columns.split(',').map((c) => c.trim())).toEqual(['id', 'lot_id', 'code_hash', 'expires_at', 'used_at', 'attempts']);
  });
});

describe('fetchAllRows', () => {
  const table = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));
  // a fake PostgREST: honours the range, caps nothing itself (the pager must not rely on that)
  const source = (rows: { id: number }[], opts: { count?: boolean } = {}) => {
    const calls: [number, number][] = [];
    const fetchPage = async (from: number, to: number): Promise<PageResult<{ id: number }>> => {
      calls.push([from, to]);
      return { data: rows.slice(from, to + 1), error: null, count: opts.count && from === 0 ? rows.length : undefined };
    };
    return { fetchPage, calls };
  };
  it('pages in 1000s until a short page, and returns every row once', async () => {
    const s = source(table(2500));
    const rows = await fetchAllRows(s.fetchPage);
    expect(rows).toHaveLength(2500);
    expect(rows[0].id).toBe(0);
    expect(rows[2499].id).toBe(2499);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2500);
    expect(s.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(PAGE_SIZE).toBe(1000);
  });
  it('an exact multiple of the page size ends on an empty page', async () => {
    const s = source(table(2000));
    expect(await fetchAllRows(s.fetchPage)).toHaveLength(2000);
    expect(s.calls).toHaveLength(3);
  });
  it('handles an empty table and a single short page', async () => {
    expect(await fetchAllRows(source([]).fetchPage)).toEqual([]);
    const s = source(table(7));
    expect(await fetchAllRows(s.fetchPage)).toHaveLength(7);
    expect(s.calls).toHaveLength(1);
  });
  it('fails on a read error instead of returning a partial table', async () => {
    let n = 0;
    await expect(fetchAllRows(async () => (n++ === 0 ? { data: table(1000), error: null } : { data: null, error: { message: 'boom' } }))).rejects.toThrow('boom');
  });
  it('fails when the rows read do not match the exact count', async () => {
    const rows = table(1500);
    await expect(fetchAllRows(async (from, to) => ({ data: rows.slice(from, to + 1).slice(0, from === 0 ? 1000 : 400), error: null, count: from === 0 ? 1500 : undefined })))
      .rejects.toThrow('read 1400 rows but the table has 1500');
    expect(await fetchAllRows(source(rows, { count: true }).fetchPage)).toHaveLength(1500);
  });
  it('stops a runaway source', async () => {
    await expect(fetchAllRows(async () => ({ data: table(1000), error: null }), 1000, 5)).rejects.toThrow('too many pages');
  });
});
