// Whole payment lifecycles: events go through mapStripeEvent, then the in-memory twin of
// apply_stripe_event, and the lot's balance is read with the web app's summarizeBalance.
import { describe, expect, it } from 'vitest';
import { summarizeBalance } from '../../../web/src/lib/ledger';
import type { Invoice, LedgerEntry } from '../../../web/src/data/types';
import { applySim, newSimDb, type SimDb } from './ledger-sim.ts';
import { mapStripeEvent, type StripeEvent } from './stripe.ts';

const LOT = 'lot-42';
let n = 0;
const ev = (type: string, object: Record<string, any>, id = `evt_${++n}`): StripeEvent => ({ id, type, created: 1_800_000_000 + n, data: { object } });
const ACH = ['us_bank_account'];

function start(): SimDb {
  // The lot owes its 2027 assessment: one charge, one open invoice already linked to Stripe.
  const db = newSimDb([{ id: 'inv-1', lot_id: LOT, number: '2027-042', amount_cents: 17500, status: 'open',
    stripe_invoice_id: 'in_1', stripe_payment_intent_id: null, paid_outside_stripe: false }]);
  db.ledger.push({ lot_id: LOT, posted_on: '2027-01-29', kind: 'charge', description: '2027 annual assessment', detail: null,
    amount_cents: 17500, status: 'cleared', method: null, invoice_id: 'inv-1', external_ref: 'inv:2027-042' });
  return db;
}
const feed = (db: SimDb, ...events: StripeEvent[]) => events.forEach((e) => applySim(db, mapStripeEvent(e)));
function balance(db: SimDb) {
  const entries = db.ledger.map((r, i) => ({ ...r, id: String(i) })) as unknown as LedgerEntry[];
  return summarizeBalance(entries, db.invoices as unknown as Invoice[]);
}
const paymentRows = (db: SimDb) => db.ledger.filter((r) => r.kind === 'payment');

