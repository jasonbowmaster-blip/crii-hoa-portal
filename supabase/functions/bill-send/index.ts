// Board-only "send" step of the bill run. Turns saved invoice drafts into Stripe invoices (TEST mode only).
// Stripe is asked to create and finalize each invoice but NOT to email it (auto_advance false, no send call):
// the portal shows the owner the bill and its payment link. Re-running is safe (see _shared/bill-send.ts).
// Body: { year, numbers?: string[], dry_run?: boolean }.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { executeBillSend, planBillSend, type SendInvoiceRow } from '../_shared/bill-send.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { fetchAllRows } from '../_shared/export.ts';
import { createStripeClient, StripeKeyError } from '../_shared/stripe-client.ts';

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  const portalOrigin = Deno.env.get('PORTAL_ORIGIN');
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: corsHeaders(origin, portalOrigin) });
  if (req.method === 'OPTIONS') {
    const p = preflight(origin, portalOrigin);
    return new Response(null, { status: p.status, headers: p.headers });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // A live key is refused before anything else happens.
  let stripe;
  try { stripe = createStripeClient(Deno.env.get('STRIPE_SECRET_KEY')); }
  catch (e) { return json({ error: e instanceof StripeKeyError ? e.message : 'Stripe is not set up.' }, 403); }

  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'Sign in first.' }, 401);
  const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
  const { data: user } = await asUser.auth.getUser();
  if (!user?.user) return json({ error: 'Sign in first.' }, 401);
  const { data: isBoard, error: boardError } = await asUser.rpc('is_board');
  if (boardError || isBoard !== true) return json({ error: 'Board members only.' }, 403);

  const body = await req.json().catch(() => null);
  const year = Number(body?.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return json({ error: 'A year is required.' }, 400);
  const only: string[] | null = Array.isArray(body?.numbers) ? body.numbers.map(String) : null;

  // Everything below uses the service key: it reads and writes the Stripe link columns and the customer table.
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const [invoices, customers] = await Promise.all([
    fetchAllRows<any>((from, to) => db.from('invoices').select('id, number, lot_id, description, amount_cents, due_on, status, stripe_invoice_id, lots(lot_number)')
      .like('number', `${year}-%`).order('number', { ascending: true }).range(from, to)).catch(() => null),
    fetchAllRows<any>((from, to) => db.from('stripe_customers').select('lot_id, stripe_customer_id').order('lot_id', { ascending: true }).range(from, to)).catch(() => null),
  ]);
  if (!invoices || !customers) return json({ error: 'Could not read the invoices.' }, 500);
  const customerByLot = new Map(customers.map((c: any) => [c.lot_id, c.stripe_customer_id]));
  const rows: SendInvoiceRow[] = invoices
    .filter((i: any) => !only || only.includes(i.number))
    .map((i: any) => ({
      invoice_id: i.id, number: i.number, lot_id: i.lot_id, lot_number: (Array.isArray(i.lots) ? i.lots[0] : i.lots)?.lot_number ?? 0,
      description: i.description, amount_cents: Number(i.amount_cents), due_on: i.due_on, status: i.status,
      stripe_invoice_id: i.stripe_invoice_id, stripe_customer_id: customerByLot.get(i.lot_id) ?? null,
    }));

  const { sends, skipped } = planBillSend(rows, new Date().toISOString().slice(0, 10));
  if (body?.dry_run === true) return json({ dry_run: true, would_send: sends.map((s) => s.number), skipped });

  const result = await executeBillSend(sends, stripe, {
    async saveCustomer(lotId, stripeCustomerId) {
      const { error } = await db.rpc('record_stripe_customer', { p_lot_id: lotId, p_stripe_customer_id: stripeCustomerId });
      if (error) throw new Error('Could not save the Stripe customer.');
    },
    async saveInvoice(invoiceId, stripeInvoiceId, hostedUrl) {
      const { error } = await db.rpc('record_stripe_invoice', { p_invoice_id: invoiceId, p_stripe_invoice_id: stripeInvoiceId, p_hosted_invoice_url: hostedUrl });
      if (error) throw new Error('Could not save the Stripe invoice link.');
    },
  });
  return json({ ...result, skipped }, result.failed.length > 0 && result.sent.length === 0 ? 502 : 200);
});
