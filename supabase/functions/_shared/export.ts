// CSV and JSON serialisation for the nightly backup, plus the storage interface.

export const EXPORT_TABLES = [
  'lots', 'owners', 'lot_owners', 'board_members', 'invoices', 'ledger_entries', 'checks',
  'messages', 'documents', 'events', 'announcements', 'board_tasks', 'reply_templates', 'claim_requests',
] as const;

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

// Builds {folder}/{table}.csv and .json for each table.
export function buildExportFiles(tables: Record<string, Record<string, unknown>[]>, folder: string): ExportFile[] {
  return Object.entries(tables).flatMap(([name, rows]) => [
    { path: `${folder}/${name}.csv`, content: toCsv(rows), contentType: 'text/csv' },
    { path: `${folder}/${name}.json`, content: JSON.stringify(rows, null, 2), contentType: 'application/json' },
  ]);
}
