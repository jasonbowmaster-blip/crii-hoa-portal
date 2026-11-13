// Shared domain types. This file is the contract between the screens, the demo
// adapter, the Supabase adapter and the database schema. Money is always integer
// cents. Dates are ISO strings (YYYY-MM-DD for dates, full ISO for timestamps).
// Column names in the database use the same snake_case names as these fields.

export type Cents = number;
export type ISODate = string; // 2027-05-15
export type ISOTime = string; // 2027-02-03T14:05:00Z

export type BoardRole =
  | 'president' | 'vice_president' | 'treasurer' | 'secretary' | 'director' | 'arb_chair';

export interface Lot {
  id: string;
  lot_number: number;
  street_address: string;
  status: 'active' | 'on_hold' | 'in_collections';
}

export interface Owner {
  id: string;
  full_name: string;
  first_name: string;
  email: string | null;          // email on file from the roster (may be stale)
  phone: string | null;
  mailing_address: string;
  email_notice_consent: boolean; // Va. Code 55.1-1815: email notice only after the owner elects it
  email_notice_consent_at: ISOTime | null;
  board_notice_request: boolean; // 55.1-1816: owner asked in writing for board-meeting notices (renewed yearly)
  user_id: string | null;        // auth user once signed in
  last_sign_in_at: ISOTime | null;
}

export interface LotOwner {
  lot_id: string;
  owner_id: string;
  starts_on: ISODate;
  ends_on: ISODate | null;
}

export interface BoardMember {
  user_id: string;
  owner_id: string | null;
  role: BoardRole;
  is_admin: boolean;
  term_ends_on: ISODate | null;
  active: boolean;
}

export type InvoiceStatus = 'draft' | 'open' | 'processing' | 'paid' | 'void';

export interface Invoice {
  id: string;
  lot_id: string;
  number: string;            // e.g. 2027-042
  description: string;       // "2027 annual assessment"
  amount_cents: Cents;
  issued_on: ISODate | null;
  due_on: ISODate;
  status: InvoiceStatus;
  stripe_invoice_id: string | null;
  hosted_invoice_url: string | null; // Stripe hosted page; never show the vendor name to owners
  paid_outside_stripe: boolean;
}

export type LedgerKind = 'opening_balance' | 'charge' | 'payment' | 'credit' | 'refund';
export type LedgerStatus = 'processing' | 'cleared' | 'returned';
export type PayMethod = 'ach' | 'card' | 'check' | 'other';

// A per-lot read model built from invoices, Stripe events and recorded checks.
// It is a read-out for owners and the board, NOT the books.
// amount_cents: positive = owner owes more (charge, opening arrears, refund);
// negative = reduces what is owed (payment, credit).
export interface LedgerEntry {
  id: string;
  lot_id: string;
  posted_on: ISODate;
  kind: LedgerKind;
  description: string;
  detail: string | null;     // "Invoice 2027-042, due May 15" / "Ending 6789" / "Deposit confirmed"
  amount_cents: Cents;
  status: LedgerStatus;
  method: PayMethod | null;
  invoice_id: string | null;
  external_ref: string | null; // Stripe event / payment id, check number
}

export type CheckState = 'received' | 'deposited' | 'returned';

export interface CheckRecord {
  id: string;
  lot_id: string;
  check_number: string;
  amount_cents: Cents;
  received_on: ISODate;
  logged_by: string;              // user id of the person who opened the mail
  deposit_confirmed_by: string | null; // must differ from logged_by (two-person rule)
  state: CheckState;
}

export type MessageTopic = 'question' | 'maintenance' | 'arb' | 'billing' | 'records' | 'complaint' | 'other';
export type MessageStatus = 'new' | 'acknowledged' | 'draft_waiting' | 'escalated' | 'answered' | 'closed';

export interface Message {
  id: string;
  lot_id: string | null;
  owner_id: string | null;
  topic: MessageTopic;
  subject: string;
  body: string;
  status: MessageStatus;
  created_at: ISOTime;
  answered_at: ISOTime | null;
  due_at: ISOTime | null;       // records requests: 10 business days from arrival
  gmail_thread_id: string | null;
  assigned_to: string | null;   // board member user id
  channel: 'portal' | 'email' | 'phone' | 'mail';
}

export type Audience = 'public' | 'owners' | 'board';

export interface DocumentItem {
  id: string;
  folder: DocumentFolder;
  title: string;
  storage_path: string;        // private bucket path; served only through short-lived signed links
  audience: Audience;
  posted_on: ISODate;
  is_draft: boolean;           // draft minutes until approved
}

