// The real backend: Supabase auth, Postgres (row-level security does the access
// control; these calls never filter for security) and Edge Functions.
// Column names match types.ts, so most rows pass straight through.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { LotRow, PortalApi } from '../api';
import { businessDaysBetween, summarizeBalance } from '../../lib/ledger';
import type {
  Announcement, BillRunPreview, BoardDashboard, BoardMember, BoardTask, CheckRecord, ClaimRequest,
  DocumentItem, HoaEvent, Invoice, LedgerEntry, Lot, Message, Owner, OwnerHome, ReplyTemplate, Session,
} from '../types';

const SIGNED_URL_SECONDS = 60;
const OPEN_STATUSES: Message['status'][] = ['new', 'acknowledged', 'draft_waiting', 'escalated'];

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

// RPCs that return one row may come back as an object or a one-item array.
function one<T>(data: unknown): T {
  return (Array.isArray(data) ? data[0] : data) as T;
}

// The lot_balances view (SQL) is the one place that decides paid / unpaid / processing / credit for a lot.
interface BalanceRow { lot_id: string; balance_cents: number; processing_cents?: number; state?: LotRow['state'] }
const isPaid = (b: BalanceRow) => b.state === 'paid' || b.state === 'credit';   // same rule as the demo: credit counts as paid

