// Nightly backup: every table as CSV and JSON into a dated folder, plus manifest.json with the row counts.
// The storage target sits behind ExportTarget. The default writes to a private
// Supabase Storage bucket named 'backups'; a Google Drive target can replace it later.
// Called by a schedule with the service key as a bearer token.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildExportFiles, EXPORT_TABLES, fetchAllRows, type ExportTarget } from '../_shared/export.ts';

Deno.serve(async (req) => {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  if (req.headers.get('Authorization') !== `Bearer ${key}`) return new Response('Forbidden', { status: 403 });

  const db = createClient(Deno.env.get('SUPABASE_URL')!, key);
  const target: ExportTarget = {
    async write(files) {
      for (const f of files) {
        const { error } = await db.storage.from('backups').upload(f.path, new Blob([f.content], { type: f.contentType }), { upsert: true, contentType: f.contentType });
        if (error) throw new Error(`upload ${f.path}: ${error.message}`);
      }
    },
  };

  // Every table is read in pages of 1000 until a short page, in a stable order, and checked against an exact count.
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const t of EXPORT_TABLES) {
    try {
      tables[t.name] = await fetchAllRows((from, to) => {
        let q = db.from(t.name).select(t.columns, from === 0 ? { count: 'exact' } : undefined);
        for (const col of t.order) q = q.order(col, { ascending: true });
        return q.range(from, to);
      });
    } catch (e) {
      console.error(`nightly-export: read ${t.name} failed: ${(e as Error).message}`);
      return Response.json({ error: `read ${t.name} failed` }, { status: 500 });
    }
  }
  const folder = new Date().toISOString().slice(0, 10);
  await target.write(buildExportFiles(tables, folder));
  return Response.json({ folder, tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])) });
});
