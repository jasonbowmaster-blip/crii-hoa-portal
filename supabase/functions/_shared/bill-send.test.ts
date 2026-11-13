import { describe, expect, it } from 'vitest';
import { daysUntilDue, executeBillSend, planBillSend, type SendInvoiceRow, type SendStore } from './bill-send.ts';
import { createStripeClient } from './stripe-client.ts';
import { fakeStripe } from './fake-stripe.ts';

const row = (over: Partial<SendInvoiceRow> = {}): SendInvoiceRow => ({
  invoice_id: 'i42', number: '2027-042', lot_id: 'lot-42', lot_number: 42, description: '2027 annual assessment', amount_cents: 18000,
  due_on: '2027-05-15', status: 'draft', stripe_invoice_id: null, stripe_customer_id: null, ...over,
});
const TODAY = '2027-05-01';

describe('planBillSend', () => {
  it('plans customer, invoice, item and finalize with idempotency keys from lot, year and number', () => {
    const { sends, skipped } = planBillSend([row()], TODAY);
    expect(skipped).toEqual([]);
    const s = sends[0];
    expect(s.customer.idempotencyKey).toBe('bill-send:lot42:customer');
    expect(s.invoice.idempotencyKey).toBe('bill-send:2027:lot42:2027-042:invoice');
    expect(s.item.idempotencyKey).toBe('bill-send:2027:lot42:2027-042:item');
    expect(s.finalize.idempotencyKey).toBe('bill-send:2027:lot42:2027-042:finalize');
    expect(s.invoice.params).toMatchObject({
      collection_method: 'send_invoice', days_until_due: 14, auto_advance: false, pending_invoice_items_behavior: 'exclude',
      payment_settings: { payment_method_types: ['us_bank_account', 'card'] }, metadata: { lot_id: 'lot-42', invoice_number: '2027-042' },
    });
    expect(s.item.params).toMatchObject({ amount: 18000, currency: 'usd' });
    expect(s.customer.params).toMatchObject({ name: 'Lot 42', metadata: { lot_id: 'lot-42' } });
    expect(JSON.stringify(s)).not.toMatch(/@/);   // no owner e-mail goes to Stripe
  });
  it('is deterministic', () => { expect(planBillSend([row()], TODAY)).toEqual(planBillSend([row()], TODAY)); });
  it('skips rows already sent, paid, void, zero, credit-only and badly numbered', () => {
    const { sends, skipped } = planBillSend([
      row({ number: '2027-001', stripe_invoice_id: 'in_old' }),
      row({ number: '2027-002', status: 'paid' }),
      row({ number: '2027-003', status: 'void' }),
      row({ number: '2027-004', amount_cents: 0 }),
      row({ number: '2027-005', no_invoice: true }),
      row({ number: 'abc' }),
      row({ number: '2027-006', status: 'processing' }),
      row({ number: '2027-007' }),
    ], TODAY);
    expect(sends.map((s) => s.number)).toEqual(['2027-007']);
    expect(Object.fromEntries(skipped.map((k) => [k.number, k.reason]))).toEqual({
      '2027-001': 'already_sent', '2027-002': 'not_payable', '2027-003': 'not_payable', '2027-004': 'no_amount_due',
      '2027-005': 'credit_only', abc: 'bad_number', '2027-006': 'not_payable',
    });
  });
  it('days_until_due is at least 1', () => {
    expect(daysUntilDue('2027-05-15', '2027-05-01')).toBe(14);
    expect(daysUntilDue('2027-05-01', '2027-05-01')).toBe(1);
    expect(daysUntilDue('2027-04-01', '2027-05-01')).toBe(1);
  });
});

function memoryStore() {
  const customers: Record<string, string> = {};
  const invoices: Record<string, { id: string; url: string }> = {};
  const store: SendStore = {
    saveCustomer: async (lot, c) => { customers[lot] = c; },
    saveInvoice: async (inv, id, url) => { invoices[inv] = { id, url }; },
  };
  return { store, customers, invoices };
}

