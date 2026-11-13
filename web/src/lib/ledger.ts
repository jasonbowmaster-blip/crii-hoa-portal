import type { BalanceSummary, Invoice, LedgerEntry } from '../data/types';

// Balance rules (mirrors the SQL view public.lot_balances; keep them in step):
// - returned entries count for nothing
// - processing payments are NOT subtracted yet ("counts once it clears")
// - state: credit if < 0; paid if 0 and nothing processing; processing if the
//   remaining balance would be covered by processing payments; else unpaid
export function summarizeBalance(entries: LedgerEntry[], invoices: Invoice[]): BalanceSummary {
  let balance = 0;
  let processing = 0;
  for (const e of entries) {
    if (e.status === 'returned') continue;
    if (e.status === 'processing' && e.amount_cents < 0) { processing += -e.amount_cents; continue; }
    balance += e.amount_cents;
  }
  const open = invoices
    .filter((i) => i.status === 'open' || i.status === 'processing')
    .sort((a, b) => a.due_on.localeCompare(b.due_on))[0] ?? null;
  let state: BalanceSummary['state'];
  if (balance < 0) state = 'credit';
  else if (balance === 0) state = processing > 0 ? 'processing' : 'paid';
  else if (processing >= balance) state = 'processing';
  else state = 'unpaid';
  return { balance_cents: balance, processing_cents: processing, state, next_due_on: open?.due_on ?? null, open_invoice: open };
}

export function formatCents(c: number): string {
  const neg = c < 0;
  const s = (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${neg ? '−' : ''}$${s}`;
}

function isBusinessDay(d: Date, holidays: string[]): boolean {
  const dow = d.getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.includes(d.toISOString().slice(0, 10));
}

// Virginia records requests: 10 business days for a self-managed association.
// Weekends skipped; holidays are passed in so the board can maintain the list.
export function addBusinessDays(startISO: string, days: number, holidays: string[] = []): string {
  const d = new Date(startISO);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isBusinessDay(d, holidays)) added++;
  }
  return d.toISOString();
}

export function businessDaysBetween(fromISO: string, toISO: string, holidays: string[] = []): number {
  const d = new Date(fromISO);
  const end = new Date(toISO);
  let n = 0;
  for (;;) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d > end) break;
    if (isBusinessDay(d, holidays)) n++;
  }
  return n;
}