export type DocumentFolder =
  | 'governing' | 'rules_arb' | 'minutes' | 'board_packets' | 'budgets' | 'forms';

export const FOLDER_LABELS: Record<DocumentFolder, string> = {
  governing: 'Governing documents',
  rules_arb: 'Rules and ARB guidelines',
  minutes: 'Meeting minutes',
  board_packets: 'Board packets',
  budgets: 'Budgets and financials',
  forms: 'Forms',
};

export type EventKind = 'board_meeting' | 'annual_meeting' | 'tree_work' | 'dues_date' | 'other';

export interface HoaEvent {
  id: string;
  title: string;
  kind: EventKind;
  starts_at: ISOTime;
  location: string | null;
  video_url: string | null;
  notes: string | null;
  is_public: boolean;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  posted_at: ISOTime;
  audience: Audience;
}

export type TaskKind =
  | 'check_confirm'        // second person confirms a logged check is on the deposit
  | 'payment_returned'     // ACH return or dispute flipped a lot back to unpaid
  | 'claim_attach'         // a claim code was redeemed; board confirms the new email for the lot
  | 'template_reply'       // a message an approved template answers
  | 'draft_approval'       // a draft reply waiting for approval
  | 'records_request'      // 10-business-day clock
  | 'returned_mail'        // Lob returned mail or bounced email -> fall back
  | 'roster_change';

export interface BoardTask {
  id: string;
  kind: TaskKind;
  lot_id: string | null;
  title: string;
  summary: string;
  status: 'open' | 'done' | 'dismissed';
  created_at: ISOTime;
  due_at: ISOTime | null;
  ref_id: string | null;       // message / check / claim id
  draft_body?: string | null;  // reply tasks: the exact text that will go to the owner, so the board can read it first
  template_id?: string | null; // template_reply tasks: the template that would be sent
  resolved_by: string | null;
  resolved_at: ISOTime | null;
}

export interface ReplyTemplate {
  id: string;
  name: string;
  body: string;                // fixed text; variables only from posted facts
  version: number;
  approved_on: ISODate | null; // board approval date; unapproved templates cannot be sent
}

export interface ClaimRequest {
  id: string;
  lot_id: string;
  email: string;
  created_at: ISOTime;
  status: 'pending' | 'approved' | 'rejected';
  user_id?: string | null;   // the sign-in that redeemed the code (demo only; a board member may not decide their own)
  code?: string | null;      // the claim code it used (demo only; given back when the claim is rejected)
}

// ---- Composite views the screens read ----

export interface Session {
  user_id: string;
  email: string;
  owner: Owner | null;
  lot: Lot | null;            // the owner's lot (first active one); null = this sign-in is not linked to a home yet
  // One sign-in can link to several owner records and lots (shared household email). Optional; the
  // first entries match `owner` and `lot`. Absent means "just the one above".
  owners?: Owner[];
  lots?: Lot[];
  board: BoardMember | null;  // present only for active board members
}

export interface BalanceSummary {
  balance_cents: Cents;        // what is owed now; processing payments not yet counted
  processing_cents: Cents;     // payments still clearing (shown separately)
  state: 'paid' | 'unpaid' | 'processing' | 'credit';
  next_due_on: ISODate | null;
  open_invoice: Invoice | null;
}

export interface OwnerHome {
  session: Session;
  balance: BalanceSummary;
  next_event: HoaEvent | null;
  announcements: Announcement[];
  new_documents: DocumentItem[];
}

export interface BoardDashboard {
  lots_total: number;
  lots_paid: number;
  owners_signed_in: number;
  open_tasks: BoardTask[];
  messages_this_week: { received: number; answered: number; waiting: number; oldest_waiting_business_days: number };
}

export interface BillRunPreview {
  year: number;
  due_on: ISODate;
  amount_cents: Cents;
  lots: { lot_id: string; lot_number: number; owner_name: string; carried_cents: Cents; processing_cents?: Cents; total_cents: Cents; delivery: 'email' | 'paper';
    // credit_left_cents > 0 (no_invoice): the carried credit is larger than the dues, so the lot gets NO invoice and keeps the rest of its credit
    credit_left_cents?: Cents; no_invoice?: boolean }[];
  // processing_cents: bank payments still processing. NOT subtracted from carried/total (same rule as lot_balances);
  // shown so the board can see who may be billed for money already on its way.
  totals: { lots: number; email: number; paper: number; billed_cents: Cents; processing_cents?: Cents; credit_only?: number };
}
