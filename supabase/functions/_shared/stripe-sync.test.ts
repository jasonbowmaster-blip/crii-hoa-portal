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
    expect(await drainStripeOutbox(store, client)).toEqual({ done: 2, failed: 0, retry: 0 });
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
    expect(await drainStripeOutbox(store, client)).toEqual({ done: 1, failed: 1, retry: 0 });
    expect(finished).toEqual({ j1: 'failed', j2: 'done' });
  });
});

import { createStripeInvoiceClient } from './stripe-sync.ts';
import { createStripeClient, StripeApiError } from './stripe-client.ts';
import { fakeStripe } from './fake-stripe.ts';

describe('real outbox client (fake fetch)', () => {
  it('posts paid_out_of_band=true to the invoice pay endpoint, once per job', async () => {
    const f = fakeStripe();
    const client = createStripeInvoiceClient(createStripeClient('sk_test_k', f.fetchFn));
    await client.markPaidOutOfBand('in_9');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ method: 'POST', path: '/v1/invoices/in_9/pay' });
    expect(f.requests[0].body.get('paid_out_of_band')).toBe('true');
    expect(f.requests[0].headers['Idempotency-Key']).toBe('outbox:in_9');
  });
  it('an invoice Stripe already shows as paid counts as done', async () => {
    const f = fakeStripe({ failOn: () => ({ status: 400, code: 'invoice_already_paid' }) });
    await expect(createStripeInvoiceClient(createStripeClient('sk_test_k', f.fetchFn)).markPaidOutOfBand('in_9')).resolves.toBeUndefined();
  });
  it('refuses a live key', () => {
    expect(() => createStripeInvoiceClient(createStripeClient('sk_live_k', fakeStripe().fetchFn))).toThrow(/live key was refused/);
  });
  it('drain: a temporary failure leaves the job pending, a hard failure marks it failed', async () => {
    const finished: Record<string, string> = {};
    const store: OutboxStore = {
      pending: async () => [{ id: 'a', stripe_invoice_id: 'temp' }, { id: 'b', stripe_invoice_id: 'hard' }, { id: 'c', stripe_invoice_id: 'ok' }],
      finish: async (id, status) => { finished[id] = status; },
    };
    const client = { markPaidOutOfBand: async (id: string) => {
      if (id === 'temp') throw new StripeApiError('x', 503, null, true);
      if (id === 'hard') throw new StripeApiError('x', 400, null, false);
    } };
    expect(await drainStripeOutbox(store, client)).toEqual({ done: 1, failed: 1, retry: 1 });
    expect(finished).toEqual({ b: 'failed', c: 'done' });
  });
});