export function createSupabaseApi(url: string, anonKey: string): PortalApi {
  const sb: SupabaseClient = createClient(url, anonKey);

  async function getSession(): Promise<Session | null> {
    const { data } = await sb.auth.getSession();
    const user = data.session?.user;
    if (!user) return null;
    // One sign-in may be linked to several owner records and lots (a shared household email). Never use
    // .single() here: it errors on more than one row and would make the person look unlinked.
    const ownerRes = await sb.from('owners').select('*').eq('user_id', user.id).order('id', { ascending: true });
    const owners = (ownerRes.data as Owner[] | null) ?? [];
    const lots: Lot[] = [];
    if (owners.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const links = await sb.from('lot_owners').select('lot_id, starts_on, ends_on')
        .in('owner_id', owners.map((o) => o.id)).lte('starts_on', today).order('starts_on', { ascending: true }).order('lot_id', { ascending: true });
      const current = ((links.data ?? []) as { lot_id: string; ends_on: string | null }[]).filter((l) => !l.ends_on || l.ends_on >= today);
      const ids = [...new Set(current.map((l) => l.lot_id))];
      if (ids.length > 0) {
        const lotRes = await sb.from('lots').select('*').in('id', ids);
        const byId = new Map(((lotRes.data ?? []) as Lot[]).map((l) => [l.id, l]));
        for (const id of ids) { const l = byId.get(id); if (l) lots.push(l); }
      }
    }
    const boardRes = await sb.from('board_members').select('*').eq('user_id', user.id).eq('active', true).limit(1);
    const board = ((boardRes.data ?? []) as BoardMember[])[0] ?? null;
    return { user_id: user.id, email: user.email ?? '', owner: owners[0] ?? null, lot: lots[0] ?? null, owners, lots, board };
  }

  async function requireSession(): Promise<Session> {
    const s = await getSession();
    if (!s) throw new Error('Please sign in.');
    return s;
  }

  // Not linked to a lot: nothing to show, and the caller must not read "no rows" as "paid up".
  async function ledgerFor(s: Session): Promise<{ entries: LedgerEntry[]; invoices: Invoice[] }> {
    if (!s.lot) return { entries: [], invoices: [] };
    const [entries, invoices] = await Promise.all([
      sb.from('ledger_entries').select('*').eq('lot_id', s.lot.id).order('posted_on', { ascending: false }),
      sb.from('invoices').select('*').eq('lot_id', s.lot.id).neq('status', 'draft').order('due_on', { ascending: false }),
    ]);
    return { entries: must(entries, 'ledger') as LedgerEntry[], invoices: must(invoices, 'invoices') as Invoice[] };
  }

  async function getMyLedger() {
    return ledgerFor(await requireSession());
  }

  async function listDocuments(): Promise<DocumentItem[]> {
    // Row-level security filters by audience; owners never receive board-only rows.
    return must(await sb.from('documents').select('*').order('posted_on', { ascending: false }), 'documents') as DocumentItem[];
  }

  async function listEvents(): Promise<HoaEvent[]> {
    return must(await sb.from('events').select('*').order('starts_at', { ascending: true }), 'events') as HoaEvent[];
  }

  async function listTasks(): Promise<BoardTask[]> {
    return must(await sb.from('board_tasks').select('*').order('created_at', { ascending: false }), 'tasks') as BoardTask[];
  }

  const api: PortalApi = {
    getSession,

    async signInWithGoogle() {
      const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin } });
      if (error) throw new Error(error.message);
    },

    async sendSignInLink(email) {
      // The response is the same whether or not the address is on the roster.
      const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin } });
      if (error) throw new Error(error.message);
      return { sent: true };
    },

    async redeemClaimCode(code) {
      const { data, error } = await sb.rpc('redeem_claim_code', { p_code: code });
      if (error) return { ok: false, message: error.message };
      const row = one<{ ok?: boolean; message?: string } | null>(data);
      return { ok: row?.ok ?? true, message: row?.message ?? 'Your home is now linked to your account.' };
    },

    async signOut() {
      const { error } = await sb.auth.signOut();
      if (error) throw new Error(error.message);
    },

    async getOwnerHome(): Promise<OwnerHome> {
      const session = await requireSession();
      const [ledger, events, announcements, documents] = await Promise.all([
        ledgerFor(session),
        sb.from('events').select('*').gte('starts_at', new Date().toISOString()).order('starts_at', { ascending: true }).limit(1),
        sb.from('announcements').select('*').order('posted_at', { ascending: false }).limit(5),
        // Drafts are shown too (marked Draft): draft minutes must be available to owners. Row-level security hides board-only files.
        sb.from('documents').select('*').order('posted_on', { ascending: false }).limit(3),
      ]);
      return {
        session,
        // With no linked lot this is a meaningless zero; the screens show "not linked yet" instead (see session.lot).
        balance: summarizeBalance(ledger.entries, ledger.invoices),
        next_event: ((must(events, 'events') as HoaEvent[])[0]) ?? null,
        announcements: must(announcements, 'announcements') as Announcement[],
        new_documents: must(documents, 'documents') as DocumentItem[],
      };
    },

    getMyLedger,

    async getPayLink(invoiceId) {
      const inv = must(await sb.from('invoices').select('hosted_invoice_url').eq('id', invoiceId).single(), 'invoice') as { hosted_invoice_url: string | null };
      if (!inv.hosted_invoice_url) throw new Error('This bill cannot be paid online yet. Please contact the board.');
      return inv.hosted_invoice_url;
    },

    listDocuments,

    async openDocument(id) {
      const doc = must(await sb.from('documents').select('storage_path').eq('id', id).single(), 'document') as { storage_path: string };
      const { data, error } = await sb.storage.from('documents').createSignedUrl(doc.storage_path, SIGNED_URL_SECONDS);
      if (error || !data) throw new Error('This document is not available right now.');
      return data.signedUrl;
    },

    listEvents,

    async sendMessage({ topic, body, lotId }) {
      const { data, error } = await sb.rpc('send_message', { p_topic: topic, p_body: body, p_lot_id: lotId ?? null });
      if (error) throw new Error(error.message);
      return one<Message>(data);
    },

    async listMyMessages() {
      const s = await requireSession();
      const ids = (s.owners ?? (s.owner ? [s.owner] : [])).map((o) => o.id);
      if (ids.length === 0) return [];
      return must(await sb.from('messages').select('*').in('owner_id', ids).order('created_at', { ascending: false }), 'messages') as Message[];
    },

    async updateNoticePrefs({ email_notice_consent, board_notice_request }) {
      const { data, error } = await sb.rpc('update_notice_prefs', { p_email_notice_consent: email_notice_consent, p_board_notice_request: board_notice_request });
      if (error) throw new Error(error.message);
      return one<Owner>(data);
    },

    // ---- Board ----

    async getBoardDashboard(): Promise<BoardDashboard> {
      const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const [lots, balances, owners, tasks, messages] = await Promise.all([
        sb.from('lots').select('id', { count: 'exact', head: true }),
        sb.from('lot_balances').select('*'),
        sb.from('owners').select('id', { count: 'exact', head: true }).not('user_id', 'is', null),
        listTasks(),
        sb.from('messages').select('*').gte('created_at', weekAgo),
      ]);
      const bal = must(balances, 'balances') as BalanceRow[];
      const msgs = must(messages, 'messages') as Message[];
      const waiting = msgs.filter((m) => OPEN_STATUSES.includes(m.status));
      const nowIso = new Date().toISOString();
      return {
        lots_total: lots.count ?? 0,
        lots_paid: bal.filter(isPaid).length,
        owners_signed_in: owners.count ?? 0,
        open_tasks: tasks.filter((t) => t.status === 'open'),
        messages_this_week: {
          received: msgs.length,
          answered: msgs.filter((m) => m.answered_at !== null).length,
          waiting: waiting.length,
          oldest_waiting_business_days: waiting.reduce((max, m) => Math.max(max, businessDaysBetween(m.created_at, nowIso)), 0),
        },
      };
    },

    listTasks,

    async resolveTask(id, action, note, ownerId) {
      const { data, error } = await sb.rpc('resolve_task', { p_task_id: id, p_action: action, p_note: note ?? null, p_owner_id: ownerId ?? null });
      if (error) throw new Error(error.message);
      return one<BoardTask>(data);
    },

    async listLots(query) {
      const [lots, links, balances] = await Promise.all([
        sb.from('lots').select('*').order('lot_number', { ascending: true }),
        sb.from('lot_owners').select('lot_id, owners(*)').is('ends_on', null),
        sb.from('lot_balances').select('*'),
      ]);
      const balByLot = new Map((must(balances, 'balances') as BalanceRow[]).map((b) => [b.lot_id, b]));
      const ownersByLot = new Map<string, Owner[]>();
      for (const l of (must(links, 'owners') as unknown as { lot_id: string; owners: Owner | null }[])) {
        if (!l.owners) continue;
        ownersByLot.set(l.lot_id, [...(ownersByLot.get(l.lot_id) ?? []), l.owners]);
      }
      const rows: LotRow[] = (must(lots, 'lots') as Lot[]).map((lot) => {
        const b = balByLot.get(lot.id);
        return { lot, owners: ownersByLot.get(lot.id) ?? [], balance_cents: b?.balance_cents ?? 0, state: b?.state ?? 'unpaid' };
      });
      const q = query?.trim().toLowerCase();
      if (!q) return rows;
      return rows.filter((r) =>
        String(r.lot.lot_number) === q || r.lot.street_address.toLowerCase().includes(q) ||
        r.owners.some((o) => o.full_name.toLowerCase().includes(q)));
    },

    async listInbox(filter) {
      let q = sb.from('messages').select('*').order('created_at', { ascending: false });
      if (filter?.status) q = q.eq('status', filter.status);
      if (filter?.topic) q = q.eq('topic', filter.topic);
      return must(await q, 'inbox') as Message[];
    },

    async listTemplates() {
      return must(await sb.from('reply_templates').select('*').order('name'), 'templates') as ReplyTemplate[];
    },

    async replyWithTemplate(messageId, templateId) {
      const tpl = must(await sb.from('reply_templates').select('*').eq('id', templateId).single(), 'template') as ReplyTemplate;
      if (!tpl.approved_on) throw new Error('This template has not been approved by the board.');
      const res = await sb.from('messages').update({ status: 'answered', answered_at: new Date().toISOString() }).eq('id', messageId).select().single();
      return must(res, 'reply') as Message;
    },

    async logCheck({ lot_id, check_number, amount_cents, received_on }) {
      const { data, error } = await sb.rpc('log_check', { p_lot_id: lot_id, p_check_number: check_number, p_amount_cents: amount_cents, p_received_on: received_on });
      if (error) throw new Error(error.message);
      return one<CheckRecord>(data);
    },

    async confirmCheckDeposit(checkId, outcome) {
      const { data, error } = await sb.rpc('confirm_check_deposit', { p_check_id: checkId, p_outcome: outcome });
      if (error) throw new Error(error.message);
      return one<CheckRecord>(data);
    },

    async markCheckReturned(checkId, note) {
      const { data, error } = await sb.rpc('mark_check_returned', { p_check_id: checkId, p_note: note ?? null });
      if (error) throw new Error(error.message);
      return one<CheckRecord>(data);
    },

    async previewBillRun({ year, amount_cents, due_on }) {
      const { data, error } = await sb.functions.invoke('bill-run', { body: { dry_run: true, year, amount_cents, due_on } });
      if (error) throw new Error(error.message);
      return data as BillRunPreview;
    },

    async postAnnouncement({ title, body, audience }) {
      const res = await sb.from('announcements').insert({ title, body, audience }).select().single();
      return must(res, 'announcement') as Announcement;
    },

    async addDocument({ folder, title, audience, file, is_draft }) {
      let storage_path = '';
      if (file) {
        const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '-');
        storage_path = `${folder}/${crypto.randomUUID()}-${safeName}`;
        const up = await sb.storage.from('documents').upload(storage_path, file, { contentType: file.type || undefined });
        if (up.error) throw new Error(`upload: ${up.error.message}`);
      }
      const res = await sb.from('documents').insert({ folder, title, audience, storage_path, is_draft, posted_on: new Date().toISOString().slice(0, 10) }).select().single();
      return must(res, 'document') as DocumentItem;
    },

    async addEvent(input) {
      const res = await sb.from('events').insert(input).select().single();
      return must(res, 'event') as HoaEvent;
    },

    async listClaimRequests() {
      return must(await sb.from('claim_requests').select('*').order('created_at', { ascending: false }), 'claims') as ClaimRequest[];
    },
  };
  return api;
}
