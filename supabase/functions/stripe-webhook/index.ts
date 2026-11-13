// Stripe webhook receiver. Verifies the signature, maps the event with the pure
// logic in _shared/stripe.ts, then hands the result to the database function
// apply_stripe_event (service role), which is idempotent by Stripe event id.
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

  // One database call applies the whole event: finds the lot through our invoices, moves the
  // payment's ledger row forward, updates the invoice, opens tasks, and records the event id
  // so a duplicate delivery changes nothing.
  const { data, error } = await db.rpc('apply_stripe_event', { p_event_id: event.id, p_changes: changes });
  if (error) {
    console.error(`stripe-webhook ${event.id} apply failed: ${error.message}`);
    return new Response('Write failed', { status: 500 }); // Stripe retries; the call is idempotent
  }
  if (data?.applied === false && !data?.duplicate) {
    // Usually an event that arrived before the invoice was linked. Ask Stripe to retry.
    console.error(`stripe-webhook ${event.id} not applied: ${data?.reason}`);
    return new Response('Not applied yet', { status: 500 });
  }
  return Response.json({ received: true, duplicate: data?.duplicate === true });
});
