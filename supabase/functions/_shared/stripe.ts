// Stripe webhook logic, kept free of Deno and network code so Vitest can test it.
// Money is integer cents.
// One ledger row per payment, keyed by the PaymentIntent id (external_ref). Later events
// for the same payment (settled, returned, disputed) carry the SAME key, and the database
// function apply_stripe_event moves that row forward (processing -> cleared -> returned)
// instead of adding a second one. Refunds are one row per refund id. Duplicate events are
// ignored by the database through the processed_events table.

const encoder = new TextEncoder();

export type SignatureResult = { ok: true } | { ok: false; reason: string };

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Compare two strings without stopping at the first difference.
export function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

// Stripe-Signature looks like "t=1700000000,v1=abc...,v1=def...".
// `now` is unix seconds. The signed text is `${t}.${payload}`.
export async function verifyStripeSignature(
  payload: string, header: string | null | undefined, secret: string, toleranceSec: number, now: number,
): Promise<SignatureResult> {
  if (!header) return { ok: false, reason: 'missing_header' };
  if (!secret) return { ok: false, reason: 'missing_secret' };
  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') timestamp = v;
    else if (k === 'v1') signatures.push(v);
  }
  const t = Number(timestamp);
  if (!timestamp || !Number.isFinite(t)) return { ok: false, reason: 'bad_timestamp' };
  if (signatures.length === 0) return { ok: false, reason: 'no_v1_signature' };
  if (Math.abs(now - t) > toleranceSec) return { ok: false, reason: 'timestamp_outside_tolerance' };
  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  let match = false;
  for (const s of signatures) if (constantTimeEqual(s, expected)) match = true; // no early exit
  return match ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

// ---- Event mapping ----

export interface StripeEvent {
  id: string;
  type: string;
  created?: number;
  data: { object: Record<string, any> };
}

export type PayMethod = 'ach' | 'card' | 'check' | 'other';
export type PaymentStatus = 'processing' | 'cleared' | 'returned';
export type InvoiceStatus = 'open' | 'processing' | 'paid' | 'void';

// Insert the row, or move the existing row with this external_ref forward.
export interface LedgerUpsert {
  external_ref: string;             // PaymentIntent id (payments) or Refund id (refunds)
  posted_on: string;
  kind: 'payment' | 'refund';
  description: string;
  detail: string | null;
  amount_cents: number;             // payments negative, refunds positive
  status: PaymentStatus;
  method: PayMethod | null;
  // true: the ONE allowed backward move. A won dispute puts a payment that a dispute returned back to cleared.
  // The database only does it for a row still marked 'Payment disputed'.
  reinstate?: boolean;
}

export interface TaskInsert {
  kind: 'payment_returned';
  title: string;
  summary: string;
}

// The payload of the database function apply_stripe_event. The lot is NOT here:
// the database finds it through our invoices (stripe_invoice_id / payment_intent).
// lot_hint is only a last resort from Stripe metadata.
export interface StripeChanges {
  event_id: string;
  event_type: string;
  handled: boolean;
  ignored_reason?: string;
  stripe_invoice_id: string | null;
  payment_intent: string | null;
  lot_hint: string | null;
  ledger: LedgerUpsert[];
  invoice_status: InvoiceStatus | null;
  invoice_force: boolean;           // true: a return or dispute may move the invoice back to open
  tasks: TaskInsert[];
}

function empty(event: StripeEvent, handled: boolean, ignored_reason?: string): StripeChanges {
  return {
    event_id: event.id, event_type: event.type, handled, ignored_reason,
    stripe_invoice_id: null, payment_intent: null, lot_hint: null,
    ledger: [], invoice_status: null, invoice_force: false, tasks: [],
  };
}

function postedOn(event: StripeEvent): string {
  const ms = (event.created ?? 0) * 1000;
  return new Date(ms || 0).toISOString().slice(0, 10);
}

function methodOf(obj: Record<string, any>): PayMethod {
  const types: string[] = obj.payment_method_types ?? [];
  const m = obj.metadata?.pay_method;
  if (m === 'ach' || m === 'card') return m;
  return types.includes('us_bank_account') ? 'ach' : 'card';
}

const idOf = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : (v && typeof v === 'object' && typeof (v as any).id === 'string' ? (v as any).id : null);

const dollars = (cents: number) => (cents / 100).toFixed(2);

