import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, mapStripeEvent, verifyStripeSignature, constantTimeEqual, type StripeEvent } from './stripe.ts';

const secret = 'whsec_test_secret';
const payload = '{"id":"evt_1"}';
const now = 1_800_000_000;

async function header(t: number, body = payload, s = secret) {
  return `t=${t},v1=${await hmacSha256Hex(s, `${t}.${body}`)}`;
}

describe('verifyStripeSignature', () => {
  it('accepts a good signature', async () => {
    expect(await verifyStripeSignature(payload, await header(now), secret, 300, now)).toEqual({ ok: true });
  });
  it('accepts when one of several v1 values matches', async () => {
    const h = `${await header(now)},v1=deadbeef`;
    expect((await verifyStripeSignature(payload, h, secret, 300, now)).ok).toBe(true);
  });
  it('rejects a tampered payload', async () => {
    expect((await verifyStripeSignature(payload + ' ', await header(now), secret, 300, now)).ok).toBe(false);
  });
  it('rejects the wrong secret', async () => {
    expect((await verifyStripeSignature(payload, await header(now, payload, 'other'), secret, 300, now)).ok).toBe(false);
  });
  it('rejects an old timestamp and a future one', async () => {
    const old = await verifyStripeSignature(payload, await header(now - 301), secret, 300, now);
    expect(old).toEqual({ ok: false, reason: 'timestamp_outside_tolerance' });
    expect((await verifyStripeSignature(payload, await header(now + 301), secret, 300, now)).ok).toBe(false);
  });
  it('rejects missing or malformed headers', async () => {
    expect((await verifyStripeSignature(payload, null, secret, 300, now)).ok).toBe(false);
    expect((await verifyStripeSignature(payload, 'garbage', secret, 300, now)).ok).toBe(false);
    expect((await verifyStripeSignature(payload, `t=${now}`, secret, 300, now)).ok).toBe(false);
    expect((await verifyStripeSignature(payload, await header(now), '', 300, now)).ok).toBe(false);
  });
  it('constantTimeEqual handles different lengths', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
  });
});

const ev = (type: string, object: Record<string, any>): StripeEvent => ({ id: `evt_${type}`, type, created: 1_800_000_000, data: { object } });
const meta = { lot_id: 'lot-42' };

