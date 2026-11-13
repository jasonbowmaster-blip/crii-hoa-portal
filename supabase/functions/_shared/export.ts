// CSV and JSON serialisation for the nightly backup, plus the storage interface.

// Every table the nightly backup copies, with the columns to read and a stable order for paging.
// Nothing here is a secret: claim_codes holds only the sha256 hash of a code (the code itself is never stored),
// so it is listed with explicit columns rather than '*'.
export interface ExportTable { name: string; columns: string; order: string[] }

export const EXPORT_TABLES: readonly ExportTable[] = [
  { name: 'lots', columns: '*', order: ['id'] },
  { name: 'owners', columns: '*', order: ['id'] },
  { name: 'lot_owners', columns: '*', order: ['lot_id', 'owner_id', 'starts_on'] },
  { name: 'board_members', columns: '*', order: ['user_id'] },
  { name: 'invoices', columns: '*', order: ['id'] },
  { name: 'ledger_entries', columns: '*', order: ['id'] },
  { name: 'checks', columns: '*', order: ['id'] },
  { name: 'messages', columns: '*', order: ['id'] },
  { name: 'documents', columns: '*', order: ['id'] },
  { name: 'events', columns: '*', order: ['id'] },
  { name: 'announcements', columns: '*', order: ['id'] },
  { name: 'board_tasks', columns: '*', order: ['id'] },
  { name: 'reply_templates', columns: '*', order: ['id'] },
  { name: 'claim_requests', columns: '*', order: ['id'] },
  // history
  { name: 'audit_log', columns: '*', order: ['id'] },
  { name: 'notice_consents', columns: '*', order: ['id'] },
  { name: 'mail_log', columns: '*', order: ['id'] },
  { name: 'holidays', columns: '*', order: ['day'] },
  // claim-code state: hashes and dates only
  { name: 'claim_codes', columns: 'id, lot_id, code_hash, expires_at, used_at, attempts', order: ['id'] },
  // money plumbing needed to rebuild the payment picture
  { name: 'processed_events', columns: '*', order: ['id'] },
  { name: 'stripe_outbox', columns: '*', order: ['id'] },
  { name: 'stripe_quarantine', columns: '*', order: ['id'] },
];

export const PAGE_SIZE = 1000;

export interface PageResult<T> { data: T[] | null; error: { message: string } | null; count?: number | null }

// Reads one table in pages of `pageSize` (PostgREST returns at most 1000 rows per request) until a short page.
// fetchPage(from, to) is inclusive on both ends, like .range(). The first page may carry an exact `count`; when it
// does, the total read must match it, so a table that changed or was cut short fails loudly instead of backing up half.
export async function fetchAllRows<T = Record<string, unknown>>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>, pageSize: number = PAGE_SIZE, maxPages = 10000,
): Promise<T[]> {
  const rows: T[] = [];
  let expected: number | null = null;
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const res = await fetchPage(from, from + pageSize - 1);
    if (res.error) throw new Error(res.error.message);
    const data = res.data ?? [];
    if (page === 0 && typeof res.count === 'number') expected = res.count;
    rows.push(...data);
    if (data.length < pageSize) {
      if (expected !== null && rows.length !== expected) throw new Error(`read ${rows.length} rows but the table has ${expected}`);
      return rows;
    }
  }
  throw new Error('too many pages');
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Quote when needed; a leading = + - @ is prefixed with ' so spreadsheets do not run it as a formula.
  const safe = /^[=+\-@]/.test(s) && typeof v === 'string' ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

export interface ExportFile { path: string; content: string; contentType: string }

export interface ExportTarget {
  write(files: ExportFile[]): Promise<void>;
}

// Builds {folder}/{table}.csv and .json for each table, plus {folder}/manifest.json with the row counts.
export function buildExportFiles(tables: Record<string, Record<string, unknown>[]>, folder: string, generatedAt: string = new Date().toISOString()): ExportFile[] {
  const files = Object.entries(tables).flatMap(([name, rows]) => [
    { path: `${folder}/${name}.csv`, content: toCsv(rows), contentType: 'text/csv' },
    { path: `${folder}/${name}.json`, content: JSON.stringify(rows, null, 2), contentType: 'application/json' },
  ]);
  files.push({ path: `${folder}/manifest.json`, content: JSON.stringify(buildManifest(tables, folder, generatedAt), null, 2), contentType: 'application/json' });
  return files;
}

export interface Manifest {
  folder: string;
  generated_at: string;
  complete: boolean;
  total_rows: number;
  tables: Record<string, { rows: number; files: string[] }>;
}

// manifest.json: what the folder should contain. A restore (or a monitor) compares it with the files and the database.
export function buildManifest(tables: Record<string, Record<string, unknown>[]>, folder: string, generatedAt: string): Manifest {
  const entries = Object.entries(tables).map(([name, rows]) => [name, { rows: rows.length, files: [`${name}.csv`, `${name}.json`] }] as const);
  return {
    folder, generated_at: generatedAt, complete: true,
    total_rows: entries.reduce((n, [, t]) => n + t.rows, 0),
    tables: Object.fromEntries(entries),
  };
}
