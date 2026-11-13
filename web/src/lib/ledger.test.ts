import { describe, it, expect } from 'vitest';
import { summarizeBalance, formatCents, addBusinessDays } from './ledger';
import type { LedgerEntry } from '../data/types';

let n = 0;
const e = (amount_cents: number, status: LedgerEntry['status'] = 'cleared', kind?: LedgerEntry['kind']): LedgerEntry => ({
  id: String(n++), lot_id: 'l', posted_on: '2027-02-01', kind: kind ?? (amount_cents > 0 ? 'charge' : 'payment'),
  description: '', detail: null, amount_cents, status, method: null, invoice_id: null, external_ref: null,
});

describe('summarizeBalance', () => {
  it('adds carried arrears to the new charge', () => {
    expect(summarizeBalance([e(2500, 'cleared', 'opening_balance'), e(17500)], []).balance_cents).toBe(20000);
  });
  it('does not subtract a processing ACH payment but shows processing', () => {
    const s = summarizeBalance([e(17500), e(-17500, 'processing')], []);
    expect(s.balance_cents).toBe(17500);
    expect(s.processing_cents).toBe(17500);
    expect(s.state).toBe('processing');
  });
  it('ignores a returned payment', () => {
    expect(summarizeBalance([e(17500), e(-17500, 'returned')], []).state).toBe('unpaid');
  });
  it('paid and credit', () => {
    expect(summarizeBalance([e(17500), e(-17500)], []).state).toBe('paid');
    expect(summarizeBalance([e(17500), e(-20000)], []).state).toBe('credit');
  });
});

describe('helpers', () => {
  it('formatCents', () => {
    expect(formatCents(17500)).toBe('$175.00');
    expect(formatCents(-500)).toBe('−$5.00');
  });
  it('10 business days skips weekends and listed holidays', () => {
    expect(addBusinessDays('2026-11-13T12:00:00Z', 10).slice(0, 10)).toBe('2026-11-27');
    expect(addBusinessDays('2026-11-13T12:00:00Z', 10, ['2026-11-26']).slice(0, 10)).toBe('2026-11-30');
  });
});