describe('mapStripeEvent', () => {
  it('invoice.paid posts a cleared payment keyed by the PaymentIntent and marks the invoice paid', () => {
    const c = mapStripeEvent(ev('invoice.paid', { id: 'in_1', number: '2027-042', amount_paid: 15000, payment_intent: 'pi_1', metadata: meta }));
    expect(c.ledger).toHaveLength(1);
    expect(c.ledger[0]).toMatchObject({ amount_cents: -15000, status: 'cleared', kind: 'payment', external_ref: 'pi_1' });
    expect(c).toMatchObject({ invoice_status: 'paid', stripe_invoice_id: 'in_1', payment_intent: 'pi_1' });
  });
  it('is deterministic, so a replay carries the same keys', () => {
    const e = ev('invoice.paid', { id: 'in_1', amount_paid: 100, payment_intent: 'pi_1' });
    expect(mapStripeEvent(e)).toEqual(mapStripeEvent(e));
  });
  it('needs no metadata: an invoice or payment id is enough, because the database finds the lot', () => {
    expect(mapStripeEvent(ev('invoice.paid', { id: 'in_1', amount_paid: 1 })).handled).toBe(true);
    expect(mapStripeEvent(ev('invoice.paid', { amount_paid: 1 })).ignored_reason).toBe('no_payment_reference');
  });
  it('invoice.payment_failed keeps the invoice open and posts nothing', () => {
    const c = mapStripeEvent(ev('invoice.payment_failed', { id: 'in_1' }));
    expect(c.ledger).toEqual([]);
    expect(c).toMatchObject({ invoice_status: 'open', invoice_force: false });
  });
  it('invoice.voided voids the invoice', () => {
    expect(mapStripeEvent(ev('invoice.voided', { id: 'in_1' })).invoice_status).toBe('void');
  });
  it('payment_intent.processing posts a processing ACH payment keyed by payment id', () => {
    const c = mapStripeEvent(ev('payment_intent.processing', { id: 'pi_1', amount: 15000, invoice: 'in_1', payment_method_types: ['us_bank_account'] }));
    expect(c.ledger[0]).toMatchObject({ amount_cents: -15000, status: 'processing', method: 'ach', external_ref: 'pi_1' });
    expect(c).toMatchObject({ invoice_status: 'processing', stripe_invoice_id: 'in_1', payment_intent: 'pi_1' });
  });
  it('payment_intent.succeeded settles the SAME key', () => {
    const c = mapStripeEvent(ev('payment_intent.succeeded', { id: 'pi_1', amount_received: 15000, invoice: 'in_1' }));
    expect(c.ledger[0]).toMatchObject({ external_ref: 'pi_1', status: 'cleared', amount_cents: -15000 });
  });
  it('ACH return moves the same payment row to returned, reopens the invoice and adds a task', () => {
    const c = mapStripeEvent(ev('payment_intent.payment_failed', { id: 'pi_1', amount: 15000, invoice: 'in_1', payment_method_types: ['us_bank_account'] }));
    expect(c.ledger).toHaveLength(1);
    expect(c.ledger[0]).toMatchObject({ external_ref: 'pi_1', status: 'returned', description: 'Bank payment returned' });
    expect(c).toMatchObject({ invoice_status: 'open', invoice_force: true });
    expect(c.tasks[0]).toMatchObject({ kind: 'payment_returned' });
  });
  it('a card decline is not an ACH return', () => {
    const c = mapStripeEvent(ev('payment_intent.payment_failed', { id: 'pi_2', amount: 100, payment_method_types: ['card'] }));
    expect(c.handled).toBe(false);
    expect(c.tasks).toEqual([]);
  });
  it('a refund is posted by refund id with that refund amount', () => {
    const c = mapStripeEvent(ev('refund.created', { id: 're_1', amount: 5000, payment_intent: 'pi_1', status: 'succeeded' }));
    expect(c.ledger).toEqual([expect.objectContaining({ external_ref: 're_1', kind: 'refund', amount_cents: 5000, status: 'cleared' })]);
  });
  it('charge.refunded posts each listed refund, never the running total', () => {
    const c = mapStripeEvent(ev('charge.refunded', {
      payment_intent: 'pi_1', amount_refunded: 10000,
      refunds: { data: [{ id: 're_1', amount: 5000 }, { id: 're_2', amount: 5000 }] },
    }));
    expect(c.ledger.map((l) => [l.external_ref, l.amount_cents])).toEqual([['re_1', 5000], ['re_2', 5000]]);
    expect(mapStripeEvent(ev('charge.refunded', { payment_intent: 'pi_1', amount_refunded: 10000 })).handled).toBe(false);
  });
  it('a failed refund does not count', () => {
    const c = mapStripeEvent(ev('refund.updated', { id: 're_1', amount: 5000, payment_intent: 'pi_1', status: 'failed' }));
    expect(c.ledger[0].status).toBe('returned');
  });
  it('charge.dispute.created targets the payment by PaymentIntent, reopens the invoice and creates a task', () => {
    const c = mapStripeEvent(ev('charge.dispute.created', { amount: 15000, payment_intent: 'pi_9' }));
    expect(c.ledger[0]).toMatchObject({ external_ref: 'pi_9', status: 'returned' });
    expect(c).toMatchObject({ payment_intent: 'pi_9', invoice_status: 'open', invoice_force: true });
    expect(c.tasks).toHaveLength(1);
  });
  it('ignores unknown types', () => {
    expect(mapStripeEvent(ev('customer.created', { metadata: meta })).ignored_reason).toBe('event_type_not_used');
  });
});
