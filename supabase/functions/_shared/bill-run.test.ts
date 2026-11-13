import { describe, expect, it } from 'vitest';
import { buildBillRun, liveKeyRefused, toPreview } from './bill-run.ts';
import type { LotOwnerRow, LotRecord } from './types.ts';

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
    expect(run.totals).toEqual({ lots: 3, email: 1, paper: 2, billed_cents: 18000 + 20500 + 17000 });
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
