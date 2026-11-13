import { describe, expect, it } from 'vitest';
import { buildBillRun, liveKeyRefused, summarizeYearRows, toPreview, type YearLedgerRow } from './bill-run.ts';
import type { LotOwnerRow, LotRecord } from './types.ts';
import { summarizeBalance } from '../../../web/src/lib/ledger';
import type { LedgerEntry } from '../../../web/src/data/types';

const lots: LotRecord[] = [
  { id: 'a', lot_number: 42, street_address: '1 Oak Ln', status: 'active' },
  { id: 'b', lot_number: 7, street_address: '2 Oak Ln', status: 'active' },
  { id: 'c', lot_number: 100, street_address: '3 Oak Ln', status: 'active' },
];
const owner = (id: string, consent: boolean, email: string | null) => ({ id, full_name: `Owner ${id}`, email, mailing_address: 'x', email_notice_consent: consent });
const owners: LotOwnerRow[] = [
  { lot_id: 'a', owner: owner('1', true, 'one@example.test') },
  { lot_id: 'b', owner: owner('2', false, 'two@example.test') },
  { lot_id: 'c', owner: owner('3', true, null) },
];
const params = { year: 2027, amount_cents: 18000, due_on: '2027-05-15' };

describe('buildBillRun', () => {
  const run = buildBillRun(lots, owners, [{ lot_id: 'b', balance_cents: 2500 }, { lot_id: 'c', balance_cents: -1000 }], params);
  const by = (n: number) => run.drafts.find((d) => d.lot_number === n)!;

  it('uses deterministic keys and numbers, sorted by lot', () => {
    expect(run.drafts.map((d) => d.lot_number)).toEqual([7, 42, 100]);
    expect(by(42).idempotency_key).toBe('billrun-2027-lot-42');
    expect(by(42).number).toBe('2027-042');
    expect(buildBillRun(lots, owners, [], params)).toEqual(buildBillRun(lots, owners, [], params));
  });
  it('adds a carried-balance line only when there is one', () => {
    expect(by(42).lines).toHaveLength(1);
    expect(by(7).lines[1]).toEqual({ description: 'Balance carried forward', amount_cents: 2500 });
    expect(by(7).total_cents).toBe(20500);
    expect(by(100).total_cents).toBe(17000);
  });
  it('emails only with consent and an address', () => {
    expect(by(42)).toMatchObject({ delivery: 'email', email_to: 'one@example.test' });
    expect(by(7)).toMatchObject({ delivery: 'paper', email_to: null }); // email on file, no consent
    expect(by(100).delivery).toBe('paper'); // consent but no address
  });
  it('totals and preview shape', () => {
    expect(run.totals).toEqual({ lots: 3, email: 1, paper: 2, billed_cents: 18000 + 20500 + 17000, processing_cents: 0, credit_only: 0 });
    expect(toPreview(run, params).lots[0]).toMatchObject({ lot_number: 7, carried_cents: 2500, delivery: 'paper' });
  });
});

describe('liveKeyRefused', () => {
  it('refuses live keys unless ALLOW_LIVE=true', () => {
    expect(liveKeyRefused('sk_live_abc', undefined)).toBe(true);
    expect(liveKeyRefused('sk_live_abc', 'true')).toBe(false);
    expect(liveKeyRefused('sk_test_abc', undefined)).toBe(false);
  });
});

describe('credits and re-runs', () => {
  it('a credit bigger than the dues gives a zero invoice, not a negative one', () => {
    const run = buildBillRun(lots, owners, [{ lot_id: 'c', balance_cents: -25000 }], params);
    const d = run.drafts.find((x) => x.lot_number === 100)!;
    expect(d).toMatchObject({ total_cents: 0, credit_left_cents: 7000, carried_cents: -25000 });
    expect(run.drafts.every((x) => x.total_cents >= 0)).toBe(true);
  });
  it('a re-run does not count its own posted charge as a carried balance', () => {
    const first = buildBillRun(lots, owners, [], params);
    // after the run posts 18000 per lot, lot_balances shows 18000 for each lot
    const after = lots.map((l) => ({ lot_id: l.id, balance_cents: 18000 }));
    const posted = lots.map((l) => ({ lot_id: l.id, balance_cents: 18000 }));
    expect(buildBillRun(lots, owners, after, params, posted)).toEqual(first);
  });
});

