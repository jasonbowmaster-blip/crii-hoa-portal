// The one interface every screen uses. Two implementations:
//   demo/     in-browser sample data (no network) for the board preview and tests
//   supabase/ the real backend (Supabase auth + Postgres with row-level security + functions)
// Screens must never import an adapter directly; use getApi().

import type {
  Announcement, BillRunPreview, BoardDashboard, BoardTask, CheckRecord, ClaimRequest,
  DocumentFolder, DocumentItem, HoaEvent, Invoice, LedgerEntry, Lot, Message, MessageTopic,
  Owner, OwnerHome, ReplyTemplate, Session, Audience, EventKind,
} from './types';

export interface LotRow { lot: Lot; owners: Owner[]; balance_cents: number; state: 'paid' | 'unpaid' | 'processing' | 'credit' }

export interface PortalApi {
  // --- Auth ---
  getSession(): Promise<Session | null>;
  signInWithGoogle(): Promise<void>;
  sendSignInLink(email: string): Promise<{ sent: true }>; // never reveals whether the email is on the roster
  redeemClaimCode(code: string): Promise<{ ok: boolean; message: string }>; // must already be signed in
  signOut(): Promise<void>;

  // --- Owner ---
  getOwnerHome(): Promise<OwnerHome>;
  getMyLedger(): Promise<{ entries: LedgerEntry[]; invoices: Invoice[] }>;
  getPayLink(invoiceId: string): Promise<string>; // hosted payment page URL
  listDocuments(): Promise<DocumentItem[]>;        // filtered by audience server-side
  openDocument(id: string): Promise<string>;       // short-lived signed URL
  listEvents(): Promise<HoaEvent[]>;
  sendMessage(input: { topic: MessageTopic; body: string }): Promise<Message>;
  listMyMessages(): Promise<Message[]>;
  updateNoticePrefs(input: { email_notice_consent: boolean; board_notice_request: boolean }): Promise<Owner>;

  // --- Board (every call is refused server-side for non-board users) ---
  getBoardDashboard(): Promise<BoardDashboard>;
  listTasks(): Promise<BoardTask[]>;
  resolveTask(id: string, action: 'approve' | 'reject' | 'dismiss', note?: string): Promise<BoardTask>;
  listLots(query?: string): Promise<LotRow[]>;
  listInbox(filter?: { status?: Message['status']; topic?: MessageTopic }): Promise<Message[]>;
  listTemplates(): Promise<ReplyTemplate[]>;
  replyWithTemplate(messageId: string, templateId: string): Promise<Message>;
  logCheck(input: { lot_id: string; check_number: string; amount_cents: number; received_on: string }): Promise<CheckRecord>;
  confirmCheckDeposit(checkId: string, outcome: 'deposited' | 'returned'): Promise<CheckRecord>; // refused if same person who logged it
  previewBillRun(input: { year: number; amount_cents: number; due_on: string }): Promise<BillRunPreview>;
  postAnnouncement(input: { title: string; body: string; audience: Audience }): Promise<Announcement>;
  addDocument(input: { folder: DocumentFolder; title: string; audience: Audience; file: File | null; is_draft: boolean }): Promise<DocumentItem>;
  addEvent(input: { title: string; kind: EventKind; starts_at: string; location: string | null; video_url: string | null; is_public: boolean }): Promise<HoaEvent>;
  listClaimRequests(): Promise<ClaimRequest[]>;
}

let current: PortalApi | null = null;

export function setApi(api: PortalApi) { current = api; }

export function getApi(): PortalApi {
  if (!current) throw new Error('API not initialised; call setApi() in main.tsx');
  return current;
}
