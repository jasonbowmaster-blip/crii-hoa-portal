// Stripe webhook receiver. Verifies the signature, maps the event with the pure
// logic in _shared/stripe.ts, then writes with the service role. Idempotent:
// ledger rows are upserted on external_ref, tasks on ref_id.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { mapStripeEvent, verifyStripeSignature, type StripeEvent } from '../_shared/stripe.ts';

const TOLERANCE_SEC = 300;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const payload = await req.text();
  const check = await verifyStripeSignature(
    payload, req.headers.get('stripe-signature'), Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '',
    TOLERANCE_SEC, Math.floor(Date.now() / 1000),
  );
  if (!check.ok) return new Response('Bad signature', { status: 400 });

  const event = JSON.parse(payload) as StripeEvent;
  const changes = mapStripeEvent(event);
  if (!changes.handled) return Response.json({ received: true, ignored: changes.ignored_reason });

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Resolve Stripe invoice ids to our invoice ids.
  const stripeIds = [...new Set(changes.ledger_inserts.map((l) => l.stripe_invoice_id).filter((x): x is string => !!x))];
  const invoiceIds = new Map<string, string>();
  if (stripeIds.length > 0) {
    const { data, error } = await db.from('invoices').select('id, stripe_invoice_id').in('stripe_invoice_id', stripeIds);
    if (error) return new Response('Lookup failed', { status: 500 });
    for (const row of data ?? []) invoiceIds.set(row.stripe_invoice_id, row.id);
  }

  const fail = (what: string, error: { message: string } | null) => {
    console.error(`stripe-webhook ${event.id} ${what}: ${error?.message}`);
    return new Response('Write failed', { status: 500 }); // Stripe retries; writes are idempotent
  };

  for (const l of changes.ledger_inserts) {
    const { stripe_invoice_id, ...row } = l;
    const { error } = await db.from('ledger_entries').upsert(
      { ...row, invoice_id: stripe_invoice_id ? invoiceIds.get(stripe_invoice_id) ?? null : null },
      { onConflict: 'external_ref', ignoreDuplicates: true },
    );
    if (error) return fail('ledger insert', error);
  }
  for (const u of changes.ledger_updates) {
    const { error } = await db.from('ledger_entries').update({ status: u.status }).eq('external_ref', u.external_ref);
    if (error) return fail('ledger update', error);
  }
  for (const i of changes.invoice_updates) {
    const { error } = await db.from('invoices').update({ status: i.status }).eq('stripe_invoice_id', i.stripe_invoice_id);
    if (error) return fail('invoice update', error);
  }
  for (const t of changes.tasks) {
    const { data: existing } = await db.from('board_tasks').select('id').eq('ref_id', t.ref_id).eq('kind', t.kind).limit(1);
    if (existing && existing.length > 0) continue;
    const { error } = await db.from('board_tasks').insert({ ...t, status: 'open' });
    if (error) return fail('task insert', error);
  }
  return Response.json({ received: true });
});