describe('bank payments still processing', () => {
  // lot b owes 18000 (last year's dues) and has paid it by bank, still processing: lot_balances says 18000 owed, 18000 processing
  const balances = [{ lot_id: 'b', balance_cents: 18000, processing_cents: 18000 }, { lot_id: 'a', balance_cents: 0, processing_cents: 0 }];
  const run = buildBillRun(lots, owners, balances, params);
  const b = run.drafts.find((d) => d.lot_number === 7)!;
  it('does not subtract processing payments from the carried balance (same rule as lot_balances)', () => {
    expect(b.carried_cents).toBe(18000);
    expect(b.total_cents).toBe(36000);
  });
  it('reports them separately on the draft, the totals and the preview', () => {
    expect(b.processing_cents).toBe(18000);
    expect(run.drafts.find((d) => d.lot_number === 42)!.processing_cents).toBe(0);
    expect(run.totals.processing_cents).toBe(18000);
    expect(toPreview(run, params).lots.find((l) => l.lot_number === 7)).toMatchObject({ carried_cents: 18000, processing_cents: 18000 });
    expect(toPreview(run, params).totals.processing_cents).toBe(18000);
  });
  it('matches the web app balance rule: the same entries give the same carried and processing amounts', () => {
    const entries = [
      { id: '1', lot_id: 'b', posted_on: '2026-02-01', kind: 'charge', description: 'x', detail: null, amount_cents: 18000, status: 'cleared', method: null, invoice_id: null, external_ref: null },
      { id: '2', lot_id: 'b', posted_on: '2027-01-10', kind: 'payment', description: 'x', detail: null, amount_cents: -18000, status: 'processing', method: 'ach', invoice_id: null, external_ref: null },
    ] as LedgerEntry[];
    const s = summarizeBalance(entries, []);
    expect([s.balance_cents, s.processing_cents]).toEqual([b.carried_cents, b.processing_cents]);
  });
  it('a processing payment on this year\'s own invoice is not flagged when the run is repeated', () => {
    const after = [{ lot_id: 'b', balance_cents: 18000, processing_cents: 18000 }];      // charge posted 18000, paid by bank, processing
    const posted = [{ lot_id: 'b', balance_cents: 18000 }];
    const rerun = buildBillRun(lots, owners, after, params, posted, [{ lot_id: 'b', balance_cents: 18000 }]);
    const d = rerun.drafts.find((x) => x.lot_number === 7)!;
    expect(d).toMatchObject({ carried_cents: 0, processing_cents: 0, total_cents: 18000 });
    expect(buildBillRun(lots, owners, after, params, posted, [{ lot_id: 'b', balance_cents: 18000 }])).toEqual(rerun);
  });
});

describe('credit-only lots', () => {
  const credit = (c: number) => buildBillRun(lots, owners, [{ lot_id: 'c', balance_cents: c }], params).drafts.find((x) => x.lot_number === 100)!;
  it('a credit larger than the dues means no invoice, the credit is carried and listed in the preview', () => {
    const run = buildBillRun(lots, owners, [{ lot_id: 'c', balance_cents: -25000 }], params);
    const d = run.drafts.find((x) => x.lot_number === 100)!;
    expect(d).toMatchObject({ no_invoice: true, total_cents: 0, credit_left_cents: 7000, carried_cents: -25000 });
    expect(run.totals.credit_only).toBe(1);
    expect(run.totals.billed_cents).toBe(18000 + 18000);   // lots 42 and 7 only
    expect(toPreview(run, params).lots.find((l) => l.lot_number === 100)).toMatchObject({ no_invoice: true, credit_left_cents: 7000, total_cents: 0 });
    expect(toPreview(run, params).totals.credit_only).toBe(1);
  });
  it('a credit exactly equal to the dues is a zero invoice, not credit-only', () => {
    expect(credit(-18000)).toMatchObject({ no_invoice: false, total_cents: 0, credit_left_cents: 0 });
  });
  it('a smaller credit reduces the invoice', () => {
    expect(credit(-1000)).toMatchObject({ no_invoice: false, total_cents: 17000, credit_left_cents: 0 });
  });
});

