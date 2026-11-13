import type { BalanceRow, LotOwnerRow, LotRecord } from './types.ts';

export interface BillRunParams { year: number; amount_cents: number; due_on: string }

export interface InvoiceDraft {
  lot_id: string;
  lot_number: number;
  owner_name: string;
  number: string;              // 2027-042
  description: string;         // "2027 annual assessment"
  idempotency_key: string;     // billrun-2027-lot-42
  due_on: string;
  amount_cents: number;        // this year's assessment only
  carried_cents: number;       // balance carried from before (may be negative = credit)
  total_cents: number;
  lines: { description: string; amount_cents: number }[];
  delivery: 'email' | 'paper';
  email_to: string | null;     // set only when delivery is 'email'
}

export interface BillRun {
  drafts: InvoiceDraft[];
  totals: { lots: number; email: number; paper: number; billed_cents: number };
}

export function billRunKey(year: number, lotNumber: number): string {
  return `billrun-${year}-lot-${lotNumber}`;
}

// Email only when an owner of the lot has elected electronic notice AND has an address.
// Everyone else gets paper.
export function buildBillRun(lots: LotRecord[], owners: LotOwnerRow[], balances: BalanceRow[], params: BillRunParams): BillRun {
  const balanceByLot = new Map(balances.map((b) => [b.lot_id, b.balance_cents]));
  const sorted = [...lots].sort((a, b) => a.lot_number - b.lot_number);
  const drafts: InvoiceDraft[] = sorted.map((lot) => {
    const lotOwners = owners.filter((o) => o.lot_id === lot.id).map((o) => o.owner);
    const emailOwner = lotOwners.find((o) => o.email_notice_consent && o.email && o.email.trim() !== '');
    const carried = balanceByLot.get(lot.id) ?? 0;
    const lines = [{ description: `${params.year} annual assessment`, amount_cents: params.amount_cents }];
    if (carried !== 0) {
      lines.push({ description: carried > 0 ? 'Balance carried forward' : 'Credit carried forward', amount_cents: carried });
    }
    return {
      lot_id: lot.id,
      lot_number: lot.lot_number,
      owner_name: lotOwners[0]?.full_name ?? 'Current owner',
      number: `${params.year}-${String(lot.lot_number).padStart(3, '0')}`,
      description: `${params.year} annual assessment`,
      idempotency_key: billRunKey(params.year, lot.lot_number),
      due_on: params.due_on,
      amount_cents: params.amount_cents,
      carried_cents: carried,
      total_cents: params.amount_cents + carried,
      lines,
      delivery: emailOwner ? 'email' : 'paper',
      email_to: emailOwner ? emailOwner.email : null,
    };
  });
  const email = drafts.filter((d) => d.delivery === 'email').length;
  return {
    drafts,
    totals: { lots: drafts.length, email, paper: drafts.length - email, billed_cents: drafts.reduce((s, d) => s + d.total_cents, 0) },
  };
}

// Shape the web app's BillRunPreview expects.
export function toPreview(run: BillRun, params: BillRunParams) {
  return {
    year: params.year,
    due_on: params.due_on,
    amount_cents: params.amount_cents,
    lots: run.drafts.map((d) => ({
      lot_id: d.lot_id, lot_number: d.lot_number, owner_name: d.owner_name,
      carried_cents: d.carried_cents, total_cents: d.total_cents, delivery: d.delivery,
    })),
    totals: run.totals,
  };
}

// Guard for the handler: refuse live Stripe keys unless explicitly allowed.
export function liveKeyRefused(stripeKey: string | undefined, allowLive: string | undefined): boolean {
  return !!stripeKey && stripeKey.startsWith('sk_live_') && allowLive !== 'true';
}
