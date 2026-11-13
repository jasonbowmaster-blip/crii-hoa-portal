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
  it('invoice.paid posts a cleared payment and marks the invoice paid', () => {
    const c = mapStripeEvent(ev('invoice.paid', { id: 'in_1', number: '2027-042', amount_paid: 15000, metadata: meta }));
    expect(c.ledger_inserts).toHaveLength(1);
    expect(c.ledger_inserts[0]).toMatchObject({ amount_cents: -15000, status: 'cleared', kind: 'payment', external_ref: 'evt_invoice.paid' });
    expect(c.invoice_updates).toEqual([{ stripe_invoice_id: 'in_1', status: 'paid' }]);
  });
  it('is deterministic, so a replay carries the same idempotency key', () => {
    const e = ev('invoice.paid', { id: 'in_1', amount_paid: 100, metadata: meta });
    expect(mapStripeEvent(e)).toEqual(mapStripeEvent(e));
  });
  it('invoice.payment_failed keeps the invoice open and posts nothing', () => {
    const c = mapStripeEvent(ev('invoice.payment_failed', { id: 'in_1', metadata: meta }));
    expect(c.ledger_inserts).toEqual([]);
    expect(c.invoice_updates).toEqual([{ stripe_invoice_id: 'in_1', status: 'open' }]);
  });
  it('invoice.voided voids the invoice', () => {
    expect(mapStripeEvent(ev('invoice.voided', { id: 'in_1', metadata: meta })).invoice_updates[0].status).toBe('void');
  });
  it('payment_intent.processing posts a processing ACH payment keyed by payment id', () => {
    const c = mapStripeEvent(ev('payment_intent.processing', { id: 'pi_1', amount: 15000, invoice: 'in_1', metadata: meta, payment_method_types: ['us_bank_account'] }));
    expect(c.ledger_inserts[0]).toMatchObject({ amount_cents: -15000, status: 'processing', method: 'ach', external_ref: 'pi_1' });
    expect(c.invoice_updates[0]).toEqual({ stripe_invoice_id: 'in_1', status: 'processing' });
  });
  it('ACH return marks the payment returned, adds a returned entry and a board task', () => {
    const c = mapStripeEvent(ev('payment_intent.payment_failed', { id: 'pi_1', amount: 15000, invoice: 'in_1', metadata: meta, payment_method_types: ['us_bank_account'] }));
    expect(c.ledger_updates).toEqual([{ external_ref: 'pi_1', status: 'returned' }]);
    expect(c.ledger_inserts[0]).toMatchObject({ status: 'returned', description: 'Bank payment returned' });
    expect(c.tasks[0]).toMatchObject({ kind: 'payment_returned', lot_id: 'lot-42' });
    expect(c.invoice_updates[0].status).toBe('open');
  });
  it('a card decline is not an ACH return', () => {
    const c = mapStripeEvent(ev('payment_intent.payment_failed', { id: 'pi_2', amount: 100, metadata: meta, payment_method_types: ['card'] }));
    expect(c.handled).toBe(false);
    expect(c.tasks).toEqual([]);
  });
  it('charge.refunded posts a refund entry', () => {
    const c = mapStripeEvent(ev('charge.refunded', { amount_refunded: 5000, metadata: meta }));
    expect(c.ledger_inserts[0]).toMatchObject({ kind: 'refund', amount_cents: 5000 });
  });
  it('charge.dispute.created returns the payment and creates a task', () => {
    const c = mapStripeEvent(ev('charge.dispute.created', { amount: 15000, payment_intent: 'pi_9', metadata: meta }));
    expect(c.ledger_updates).toEqual([{ external_ref: 'pi_9', status: 'returned' }]);
    expect(c.tasks).toHaveLength(1);
  });
  it('ignores events without a lot and unknown types', () => {
    expect(mapStripeEvent(ev('invoice.paid', { id: 'in_1', amount_paid: 1 })).handled).toBe(false);
    expect(mapStripeEvent(ev('customer.created', { metadata: meta })).ignored_reason).toBe('event_type_not_used');
  });
});