describe('re-running after the run was posted and paid (no double counting)', () => {
  const row = (lot_id: string, amount_cents: number, o: Partial<YearLedgerRow> = {}): YearLedgerRow =>
    ({ lot_id, amount_cents, status: 'cleared', external_ref: null, invoice_number: null, ...o });
  // lot b carried 2500 into 2027; the invoice was 20500 and has been paid in full.
  const before = [{ lot_id: 'b', balance_cents: 2500 }];
  const first = buildBillRun(lots, owners, before, params);
  const afterRows = [
    row('b', 18000, { external_ref: 'inv:2027-007', invoice_number: '2027-007' }),                 // the charge the run posted
    row('b', -20500, { external_ref: 'pi_1', invoice_number: '2027-007' }),                        // paid in full
    row('b', 2500, { external_ref: 'open:2027-007' }),                                              // an older row: not this year's
    row('a', 99999, { external_ref: 'inv:2026-042', invoice_number: '2026-042' }),                  // last year's: not this year's
  ];
  it('leaves the charge AND this year\'s payments out of the carried balance', () => {
    const { posted, processing } = summarizeYearRows(afterRows, 2027);
    expect(posted).toEqual([{ lot_id: 'b', balance_cents: -2500 }]);
    expect(processing).toEqual([]);
    const balances = [{ lot_id: 'b', balance_cents: 0 }];             // lot_balances after the payment: 2500 + 18000 - 20500
    const rerun = buildBillRun(lots, owners, balances, params, posted, processing);
    expect(rerun.drafts.find((d) => d.lot_number === 7)).toMatchObject({ carried_cents: 2500, total_cents: 20500 });
    expect(rerun).toEqual(first);
  });
  it('without the payment rows (charge only) the paid-up lot would wrongly show a credit; that is what summarizeYearRows prevents', () => {
    const chargeOnly = [{ lot_id: 'b', balance_cents: 18000 }];
    const wrong = buildBillRun(lots, owners, [{ lot_id: 'b', balance_cents: 0 }], params, chargeOnly);
    expect(wrong.drafts.find((d) => d.lot_number === 7)!.carried_cents).toBe(-18000);
  });
  it('ignores returned rows, and counts processing payments separately', () => {
    const { posted, processing } = summarizeYearRows([
      row('b', 18000, { external_ref: 'inv:2027-007', invoice_number: '2027-007' }),
      row('b', -18000, { external_ref: 'pi_2', invoice_number: '2027-007', status: 'returned' }),
      row('b', -18000, { external_ref: 'pi_3', invoice_number: '2027-007', status: 'processing' }),
    ], 2027);
    expect(posted).toEqual([{ lot_id: 'b', balance_cents: 18000 }]);
    expect(processing).toEqual([{ lot_id: 'b', balance_cents: 18000 }]);
  });
  it('counts the charge of a credit-only lot (no invoice behind it) through its external_ref', () => {
    const { posted } = summarizeYearRows([row('c', 18000, { external_ref: 'inv:2027-100' })], 2027);
    expect(posted).toEqual([{ lot_id: 'c', balance_cents: 18000 }]);
    // credit 25000 carried; run posted 18000; lot_balances = -7000; the re-run still sees -25000 carried
    const rerun = buildBillRun(lots, owners, [{ lot_id: 'c', balance_cents: -7000 }], params, posted);
    expect(rerun.drafts.find((d) => d.lot_number === 100)).toMatchObject({ carried_cents: -25000, no_invoice: true });
  });
});
