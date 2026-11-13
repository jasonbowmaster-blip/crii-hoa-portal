// The "send" step of the bill run: turns saved invoice drafts into Stripe invoices (TEST mode).
// planBillSend is pure: given the invoice rows it says which Stripe calls to make, each with an idempotency key
// derived from lot + year + invoice number. executeBillSend runs a plan through a StripeClient and saves the
// result (stripe_invoice_id, hosted_invoice_url) through a store. Stripe is NOT asked to email anything:
// auto_advance is false and no sendInvoice call exists here. Re-running never duplicates: rows that already have
// a stripe_invoice_id are skipped, and every call carries a stable idempotency key.
import type { StripeClient } from './stripe-client.ts';

export interface SendInvoiceRow {
  invoice_id: string;
  number: string;                    // 2027-042
  lot_id: string;
  lot_number: number;
  description: string;
  amount_cents: number;              // total the owner is asked to pay
  due_on: string;                    // YYYY-MM-DD
  status: string;                    // invoices.status
  stripe_invoice_id: string | null;
  stripe_customer_id: string | null; // the lot's Stripe customer, if one exists
  no_invoice?: boolean;              // credit-only lot (the bill-run draft says no invoice)
}

export interface PlannedCall { path: string; params: Record<string, unknown>; idempotencyKey: string }

export interface PlannedSend {
  invoice_id: string;
  number: string;
  lot_id: string;
  lot_number: number;
  amount_cents: number;
  existing_customer_id: string | null;
  customer: PlannedCall;     // used only when existing_customer_id is null
  invoice: PlannedCall;      // `customer` is added when it runs
  item: PlannedCall;         // `invoice` and `customer` are added when it runs
  finalize: PlannedCall;     // path holds {INVOICE}, replaced by the real id
}

export interface SendSkip { number: string; reason: 'already_sent' | 'not_payable' | 'no_amount_due' | 'credit_only' | 'bad_number' }

export const PAYMENT_METHOD_TYPES = ['us_bank_account', 'card'];

export function daysUntilDue(dueOn: string, today: string): number {
  const ms = Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000));   // Stripe wants at least 1 day; an overdue date becomes "due tomorrow"
}

export function planBillSend(rows: SendInvoiceRow[], today: string): { sends: PlannedSend[]; skipped: SendSkip[] } {
  const sends: PlannedSend[] = [];
  const skipped: SendSkip[] = [];
  for (const r of [...rows].sort((a, b) => a.number.localeCompare(b.number))) {
    const skip = (reason: SendSkip['reason']) => { skipped.push({ number: r.number, reason }); };
    const year = /^(\d{4})-\d+$/.exec(r.number)?.[1];
    if (!year) { skip('bad_number'); continue; }
    if (r.stripe_invoice_id) { skip('already_sent'); continue; }
    if (r.no_invoice) { skip('credit_only'); continue; }
    if (r.status !== 'draft' && r.status !== 'open') { skip('not_payable'); continue; }
    if (r.amount_cents <= 0) { skip('no_amount_due'); continue; }
    const base = `bill-send:${year}:lot${r.lot_number}:${r.number}`;
    const metadata = { lot_id: r.lot_id, invoice_number: r.number };
    sends.push({
      invoice_id: r.invoice_id, number: r.number, lot_id: r.lot_id, lot_number: r.lot_number, amount_cents: r.amount_cents,
      existing_customer_id: r.stripe_customer_id,
      customer: {
        path: '/v1/customers',
        // No owner name or email goes to Stripe: the lot is the customer.
        params: { name: `Lot ${r.lot_number}`, metadata: { lot_id: r.lot_id, lot_number: r.lot_number } },
        idempotencyKey: `bill-send:lot${r.lot_number}:customer`,
      },
      invoice: {
        path: '/v1/invoices',
        params: {
          collection_method: 'send_invoice',
          days_until_due: daysUntilDue(r.due_on, today),
          auto_advance: false,                          // Stripe must not email or advance it by itself
          pending_invoice_items_behavior: 'exclude',    // only the item we attach below
          payment_settings: { payment_method_types: PAYMENT_METHOD_TYPES },
          description: r.description,
          metadata,
        },
        idempotencyKey: `${base}:invoice`,
      },
      item: {
        path: '/v1/invoiceitems',
        params: { amount: r.amount_cents, currency: 'usd', description: r.description, metadata },
        idempotencyKey: `${base}:item`,
      },
      finalize: { path: '/v1/invoices/{INVOICE}/finalize', params: { auto_advance: false }, idempotencyKey: `${base}:finalize` },
    });
  }
  return { sends, skipped };
}

export interface SendStore {
  saveCustomer(lotId: string, stripeCustomerId: string): Promise<void>;
  saveInvoice(invoiceId: string, stripeInvoiceId: string, hostedUrl: string): Promise<void>;
}

export interface SendResult {
  sent: { number: string; stripe_invoice_id: string }[];
  failed: { number: string; error: string }[];
}

// Runs the plan one invoice at a time. A failure on one invoice is reported and the rest carry on.
export async function executeBillSend(sends: PlannedSend[], stripe: StripeClient, store: SendStore): Promise<SendResult> {
  const result: SendResult = { sent: [], failed: [] };
  const customers = new Map<string, string>();
  for (const s of sends) {
    try {
      let customer = s.existing_customer_id ?? customers.get(s.lot_id) ?? null;
      if (!customer) {
        customer = String((await stripe.post(s.customer.path, s.customer.params, s.customer.idempotencyKey)).id);
        await store.saveCustomer(s.lot_id, customer);
      }
      customers.set(s.lot_id, customer);

      // Idempotency keys only last 24 hours at Stripe, so a re-run after a crash looks for this invoice number first.
      const found = ((await stripe.get('/v1/invoices', { customer, limit: 100 }))?.data ?? [])
        .find((i: any) => i?.metadata?.invoice_number === s.number && i?.status !== 'void');
      let inv: any = found;
      if (!inv) inv = await stripe.post(s.invoice.path, { ...s.invoice.params, customer }, s.invoice.idempotencyKey);
      if (inv.status === 'draft') {
        if (!(Number(inv.total) > 0)) await stripe.post(s.item.path, { ...s.item.params, customer, invoice: inv.id }, s.item.idempotencyKey);
        inv = await stripe.post(s.finalize.path.replace('{INVOICE}', inv.id), s.finalize.params, s.finalize.idempotencyKey);
      }
      if (!inv.hosted_invoice_url) throw new Error('Stripe returned no payment link for the invoice.');
      await store.saveInvoice(s.invoice_id, String(inv.id), String(inv.hosted_invoice_url));
      result.sent.push({ number: s.number, stripe_invoice_id: String(inv.id) });
    } catch (e) {
      result.failed.push({ number: s.number, error: (e as Error).message });
    }
  }
  return result;
}
