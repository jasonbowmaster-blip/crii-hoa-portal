// Board-only bill run. dry_run:true returns the preview and writes nothing.
// Without dry_run it saves invoice drafts (status 'draft', idempotent on
// the number) and posts each lot's yearly charge to the ledger, once. Creating Stripe invoices and sending mail is a later step and is
// NOT done here. Test mode only: refuses sk_live_ keys unless ALLOW_LIVE=true.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildBillRun, liveKeyRefused, toPreview } from '../_shared/bill-run.ts';

const json = (body: unknown, status = 200) => Response.json(body, { status });

Deno.serve(async (req) => {
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
  const [lots, lotOwners, balances, posted] = await Promise.all([
    asUser.from('lots').select('id, lot_number, street_address, status'),
    asUser.from('lot_owners').select('lot_id, owners(id, full_name, email, mailing_address, email_notice_consent)').is('ends_on', null),
    asUser.from('lot_balances').select('lot_id, balance_cents'),
    asUser.from('ledger_entries').select('lot_id, amount_cents').like('external_ref', `inv:${year}-%`),
  ]);
  if (lots.error || lotOwners.error || balances.error || posted.error) return json({ error: 'Could not read the roster.' }, 500);

  const owners = (lotOwners.data ?? []).flatMap((r: any) => (r.owners ? [{ lot_id: r.lot_id, owner: r.owners }] : []));
  const run = buildBillRun(lots.data ?? [], owners, balances.data ?? [], params,
    (posted.data ?? []).map((r: any) => ({ lot_id: r.lot_id, balance_cents: r.amount_cents })));

  if (body?.dry_run === true) return json(toPreview(run, params));

  const service = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const drafts = run.drafts.map((d) => ({
    lot_id: d.lot_id, number: d.number, description: d.description, due_on: d.due_on,
    assessment_cents: d.amount_cents, total_cents: d.total_cents,
  }));
  const today = new Date().toISOString().slice(0, 10);
  const { data: saved, error } = await service.rpc('apply_bill_run', { p_posted_on: today, p_drafts: drafts });
  if (error) return json({ error: 'Could not save the drafts.' }, 500);
  // Say honestly what happened: new invoices, ones that already existed, and any that differ.
  return json({ ...saved, ...toPreview(run, params) });
});
