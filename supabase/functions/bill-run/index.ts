// Board-only bill run. dry_run:true returns the preview and writes nothing.
// Without dry_run it saves invoice drafts (status 'draft', idempotent on
// the number) and posts each lot's yearly charge to the ledger, once. Creating Stripe invoices and sending mail is a later step and is
// NOT done here. Test mode only: refuses sk_live_ keys unless ALLOW_LIVE=true.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildBillRun, liveKeyRefused, summarizeYearRows, toPreview, type YearLedgerRow } from '../_shared/bill-run.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { fetchAllRows } from '../_shared/export.ts';

Deno.serve(async (req) => {
  // CORS on every answer, from PORTAL_ORIGIN (not '*'); the browser's OPTIONS preflight is answered first.
  const origin = req.headers.get('Origin');
  const portalOrigin = Deno.env.get('PORTAL_ORIGIN');
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: corsHeaders(origin, portalOrigin) });
  if (req.method === 'OPTIONS') {
    const p = preflight(origin, portalOrigin);
    return new Response(null, { status: p.status, headers: p.headers });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (liveKeyRefused(Deno.env.get('STRIPE_SECRET_KEY'), Deno.env.get('ALLOW_LIVE'))) {
    return json({ error: 'Live payment keys are not allowed here yet.' }, 403);
  }
  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'Sign in first.' }, 401);

  // Check the caller with THEIR token, so row-level security and is_board() apply.
  const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
  const { data: user } = await asUser.auth.getUser();
  if (!user?.user) return json({ error: 'Sign in first.' }, 401);
  const { data: isBoard, error: boardError } = await asUser.rpc('is_board');
  if (boardError || isBoard !== true) return json({ error: 'Board members only.' }, 403);

  const body = await req.json().catch(() => null);
  const year = Number(body?.year);
  const amount = Number(body?.amount_cents);
  const due_on = String(body?.due_on ?? '');
  if (!Number.isInteger(year) || !Number.isInteger(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(due_on)) {
    return json({ error: 'Year, amount in cents and due date are required.' }, 400);
  }
  const params = { year, amount_cents: amount, due_on };

  // Reads go through the caller's token; a board member's RLS lets them read everything needed.
  // Every read is paged (PostgREST returns at most 1000 rows per request).
  const today = new Date().toISOString().slice(0, 10);
  const all = <T>(table: string, columns: string, order: string[], filter: (q: any) => any = (q) => q) =>
    fetchAllRows<T>((from, to) => {
      let q = asUser.from(table).select(columns);
      q = filter(q);
      for (const col of order) q = q.order(col, { ascending: true });
      return q.range(from, to);
    }).catch(() => null);
  const [lots, lotOwners, balances, chargeRows, invoiceRows] = await Promise.all([
    all<any>('lots', 'id, lot_number, street_address, status', ['id']),
    // current owners: started, and not past their last day
    all<any>('lot_owners', 'lot_id, owner_id, owners(id, full_name, email, mailing_address, email_notice_consent)', ['lot_id', 'owner_id', 'starts_on'],
      (q) => q.lte('starts_on', today).or(`ends_on.is.null,ends_on.gte.${today}`)),
    all<any>('lot_balances', 'lot_id, balance_cents, processing_cents', ['lot_id']),
    // this year's own rows, so a re-run or a preview after the run does not carry them forward again:
    // the charges (they exist even for a credit-only lot with no invoice) ...
    all<any>('ledger_entries', 'id, lot_id, amount_cents, status, external_ref', ['id'], (q) => q.like('external_ref', `inv:${year}-%`)),
    // ... and every payment, credit or refund linked to one of this year's invoices
    all<any>('ledger_entries', 'id, lot_id, amount_cents, status, external_ref, invoices!inner(number)', ['id'], (q) => q.like('invoices.number', `${year}-%`)),
  ]);
  if (!lots || !lotOwners || !balances || !chargeRows || !invoiceRows) return json({ error: 'Could not read the roster.' }, 500);

  const owners = lotOwners.flatMap((r: any) => (r.owners ? [{ lot_id: r.lot_id, owner: r.owners }] : []));
  const seen = new Set<string>();
  const yearRows: YearLedgerRow[] = [...chargeRows, ...invoiceRows].flatMap((r: any) => {
    if (seen.has(r.id)) return [];
    seen.add(r.id);
    const inv = Array.isArray(r.invoices) ? r.invoices[0] : r.invoices;
    return [{ lot_id: r.lot_id, amount_cents: r.amount_cents, status: r.status, external_ref: r.external_ref ?? null, invoice_number: inv?.number ?? null }];
  });
  const { posted, processing } = summarizeYearRows(yearRows, year);
  const run = buildBillRun(lots, owners, balances, params, posted, processing);

  if (body?.dry_run === true) return json(toPreview(run, params));

  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const drafts = run.drafts.map((d) => ({
    lot_id: d.lot_id, number: d.number, description: d.description, due_on: d.due_on,
    assessment_cents: d.amount_cents, total_cents: d.total_cents, processing_cents: d.processing_cents,
    credit_left_cents: d.credit_left_cents,
  }));
  const { data: saved, error } = await service.rpc('apply_bill_run', { p_posted_on: today, p_drafts: drafts });
  if (error) return json({ error: 'Could not save the drafts.' }, 500);
  // Say honestly what happened: new invoices, ones that already existed, and any that differ.
  return json({ ...saved, ...toPreview(run, params) });
});