describe('payment lifecycles', () => {
  it('ACH: processing then succeeded ends cleared, one row, balance 0, invoice paid', () => {
    const db = start();
    feed(db, ev('payment_intent.processing', { id: 'pi_1', amount: 17500, invoice: 'in_1', payment_method_types: ACH }));
    expect(balance(db)).toMatchObject({ balance_cents: 17500, processing_cents: 17500, state: 'processing' });
    feed(db, ev('invoice.paid', { id: 'in_1', amount_paid: 17500, payment_intent: 'pi_1' }),
             ev('payment_intent.succeeded', { id: 'pi_1', amount_received: 17500, invoice: 'in_1', payment_method_types: ACH }));
    expect(paymentRows(db)).toHaveLength(1);
    expect(paymentRows(db)[0]).toMatchObject({ status: 'cleared', method: 'ach' });
    expect(balance(db)).toMatchObject({ balance_cents: 0, processing_cents: 0, state: 'paid' });
    expect(db.invoices[0].status).toBe('paid');
  });

  it('ACH: processing then failed is a return, the lot owes again and a task opens', () => {
    const db = start();
    feed(db, ev('payment_intent.processing', { id: 'pi_1', amount: 17500, invoice: 'in_1', payment_method_types: ACH }),
             ev('payment_intent.payment_failed', { id: 'pi_1', amount: 17500, invoice: 'in_1', payment_method_types: ACH }));
    expect(paymentRows(db)).toHaveLength(1);
    expect(balance(db)).toMatchObject({ balance_cents: 17500, processing_cents: 0, state: 'unpaid' });
    expect(db.invoices[0].status).toBe('open');
    expect(db.tasks).toEqual([{ lot_id: LOT, kind: 'payment_returned' }]);
  });

  it('ACH settled, then disputed days later: the same row flips back to owing', () => {
    const db = start();
    feed(db, ev('payment_intent.processing', { id: 'pi_1', amount: 17500, invoice: 'in_1', payment_method_types: ACH }),
             ev('payment_intent.succeeded', { id: 'pi_1', amount_received: 17500, invoice: 'in_1', payment_method_types: ACH }),
             ev('charge.dispute.created', { id: 'dp_1', amount: 17500, payment_intent: 'pi_1' }));
    expect(paymentRows(db)).toHaveLength(1);
    expect(balance(db).balance_cents).toBe(17500);
  });

  it('card: paid, then disputed (no metadata on the dispute): owing again, invoice open, task opened', () => {
    const db = start();
    feed(db, ev('invoice.paid', { id: 'in_1', amount_paid: 17500, payment_intent: 'pi_9' }));
    expect(balance(db)).toMatchObject({ balance_cents: 0, state: 'paid' });
    feed(db, ev('charge.dispute.created', { id: 'dp_1', amount: 17500, payment_intent: 'pi_9' }));
    expect(paymentRows(db)).toHaveLength(1);
    expect(balance(db)).toMatchObject({ balance_cents: 17500, state: 'unpaid' });
    expect(db.invoices[0].status).toBe('open');
    expect(db.tasks).toHaveLength(1);
  });

  it('two partial refunds post $50 and $50, not $50 and $100', () => {
    const db = start();
    feed(db, ev('invoice.paid', { id: 'in_1', amount_paid: 17500, payment_intent: 'pi_9' }),
             ev('refund.created', { id: 're_1', amount: 5000, payment_intent: 'pi_9', status: 'succeeded' }),
             ev('refund.created', { id: 're_2', amount: 5000, payment_intent: 'pi_9', status: 'succeeded' }));
    expect(db.ledger.filter((r) => r.kind === 'refund').map((r) => r.amount_cents)).toEqual([5000, 5000]);
    expect(balance(db).balance_cents).toBe(10000);
  });

  it('refunds delivered through charge.refunded and refund.created together post once each', () => {
    const db = start();
    feed(db, ev('invoice.paid', { id: 'in_1', amount_paid: 17500, payment_intent: 'pi_9' }),
             ev('refund.created', { id: 're_1', amount: 5000, payment_intent: 'pi_9', status: 'succeeded' }),
             ev('charge.refunded', { payment_intent: 'pi_9', refunds: { data: [{ id: 're_1', amount: 5000 }, { id: 're_2', amount: 2500 }] } }));
    expect(db.ledger.filter((r) => r.kind === 'refund')).toHaveLength(2);
    expect(balance(db).balance_cents).toBe(7500);
  });

  it('duplicate delivery of every event changes nothing', () => {
    const once = start();
    const twice = start();
    const events = [
      ev('payment_intent.processing', { id: 'pi_1', amount: 17500, invoice: 'in_1', payment_method_types: ACH }, 'evt_a'),
      ev('invoice.paid', { id: 'in_1', amount_paid: 17500, payment_intent: 'pi_1' }, 'evt_b'),
      ev('refund.created', { id: 're_1', amount: 5000, payment_intent: 'pi_1', status: 'succeeded' }, 'evt_c'),
    ];
    feed(once, ...events);
    feed(twice, ...events, ...events);
    expect(twice.ledger).toEqual(once.ledger);
    expect(twice.invoices).toEqual(once.invoices);
    expect(balance(twice).balance_cents).toBe(5000);
  });

  it('out of order: a late processing event does not undo a settled payment', () => {
    const db = start();
    feed(db, ev('invoice.paid', { id: 'in_1', amount_paid: 17500, payment_intent: 'pi_1' }),
             ev('payment_intent.processing', { id: 'pi_1', amount: 17500, invoice: 'in_1', payment_method_types: ACH }));
    expect(paymentRows(db)[0].status).toBe('cleared');
    expect(db.invoices[0].status).toBe('paid');
    expect(balance(db).state).toBe('paid');
  });

  it('a late invoice.paid after a dispute does not reopen the money or mark the invoice paid', () => {
    const db = start();
    feed(db, ev('invoice.paid', { id: 'in_1', amount_paid: 17500, payment_intent: 'pi_9' }),
             ev('charge.dispute.created', { amount: 17500, payment_intent: 'pi_9' }),
             ev('invoice.paid', { id: 'in_1', amount_paid: 17500, payment_intent: 'pi_9' }));
    expect(balance(db).balance_cents).toBe(17500);
    expect(db.invoices[0].status).toBe('open');
  });

  it('an invoice paid by check does not post a second payment when Stripe says it is paid', () => {
    const db = start();
    db.invoices[0].status = 'paid'; db.invoices[0].paid_outside_stripe = true;
    db.ledger.push({ lot_id: LOT, posted_on: '2027-03-12', kind: 'payment', description: 'Payment by check', detail: null,
      amount_cents: -17500, status: 'cleared', method: 'check', invoice_id: 'inv-1', external_ref: 'check:1' });
    feed(db, ev('invoice.paid', { id: 'in_1', amount_paid: 17500, payment_intent: null }));
    expect(paymentRows(db)).toHaveLength(1);
    expect(balance(db).balance_cents).toBe(0);
  });

  it('an event for a payment we cannot place yet is not recorded, so the retry can apply it', () => {
    const db = start();
    const first = applySim(db, mapStripeEvent(ev('charge.dispute.created', { amount: 1, payment_intent: 'pi_unknown' }, 'evt_x')));
    expect(first).toMatchObject({ applied: false, reason: 'lot_not_found' });
    expect(db.processed.has('evt_x')).toBe(false);
  });
});
