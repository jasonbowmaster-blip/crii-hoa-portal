// Tells Stripe an invoice was paid out of band (a deposited check).
// The database queues the job in stripe_outbox when the check is confirmed; the stripe-outbox function drains it
// with the real client below (TEST keys only, see stripe-client.ts). The stub stays for tests.
import { StripeApiError, type StripeClient } from './stripe-client.ts';

export interface StripeInvoiceClient {
  // Stripe: POST /v1/invoices/{id}/pay with paid_out_of_band=true.
  markPaidOutOfBand(stripeInvoiceId: string): Promise<void>;
}

export class StubStripeInvoiceClient implements StripeInvoiceClient {
  readonly calls: string[] = [];
  async markPaidOutOfBand(stripeInvoiceId: string): Promise<void> { this.calls.push(stripeInvoiceId); }
}

// Real client. paid_out_of_band=true closes the Stripe invoice without charging anyone.
// An invoice Stripe already shows as paid counts as done (the job is a repeat). The idempotency key is the job id.
export function createStripeInvoiceClient(stripe: StripeClient, jobKey: (stripeInvoiceId: string) => string = (id) => `outbox:${id}`): StripeInvoiceClient {
  return {
    async markPaidOutOfBand(stripeInvoiceId) {
      try {
        await stripe.post(`/v1/invoices/${encodeURIComponent(stripeInvoiceId)}/pay`, { paid_out_of_band: true }, jobKey(stripeInvoiceId));
      } catch (e) {
        if (e instanceof StripeApiError && e.code === 'invoice_already_paid') return;
        throw e;
      }
    },
  };
}

export interface OutboxJob { id: string; stripe_invoice_id: string }
export interface OutboxStore {
  pending(): Promise<OutboxJob[]>;
  finish(id: string, status: 'done' | 'failed'): Promise<void>;
}

// Runs every pending job once. A failure marks only that job failed and carries on.
// A temporary failure (Stripe unreachable, rate limited, 5xx) leaves the job pending for the next run.
export async function drainStripeOutbox(store: OutboxStore, client: StripeInvoiceClient): Promise<{ done: number; failed: number; retry: number }> {
  let done = 0;
  let failed = 0;
  let retry = 0;
  for (const job of await store.pending()) {
    try {
      await client.markPaidOutOfBand(job.stripe_invoice_id);
      await store.finish(job.id, 'done');
      done++;
    } catch (e) {
      if (e instanceof StripeApiError && e.retryable) { retry++; continue; }
      await store.finish(job.id, 'failed');
      failed++;
    }
  }
  return { done, failed, retry };
}