export function mapStripeEvent(event: StripeEvent): StripeChanges {
  const obj = event.data?.object ?? {};
  const out = empty(event, true);
  const date = postedOn(event);
  out.lot_hint = obj.metadata?.lot_id ?? null;

  // Which of our records this event is about. Each event type names them differently.
  const isInvoice = event.type.startsWith('invoice.');
  out.stripe_invoice_id = isInvoice ? idOf(obj.id) : idOf(obj.invoice);
  out.payment_intent = event.type.startsWith('payment_intent.') ? idOf(obj.id) : idOf(obj.payment_intent);

  const needRef = () => {
    if (!out.stripe_invoice_id && !out.payment_intent && !out.lot_hint) return empty(event, false, 'no_payment_reference');
    return null;
  };

  switch (event.type) {
    case 'invoice.paid': {
      const refused = needRef(); if (refused) return refused;
      const amount = Math.abs(obj.amount_paid ?? 0);
      if (amount > 0) {
        out.ledger.push({
          // card: the PaymentIntent row (new). ACH: the same row that is processing now.
          external_ref: out.payment_intent ?? `invoice:${obj.id}`,
          posted_on: date, kind: 'payment', description: 'Payment received',
          detail: obj.number ? `Invoice ${obj.number}` : null,
          amount_cents: -amount, status: 'cleared', method: methodOf(obj),
        });
      }
      out.invoice_status = 'paid';
      return out;
    }
    case 'payment_intent.succeeded': {
      const refused = needRef(); if (refused) return refused;
      out.ledger.push({
        external_ref: obj.id, posted_on: date, kind: 'payment', description: 'Payment received',
        detail: obj.metadata?.invoice_number ? `Invoice ${obj.metadata.invoice_number}` : null,
        amount_cents: -Math.abs(obj.amount_received ?? obj.amount ?? 0), status: 'cleared', method: methodOf(obj),
      });
      out.invoice_status = 'paid';
      return out;
    }
    case 'invoice.payment_failed': {
      // The invoice stays open; nothing posts to the ledger.
      const refused = needRef(); if (refused) return refused;
      out.invoice_status = 'open';
      return out;
    }
    case 'invoice.voided': {
      const refused = needRef(); if (refused) return refused;
      out.invoice_status = 'void';
      return out;
    }
    case 'payment_intent.processing': {
      // Bank payments take days. Shown as "processing", not yet subtracted from the balance.
      const refused = needRef(); if (refused) return refused;
      out.ledger.push({
        external_ref: obj.id, posted_on: date, kind: 'payment', description: 'Bank payment processing',
        detail: obj.metadata?.invoice_number ? `Invoice ${obj.metadata.invoice_number}` : null,
        amount_cents: -Math.abs(obj.amount ?? 0), status: 'processing', method: 'ach',
      });
      out.invoice_status = 'processing';
      return out;
    }
    case 'payment_intent.payment_failed': {
      // A failed bank payment is an ACH return. A plain card decline is not a ledger event.
      if (methodOf(obj) !== 'ach') return empty(event, false, 'not_an_ach_return');
      const refused = needRef(); if (refused) return refused;
      const amount = Math.abs(obj.amount ?? 0);
      out.ledger.push({
        external_ref: obj.id, posted_on: date, kind: 'payment', description: 'Bank payment returned',
        detail: obj.last_payment_error?.message ? 'The bank returned this payment' : null,
        amount_cents: -amount, status: 'returned', method: 'ach',
      });
      out.invoice_status = 'open'; out.invoice_force = true;
      out.tasks.push({
        kind: 'payment_returned', title: 'Bank payment returned',
        summary: `A bank payment of ${dollars(amount)} dollars was returned. The lot is unpaid again.`,
      });
      return out;
    }
    case 'refund.created':
    case 'refund.updated':
    case 'charge.refund.updated': {
      // obj is a Refund: its own id and its own amount (not the running total).
      const refused = needRef(); if (refused) return refused;
      out.ledger.push(refundRow(obj, date));
      return out;
    }
    case 'charge.refunded': {
      // obj is the Charge. Post each refund it lists, by refund id, with that refund's amount.
      const refunds: Record<string, any>[] = obj.refunds?.data ?? [];
      if (refunds.length === 0) return empty(event, false, 'refund_details_missing');
      const refused = needRef(); if (refused) return refused;
      for (const r of refunds) out.ledger.push(refundRow({ ...r, metadata: r.metadata ?? obj.metadata }, date, methodOf(obj)));
      return out;
    }
    case 'charge.dispute.created': {
      // A dispute pulls the money back: the original payment row becomes returned.
      // The dispute names the PaymentIntent; our invoice (and so the lot) is found from it.
      const refused = needRef(); if (refused) return refused;
      const amount = Math.abs(obj.amount ?? 0);
      out.ledger.push({
        external_ref: out.payment_intent ?? `dispute:${obj.id}`, posted_on: date, kind: 'payment',
        description: 'Payment disputed', detail: null, amount_cents: -amount, status: 'returned', method: 'card',
      });
      out.invoice_status = 'open'; out.invoice_force = true;
      out.tasks.push({
        kind: 'payment_returned', title: 'Payment disputed',
        summary: `A payment of ${dollars(amount)} dollars was disputed with the card issuer. The lot is unpaid again.`,
      });
      return out;
    }
    case 'charge.dispute.closed': {
      // Won (or an inquiry closed with no dispute): the money was never lost, so the payment clears again.
      // Lost: the payment stays returned, which charge.dispute.created already recorded. Nothing to change,
      // but the event is still recorded (handled) so a replay is a duplicate.
      const refused = needRef(); if (refused) return refused;
      if (obj.status === 'won' || obj.status === 'warning_closed') {
        const amount = Math.abs(obj.amount ?? 0);
        out.ledger.push({
          external_ref: out.payment_intent ?? `dispute:${obj.id}`, posted_on: date, kind: 'payment',
          description: 'Payment received', detail: null, amount_cents: -amount, status: 'cleared', method: 'card', reinstate: true,
        });
        out.invoice_status = 'paid'; out.invoice_force = true;
      }
      return out;
    }
    default:
      return empty(event, false, 'event_type_not_used');
  }
}

function refundRow(r: Record<string, any>, date: string, method: PayMethod | null = null): LedgerUpsert {
  const failed = r.status === 'failed' || r.status === 'canceled';
  return {
    external_ref: r.id, posted_on: date, kind: 'refund', description: 'Refund', detail: null,
    amount_cents: Math.abs(r.amount ?? 0), status: failed ? 'returned' : 'cleared', method,
  };
}
