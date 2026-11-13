// Hook for telling Stripe an invoice was paid out of band (a deposited check).
// The database queues the job in stripe_outbox when the check is confirmed. This file is
// the seam: the real client (a later step, test mode first) implements StripeInvoiceClient;
// until then the stub below does nothing and makes no network calls.

export interface StripeInvoiceClient {
  // Stripe: POST /v1/invoices/{id}/pay with paid_out_of_band=true.
  markPaidOutOfBand(stripeInvoiceId: string): Promise<void>;
}

export class StubStripeInvoiceClient implements StripeInvoiceClient {
  readonly calls: string[] = [];
  async markPaidOutOfBand(stripeInvoiceId: string): Promise<void> { this.calls.push(stripeInvoiceId); }
}

export interface OutboxJob { id: string; stripe_invoice_id: string }
export interface OutboxStore {
  pending(): Promise<OutboxJob[]>;
  finish(id: string, status: 'done' | 'failed'): Promise<void>;
}

// Runs every pending job once. A failure marks only that job failed and carries on.
export async function drainStripeOutbox(store: OutboxStore, client: StripeInvoiceClient): Promise<{ done: number; failed: number }> {
  let done = 0;
  let failed = 0;
  for (const job of await store.pending()) {
    try {
      await client.markPaidOutOfBand(job.stripe_invoice_id);
      await store.finish(job.id, 'done');
      done++;
    } catch {
      await store.finish(job.id, 'failed');
      failed++;
    }
  }
  return { done, failed };
}
