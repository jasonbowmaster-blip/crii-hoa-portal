// Stripe webhook logic, kept free of Deno and network code so Vitest can test it.
// Money is integer cents. Idempotency: every insert carries an external_ref that
// is unique per Stripe event (or the payment id for rows that later get updated),
// so a replayed event cannot post twice.

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

export interface LedgerInsert {
  lot_id: string;
  posted_on: string;
  kind: 'payment' | 'refund' | 'charge' | 'credit';
  description: string;
  detail: string | null;
  amount_cents: number;
  status: 'processing' | 'cleared' | 'returned';
  method: PayMethod | null;
  stripe_invoice_id: string | null; // handler resolves this to invoice_id
  external_ref: string;             // idempotency key
}

export interface LedgerUpdate { external_ref: string; status: 'returned' }

export interface InvoiceUpdate {
  stripe_invoice_id: string;
  status: 'open' | 'processing' | 'paid' | 'void';
}

export interface TaskInsert {
  kind: 'payment_returned';
  lot_id: string;
  title: string;
  summary: string;
  ref_id: string;                   // event id, doubles as the task's idempotency key
}

export interface StripeChanges {
  event_id: string;
  handled: boolean;
  ignored_reason?: string;
  ledger_inserts: LedgerInsert[];
  ledger_updates: LedgerUpdate[];
  invoice_updates: InvoiceUpdate[];
  tasks: TaskInsert[];
}

function empty(event: StripeEvent, handled: boolean, ignored_reason?: string): StripeChanges {
  return { event_id: event.id, handled, ignored_reason, ledger_inserts: [], ledger_updates: [], invoice_updates: [], tasks: [] };
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

// The lot is carried in Stripe metadata that the bill run sets (metadata.lot_id).
function lotOf(obj: Record<string, any>): string | null {
  return obj.metadata?.lot_id ?? null;
}

export function mapStripeEvent(event: StripeEvent): StripeChanges {
  const obj = event.data?.object ?? {};
  const out = empty(event, true);
  const lot_id = lotOf(obj);
  if (!lot_id) return empty(event, false, 'missing_lot_metadata');
  const date = postedOn(event);

  switch (event.type) {
    case 'invoice.paid': {
      out.ledger_inserts.push({
        lot_id, posted_on: date, kind: 'payment', description: 'Payment received',
        detail: obj.number ? `Invoice ${obj.number}` : null,
        amount_cents: -Math.abs(obj.amount_paid ?? 0), status: 'cleared', method: methodOf(obj),
        stripe_invoice_id: obj.id ?? null, external_ref: event.id,
      });
      if (obj.id) out.invoice_updates.push({ stripe_invoice_id: obj.id, status: 'paid' });
      return out;
    }
    case 'invoice.payment_failed': {
      // The invoice stays open; nothing posts to the ledger.
      if (obj.id) out.invoice_updates.push({ stripe_invoice_id: obj.id, status: 'open' });
      return out;
    }
    case 'invoice.voided': {
      if (obj.id) out.invoice_updates.push({ stripe_invoice_id: obj.id, status: 'void' });
      return out;
    }
    case 'payment_intent.processing': {
      // Bank payments take days. Shown as "processing", not yet subtracted from the balance.
      out.ledger_inserts.push({
        lot_id, posted_on: date, kind: 'payment', description: 'Bank payment processing',
        detail: obj.metadata?.invoice_number ? `Invoice ${obj.metadata.invoice_number}` : null,
        amount_cents: -Math.abs(obj.amount ?? 0), status: 'processing', method: 'ach',
        stripe_invoice_id: obj.invoice ?? null, external_ref: obj.id, // payment id, so a later return can find it
      });
      if (obj.invoice) out.invoice_updates.push({ stripe_invoice_id: obj.invoice, status: 'processing' });
      return out;
    }
    case 'payment_intent.payment_failed': {
      // A bank payment that failed AFTER it was processing is an ACH return.
      // A plain card decline is not a ledger event.
      if (methodOf(obj) !== 'ach') return empty(event, false, 'not_an_ach_return');
      const amount = Math.abs(obj.amount ?? 0);
      out.ledger_updates.push({ external_ref: obj.id, status: 'returned' });
      out.ledger_inserts.push({
        lot_id, posted_on: date, kind: 'payment', description: 'Bank payment returned',
        detail: obj.last_payment_error?.message ? 'The bank returned this payment' : null,
        amount_cents: -amount, status: 'returned', method: 'ach',
        stripe_invoice_id: obj.invoice ?? null, external_ref: event.id,
      });
      if (obj.invoice) out.invoice_updates.push({ stripe_invoice_id: obj.invoice, status: 'open' });
      out.tasks.push({
        kind: 'payment_returned', lot_id, title: 'Bank payment returned',
        summary: `A bank payment of ${(amount / 100).toFixed(2)} dollars was returned. The lot is unpaid again.`,
        ref_id: event.id,
      });
      return out;
    }
    case 'charge.refunded': {
      out.ledger_inserts.push({
        lot_id, posted_on: date, kind: 'refund', description: 'Refund',
        detail: null, amount_cents: Math.abs(obj.amount_refunded ?? 0), status: 'cleared',
        method: methodOf(obj), stripe_invoice_id: obj.invoice ?? null, external_ref: event.id,
      });
      return out;
    }
    case 'charge.dispute.created': {
      // A dispute pulls the money back: the original payment stops counting.
      const amount = Math.abs(obj.amount ?? 0);
      if (obj.payment_intent) out.ledger_updates.push({ external_ref: obj.payment_intent, status: 'returned' });
      out.ledger_inserts.push({
        lot_id, posted_on: date, kind: 'payment', description: 'Payment disputed',
        detail: null, amount_cents: -amount, status: 'returned', method: 'card',
        stripe_invoice_id: null, external_ref: event.id,
      });
      out.tasks.push({
        kind: 'payment_returned', lot_id, title: 'Payment disputed',
        summary: `A payment of ${(amount / 100).toFixed(2)} dollars was disputed with the card issuer. The lot is unpaid again.`,
        ref_id: event.id,
      });
      return out;
    }
    default:
      return empty(event, false, 'event_type_not_used');
  }
}
