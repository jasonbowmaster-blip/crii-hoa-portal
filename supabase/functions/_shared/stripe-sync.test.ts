import { describe, expect, it } from 'vitest';
import { drainStripeOutbox, StubStripeInvoiceClient, type OutboxStore } from './stripe-sync.ts';

describe('drainStripeOutbox', () => {
  it('tells Stripe about each pending invoice once and records the result', async () => {
    const finished: Record<string, string> = {};
    const store: OutboxStore = {
      pending: async () => [{ id: 'j1', stripe_invoice_id: 'in_1' }, { id: 'j2', stripe_invoice_id: 'in_2' }],
      finish: async (id, status) => { finished[id] = status; },
    };
    const client = new StubStripeInvoiceClient();
    expect(await drainStripeOutbox(store, client)).toEqual({ done: 2, failed: 0 });
    expect(client.calls).toEqual(['in_1', 'in_2']);
    expect(finished).toEqual({ j1: 'done', j2: 'done' });
  });
  it('one failure does not stop the rest', async () => {
    const finished: Record<string, string> = {};
    const store: OutboxStore = {
      pending: async () => [{ id: 'j1', stripe_invoice_id: 'bad' }, { id: 'j2', stripe_invoice_id: 'in_2' }],
      finish: async (id, status) => { finished[id] = status; },
    };
    const client = { markPaidOutOfBand: async (id: string) => { if (id === 'bad') throw new Error('x'); } };
    expect(await drainStripeOutbox(store, client)).toEqual({ done: 1, failed: 1 });
    expect(finished).toEqual({ j1: 'failed', j2: 'done' });
  });
});