describe('executeBillSend', () => {
  it('creates customer, invoice, item, finalizes, and saves ids and link; never emails', async () => {
    const f = fakeStripe();
    const m = memoryStore();
    const { sends } = planBillSend([row()], TODAY);
    const res = await executeBillSend(sends, createStripeClient('sk_test_k', f.fetchFn), m.store);
    expect(res.failed).toEqual([]);
    const posts = f.requests.filter((r) => r.method === 'POST');
    expect(posts.map((r) => r.path)).toEqual(['/v1/customers', '/v1/invoices', '/v1/invoiceitems', '/v1/invoices/in_2/finalize']);
    expect(f.requests.some((r) => r.path.endsWith('/send'))).toBe(false);
    const inv = posts[1].body;
    expect(inv.get('customer')).toBe('cus_1');
    expect(inv.get('collection_method')).toBe('send_invoice');
    expect(inv.get('days_until_due')).toBe('14');
    expect(inv.get('auto_advance')).toBe('false');
    expect(inv.get('payment_settings[payment_method_types][0]')).toBe('us_bank_account');
    expect(inv.get('payment_settings[payment_method_types][1]')).toBe('card');
    expect(inv.get('metadata[lot_id]')).toBe('lot-42');
    expect(inv.get('metadata[invoice_number]')).toBe('2027-042');
    expect(posts[2].body.get('invoice')).toBe('in_2');
    expect(posts[2].body.get('amount')).toBe('18000');
    expect(posts[3].body.get('auto_advance')).toBe('false');
    expect(posts.map((r) => r.headers['Idempotency-Key'])).toEqual([
      'bill-send:lot42:customer', 'bill-send:2027:lot42:2027-042:invoice', 'bill-send:2027:lot42:2027-042:item', 'bill-send:2027:lot42:2027-042:finalize',
    ]);
    expect(m.customers).toEqual({ 'lot-42': 'cus_1' });
    expect(m.invoices.i42).toEqual({ id: 'in_2', url: 'https://invoice.stripe.com/i/test_in_2' });
  });
  it('reuses the lot customer instead of creating another', async () => {
    const f = fakeStripe();
    const { sends } = planBillSend([row({ stripe_customer_id: 'cus_known' })], TODAY);
    await executeBillSend(sends, createStripeClient('sk_test_k', f.fetchFn), memoryStore().store);
    expect(f.requests.some((r) => r.path === '/v1/customers')).toBe(false);
    expect(f.requests.find((r) => r.path === '/v1/invoices' && r.method === 'POST')!.body.get('customer')).toBe('cus_known');
  });
  it('a re-run after rows were saved plans nothing, so nothing reaches Stripe', async () => {
    const first = planBillSend([row()], TODAY);
    expect(first.sends).toHaveLength(1);
    const again = planBillSend([row({ stripe_invoice_id: 'in_2', status: 'open', stripe_customer_id: 'cus_1' })], TODAY);
    expect(again.sends).toEqual([]);
  });
  it('a re-run after a crash (not saved) finds the existing Stripe invoice and makes no duplicate', async () => {
    const f = fakeStripe({ existingInvoices: [{ id: 'in_prev', status: 'open', metadata: { invoice_number: '2027-042' }, hosted_invoice_url: 'https://invoice.stripe.com/i/test_prev' }] });
    const m = memoryStore();
    await executeBillSend(planBillSend([row({ stripe_customer_id: 'cus_1' })], TODAY).sends, createStripeClient('sk_test_k', f.fetchFn), m.store);
    expect(f.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect(m.invoices.i42.id).toBe('in_prev');
  });
  it('the same key replays the first answer, so a repeated plan reuses the same ids', async () => {
    const f = fakeStripe();
    const c = createStripeClient('sk_test_k', f.fetchFn);
    const { sends } = planBillSend([row()], TODAY);
    const a = await c.post(sends[0].customer.path, sends[0].customer.params, sends[0].customer.idempotencyKey);
    const b = await c.post(sends[0].customer.path, sends[0].customer.params, sends[0].customer.idempotencyKey);
    expect(a.id).toBe(b.id);
  });
  it('one failure is reported and the next invoice still goes', async () => {
    const f = fakeStripe({ failOn: (p) => (p === '/v1/invoiceitems' ? { status: 400 } : null) });
    const { sends } = planBillSend([row(), row({ invoice_id: 'i43', number: '2027-043', lot_id: 'lot-43', lot_number: 43 })], TODAY);
    const m = memoryStore();
    const res = await executeBillSend(sends, createStripeClient('sk_test_k', f.fetchFn), m.store);
    expect(res.failed.map((x) => x.number)).toEqual(['2027-042', '2027-043']);
    expect(res.sent).toEqual([]);
    expect(m.invoices).toEqual({});
  });
  it('refuses to build a client from a live key, so a send cannot start', () => {
    expect(() => createStripeClient('sk_live_x', fakeStripe().fetchFn)).toThrow(/live key was refused/);
  });
});
