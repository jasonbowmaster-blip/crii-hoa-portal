// In-memory twin of the SQL function apply_stripe_event (supabase/migrations/0002_money.sql, last redefined in 0006_grok.sql).
// Used ONLY by tests, to run whole event sequences through the mapper and check the balance.
// The real rules live in SQL and are tested there (supabase/tests/sql/80_money.sql); keep the two in step.
import type { StripeChanges } from './stripe.ts';

export interface SimLedgerRow {
  lot_id: string; posted_on: string; kind: string; description: string; detail: string | null;
  amount_cents: number; status: 'processing' | 'cleared' | 'returned'; method: string | null;
  invoice_id: string | null; external_ref: string;
}
export interface SimInvoice {
  id: string; lot_id: string; number: string; amount_cents: number;
  status: 'draft' | 'open' | 'processing' | 'paid' | 'void';
  stripe_invoice_id: string | null; stripe_payment_intent_id: string | null; paid_outside_stripe: boolean;
}
export interface SimDb { invoices: SimInvoice[]; ledger: SimLedgerRow[]; tasks: { lot_id: string; kind: string }[]; processed: Set<string> }

export const newSimDb = (invoices: SimInvoice[]): SimDb => ({ invoices, ledger: [], tasks: [], processed: new Set() });

const ledgerRank = { processing: 0, cleared: 1, returned: 2 } as const;
const invoiceRank = { draft: 0, open: 1, processing: 2, paid: 3, void: 4 } as const;

export function applySim(db: SimDb, c: StripeChanges): { applied: boolean; duplicate?: boolean; reason?: string } {
  if (!c.handled) return { applied: false, reason: c.ignored_reason };
  if (db.processed.has(c.event_id)) return { applied: false, duplicate: true };

  let inv = db.invoices.find((i) => c.stripe_invoice_id && i.stripe_invoice_id === c.stripe_invoice_id)
    ?? db.invoices.find((i) => c.payment_intent && i.stripe_payment_intent_id === c.payment_intent);
  const piRow = db.ledger.find((l) => c.payment_intent && l.external_ref === c.payment_intent);
  if (!inv && piRow?.invoice_id) inv = db.invoices.find((i) => i.id === piRow.invoice_id);
  const lot = inv?.lot_id ?? piRow?.lot_id ?? c.lot_hint;
  if (!lot) return { applied: false, reason: 'lot_not_found' };
  db.processed.add(c.event_id);
  if (inv && c.payment_intent && !inv.stripe_payment_intent_id) inv.stripe_payment_intent_id = c.payment_intent;

  let reinstated = 0;
  const reinstateAsked = c.ledger.some((l) => l.reinstate);
  const skipMoney = c.event_type === 'invoice.paid' && inv?.paid_outside_stripe;
  if (!skipMoney) {
    for (const l of c.ledger) {
      if (l.reinstate) {
        // a won dispute: only a payment row that a dispute returned goes back to cleared
        const row = db.ledger.find((r) => r.external_ref === l.external_ref && r.lot_id === lot);
        if (row && row.kind === 'payment' && row.status === 'returned' && row.description === 'Payment disputed') {
          row.status = 'cleared'; row.description = l.description; reinstated++;
        }
        continue;
      }
      const existing = db.ledger.find((r) => r.external_ref === l.external_ref);
      if (!existing) {
        db.ledger.push({ ...l, lot_id: lot, invoice_id: inv?.id ?? null });
      } else if (ledgerRank[l.status] > ledgerRank[existing.status]) {
        existing.status = l.status; existing.description = l.description;
        existing.detail = l.detail ?? existing.detail; existing.method = existing.method ?? l.method;
      }
    }
  }
  // invoice.voided before payment: one credit row keyed by the void event undoes the unpaid part of the invoice's charge
  // (cleared rows only). Already paid or already void: nothing is reversed. Mirrors apply_stripe_event in 0006_grok.sql.
  if (c.reverse_invoice_charge && inv && inv.status !== 'paid' && inv.status !== 'void') {
    const unpaid = db.ledger
      .filter((r) => r.invoice_id === inv.id && r.status === 'cleared' && ['charge', 'payment', 'credit', 'refund'].includes(r.kind))
      .reduce((sum, r) => sum + r.amount_cents, 0);
    const ref = `void:${c.event_id}`;
    if (unpaid > 0 && !db.ledger.some((r) => r.external_ref === ref)) {
      db.ledger.push({ lot_id: lot, posted_on: new Date().toISOString().slice(0, 10), kind: 'credit', description: 'Invoice voided',
        detail: `Invoice ${inv.number} was voided`, amount_cents: -unpaid, status: 'cleared', method: null, invoice_id: inv.id, external_ref: ref });
    }
  }
  // a won-dispute event that found nothing to reinstate must not mark the invoice paid
  const invoiceStatus = reinstateAsked && reinstated === 0 ? null : c.invoice_status;
  if (inv && invoiceStatus) {
    const returned = db.ledger.some((r) => r.external_ref === c.payment_intent && r.kind === 'payment' && r.status === 'returned');
    if (inv.status === 'void' && invoiceStatus !== 'void') { /* never revive */ }
    else if (c.invoice_force || invoiceStatus === 'void' || (invoiceRank[invoiceStatus] > invoiceRank[inv.status] && !returned)) {
      inv.status = invoiceStatus;
    }
  }
  for (const t of c.tasks) db.tasks.push({ lot_id: lot, kind: t.kind });
  return { applied: true };
}
