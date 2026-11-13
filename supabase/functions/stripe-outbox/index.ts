// Tells Stripe (TEST mode) about invoices paid outside Stripe, e.g. a deposited check. The database queues a job in
// stripe_outbox when a check is confirmed; this function drains the queue. Called by a schedule (every 10 minutes)
// with the service key as a bearer token. Refuses live Stripe keys.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createStripeClient, StripeKeyError } from '../_shared/stripe-client.ts';
import { createStripeInvoiceClient, drainStripeOutbox } from '../_shared/stripe-sync.ts';

Deno.serve(async (req) => {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  if (req.headers.get('Authorization') !== `Bearer ${key}`) return new Response('Forbidden', { status: 403 });
  let stripe;
  try { stripe = createStripeClient(Deno.env.get('STRIPE_SECRET_KEY')); }
  catch (e) { return Response.json({ error: e instanceof StripeKeyError ? e.message : 'Stripe is not set up.' }, { status: 403 }); }

  const db = createClient(Deno.env.get('SUPABASE_URL')!, key);
  const result = await drainStripeOutbox({
    async pending() {
      const { data, error } = await db.from('stripe_outbox').select('id, stripe_invoice_id')
        .eq('kind', 'mark_paid_out_of_band').eq('status', 'pending').order('created_at', { ascending: true }).limit(50);
      if (error) throw new Error(`read outbox: ${error.message}`);
      return data ?? [];
    },
    async finish(id, status) {
      const { error } = await db.from('stripe_outbox').update({ status, done_at: new Date().toISOString() }).eq('id', id);
      if (error) console.error(`stripe-outbox: could not record ${status} for ${id}: ${error.message}`);
    },
  }, createStripeInvoiceClient(stripe));
  return Response.json(result);
});
