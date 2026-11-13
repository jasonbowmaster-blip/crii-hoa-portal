// In-browser demo implementation of PortalApi. No network. State lives in memory and is
// saved to localStorage under one key (every storage call is wrapped in try/catch, so it
// also works when storage is blocked). It follows the same rules as the real system:
// balances come from summarizeBalance, a second person must confirm a check deposit,
// records requests get a 10-business-day clock, board calls are refused for owners.
import type { LotRow, PortalApi } from '../api';
import type {
  Announcement, Audience, BalanceSummary, BillRunPreview, BoardDashboard, BoardTask, CheckRecord,
  ClaimRequest, DocumentFolder, DocumentItem, EventKind, HoaEvent, LedgerEntry, Message,
  MessageTopic, Owner, OwnerHome, ReplyTemplate, Session,
} from '../types';
import { addBusinessDays, businessDaysBetween, formatCents, summarizeBalance } from '../../lib/ledger';
import {
  DEMO_CLAIM_CODE, DEMO_NOW, PAT_LOT_NUMBER, PAT_USER, SAM_USER, createSeed,
  type DemoState, type Persona,
} from './seed';

export { DEMO_CLAIM_CODE, DEMO_NOW };
export type { Persona };

const STORAGE_KEY = 'hoa-portal-demo-v1';

export interface DemoOptions {
  persona?: Persona;
  latencyMs?: number;          // default 150; use 0 in tests
  now?: string;                // ISO time; default is the frozen demo clock
  checkLoggerUserId?: string;  // who logCheck records as; default "Sam (secretary)"
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function loadState(): DemoState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DemoState;
    return parsed && Array.isArray(parsed.lots) && Array.isArray(parsed.ledger) ? parsed : null;
  } catch {
    return null;
  }
}

function saveState(state: DemoState): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage blocked: stay in memory */ }
}

function clearStorage(): void {
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

// The most recently created demo API, so the toolbar helpers below can reach it.
interface Controller { setPersona(p: Persona): void; reset(): void }
let active: Controller | null = null;

function announceChange() {
  try { window.dispatchEvent(new Event('demo-state-change')); } catch { /* no window */ }
}

export function demoSwitchPersona(p: Persona): void {
  if (active) { active.setPersona(p); return; }
  const s = loadState() ?? createSeed();
  s.persona = p;
  saveState(s);
  announceChange();
}

export function demoReset(): void {
  if (active) { active.reset(); return; }
  clearStorage();
  announceChange();
}

export function createDemoApi(opts: DemoOptions = {}): PortalApi {
  const latency = opts.latencyMs ?? 150;
  const nowISO = () => opts.now ?? DEMO_NOW;
  const loggerUser = opts.checkLoggerUserId ?? SAM_USER;

  let state: DemoState = loadState() ?? createSeed();
  if (opts.persona) state.persona = opts.persona;

  const save = () => saveState(state);
  active = {
    setPersona(p) { state.persona = p; save(); announceChange(); },
    reset() { clearStorage(); state = createSeed(); announceChange(); },
  };

  const wait = () => (latency > 0 ? new Promise<void>((r) => setTimeout(r, latency)) : Promise.resolve());
  const newId = (prefix: string) => `${prefix}-demo-${state.seq++}`;

  // ---- helpers ----
  const signedIn = () => state.persona !== 'signed_out';
  const isBoard = () => state.persona === 'board';
  const requireSignedIn = () => { if (!signedIn()) throw new Error('Please sign in first.'); };
  const requireBoard = () => { if (!isBoard()) throw new Error('This page is for board members only.'); };
  // Owner records and lots linked to this sign-in. Empty for the 'unlinked' persona.
  const myOwners = (): Owner[] => (state.persona === 'unlinked' ? [] : state.owners.filter((o) => o.user_id === PAT_USER));
  // ends_on is the LAST day of access (same rule as my_lot_ids() / my_owner_ids() in the database)
  const today = () => nowISO().slice(0, 10);
  const isCurrent = (lo: { starts_on: string; ends_on: string | null }) => lo.starts_on <= today() && (!lo.ends_on || lo.ends_on >= today());
  const hasCurrentLot = (ownerId: string) => state.lot_owners.some((lo) => lo.owner_id === ownerId && isCurrent(lo));
  const myLots = () => {
    const ids = new Set(myOwners().map((o) => o.id));
    return state.lot_owners
      .filter((lo) => ids.has(lo.owner_id) && isCurrent(lo))
      .sort((a, b) => a.starts_on.localeCompare(b.starts_on) || a.lot_id.localeCompare(b.lot_id))
      .map((lo) => state.lots.find((l) => l.id === lo.lot_id)!)
      .filter(Boolean);
  };
  const myLotOrNull = () => myLots()[0] ?? null;
  const myLot = () => {
    const lot = myLotOrNull();
    if (!lot) throw new Error('This sign-in is not linked to a home yet. Enter the code from your letter, or contact the board.');
    return lot;
  };
  const lotEntries = (lotId: string) => state.ledger.filter((e) => e.lot_id === lotId);
  const lotInvoices = (lotId: string) => state.invoices.filter((i) => i.lot_id === lotId);
  const balanceOf = (lotId: string): BalanceSummary => summarizeBalance(lotEntries(lotId), lotInvoices(lotId));
  const ownersOf = (lotId: string): Owner[] =>
    state.lot_owners.filter((lo) => lo.lot_id === lotId && isCurrent(lo))
      .map((lo) => state.owners.find((o) => o.id === lo.owner_id)!).filter(Boolean);
  const me = () => {
    const o = myOwners()[0];
    if (!o) throw new Error('This sign-in is not linked to a home yet. Enter the code from your letter, or contact the board.');
    return o;
  };
  const boardMember = () => state.board.find((b) => b.user_id === PAT_USER && b.active) ?? null;
  const canSee = (a: Audience) => a === 'public' || (a === 'owners' && signedIn()) || (a === 'board' && isBoard());

  function session(): Session | null {
    if (!signedIn()) return null;
    const owners = myOwners();
    const lots = myLots();
    return {
      user_id: PAT_USER, email: owners[0]?.email ?? 'pat.example@example.com',
      owner: clone(owners[0] ?? null), lot: clone(lots[0] ?? null), owners: clone(owners), lots: clone(lots),
      board: isBoard() ? clone(boardMember()) : null,
    };
  }

  function addTask(t: Omit<BoardTask, 'id' | 'status' | 'created_at' | 'resolved_by' | 'resolved_at'>): BoardTask {
    const task: BoardTask = { ...t, id: newId('task'), status: 'open', created_at: nowISO(), resolved_by: null, resolved_at: null };
    state.tasks.push(task);
    return task;
  }

  function finishTasksFor(refId: string, by: string) {
    for (const t of state.tasks) {
      if (t.ref_id === refId && t.status === 'open') { t.status = 'done'; t.resolved_by = by; t.resolved_at = nowISO(); }
    }
  }

  function markAnswered(m: Message) {
    m.status = 'answered'; m.answered_at = nowISO(); m.assigned_to = PAT_USER;
    finishTasksFor(m.id, PAT_USER);
  }

  function confirmCheck(checkId: string, outcome: 'deposited' | 'returned'): CheckRecord {
    requireBoard();
    const check = state.checks.find((c) => c.id === checkId);
    if (!check) throw new Error('That check was not found.');
    if (check.state !== 'received') throw new Error('That check has already been confirmed.');
    // Two-person rule: the person who opened the mail cannot also confirm the deposit.
    if (check.logged_by === PAT_USER) {
      throw new Error('The person who logged this check cannot also confirm the deposit. Ask a second board member to confirm it.');
    }
    check.state = outcome;
    check.deposit_confirmed_by = PAT_USER;
    if (outcome === 'deposited') {
      // Settles the oldest open invoice the check covers (exact amount preferred), outside Stripe.
      const inv = state.invoices
        .filter((i) => i.lot_id === check.lot_id && i.status === 'open' && i.amount_cents <= check.amount_cents)
        .sort((x, y) => Number(y.amount_cents === check.amount_cents) - Number(x.amount_cents === check.amount_cents)
          || x.due_on.localeCompare(y.due_on) || x.number.localeCompare(y.number))[0];
      state.ledger.push({
        // dated the day the HOA received the check, not the day a second person confirmed it (mirrors confirm_check_deposit, 0005)
        id: newId('le'), lot_id: check.lot_id, posted_on: check.received_on, kind: 'payment',
        description: `Check #${check.check_number}`, detail: 'Deposit confirmed',
        amount_cents: -check.amount_cents, status: 'cleared', method: 'check', invoice_id: inv?.id ?? null,
        external_ref: `check:${check.id}`,
      });
      if (inv) { inv.status = 'paid'; inv.paid_outside_stripe = true; }
    } else {
      applyCheckReturn(check, null);
    }
    for (const t of state.tasks) {   // only the confirm task: a payment_returned task for the same check stays open
      if (t.kind === 'check_confirm' && t.ref_id === check.id && t.status === 'open') { t.status = 'done'; t.resolved_by = PAT_USER; t.resolved_at = nowISO(); }
    }
    return clone(check);
  }

  // A returned check (mirrors apply_check_return in 0004_gaps.sql): its payment row becomes returned so the
  // balance goes back up, the invoice it settled reopens, and a payment_returned task opens.
  function applyCheckReturn(check: CheckRecord, note: string | null) {
    const ref = `check:${check.id}`;
    const row = state.ledger.find((e) => e.external_ref === ref);
    let invoiceId: string | null = null;
    if (row) {
      row.status = 'returned'; row.detail = `Check #${check.check_number}, returned by the bank`;
      invoiceId = row.invoice_id;
    } else {
      state.ledger.push({
        id: newId('le'), lot_id: check.lot_id, posted_on: nowISO().slice(0, 10), kind: 'payment',
        description: `Check #${check.check_number}`, detail: 'Not on the deposit',
        amount_cents: -check.amount_cents, status: 'returned', method: 'check', invoice_id: null, external_ref: ref,
      });
    }
    const inv = invoiceId ? state.invoices.find((i) => i.id === invoiceId) : undefined;
    if (inv && inv.status === 'paid' && inv.paid_outside_stripe) { inv.status = 'open'; inv.paid_outside_stripe = false; }
    addTask({
      kind: 'payment_returned', lot_id: check.lot_id, title: `Check #${check.check_number} was returned`,
      summary: `The check for ${formatCents(check.amount_cents)} did not clear. The lot shows unpaid again. Contact the owner.${note?.trim() ? ` Note: ${note.trim()}` : ''}`,
      due_at: null, ref_id: check.id,
    });
  }

  // Approving a claim attaches the new sign-in to the EXISTING roster owner of the lot (mirrors resolve_claim_request, 0005):
  // one current owner: that one; several: the board names which; none at all: a new owner record. An owner already
  // linked to a different sign-in is refused. Throws before anything changes.
  function attachClaim(claim: ClaimRequest, ownerId?: string) {
    const current = state.lot_owners.filter((lo) => lo.lot_id === claim.lot_id && isCurrent(lo))
      .map((lo) => state.owners.find((o) => o.id === lo.owner_id)!).filter(Boolean);
    let owner: Owner | undefined;
    if (ownerId) {
      owner = current.find((o) => o.id === ownerId);
      if (!owner) throw new Error('That person is not a current owner of this lot.');
    } else if (current.length === 1) {
      owner = current[0];
    } else if (current.length > 1) {
      throw new Error('This lot has several owners. Choose which one this sign-in belongs to.');
    }
    if (owner) {
      if (owner.user_id && owner.user_id !== PAT_USER) throw new Error('That owner is already linked to another sign-in. Clear the link on the roster first.');
      owner.user_id = PAT_USER;
      return;
    }
    const lot = state.lots.find((l) => l.id === claim.lot_id)!;
    const created: Owner = {
      id: newId('own'), full_name: claim.email, first_name: '', email: claim.email, phone: null, mailing_address: lot.street_address,
      email_notice_consent: false, email_notice_consent_at: null, board_notice_request: false, user_id: PAT_USER, last_sign_in_at: nowISO(),
    };
    state.owners.push(created);
    state.lot_owners.push({ lot_id: claim.lot_id, owner_id: created.id, starts_on: today(), ends_on: null });
  }

  function useTemplate(messageId: string, templateId: string): Message {
    const m = state.messages.find((x) => x.id === messageId);
    if (!m) throw new Error('That message was not found.');
    const t = state.templates.find((x) => x.id === templateId);
    if (!t) throw new Error('That template was not found.');
    if (!t.approved_on) throw new Error('Only board-approved templates can be sent.');
    markAnswered(m);
    return clone(m);
  }

  // ---- the API ----
  return {
    async getSession() { await wait(); return session(); },

    async signInWithGoogle() {
      await wait();
      if (state.persona === 'signed_out') { state.persona = 'owner'; save(); }
    },

    async sendSignInLink(email: string) {
      await wait();
      void email; // the demo never says whether an address is on the roster
      if (state.persona === 'signed_out') { state.persona = 'owner'; save(); }
      return { sent: true as const };
    },

    async redeemClaimCode(code: string) {
      await wait();
      requireSignedIn();
      const clean = code.trim().toUpperCase();
      if (clean !== DEMO_CLAIM_CODE) return { ok: false, message: 'That code did not work. Check it and try again, or message the board.' };
      if (state.used_codes.includes(clean)) return { ok: false, message: 'That code has already been used. Message the board if you need a new one.' };
      state.used_codes.push(clean);
      const lot = state.lots.find((l) => l.lot_number === PAT_LOT_NUMBER)!;   // the sample letter is for Lot 42
      const claim: ClaimRequest = { id: newId('claim'), lot_id: lot.id, email: session()!.email, created_at: nowISO(), status: 'pending', user_id: PAT_USER, code: clean };
      state.claims.push(claim);
      addTask({ kind: 'claim_attach', lot_id: lot.id, title: `Confirm email for Lot ${lot.lot_number}`, summary: `${claim.email} used a claim code for Lot ${lot.lot_number}. Verify ownership against the county land records, then approve or reject.`, due_at: null, ref_id: claim.id });
      save();
      return { ok: true, message: 'Thank you. The board will confirm your email for this lot, usually within a few days.' };
    },

    async signOut() { await wait(); state.persona = 'signed_out'; save(); },

    async getOwnerHome(): Promise<OwnerHome> {
      await wait(); requireSignedIn();
      const lot = myLotOrNull();
      const next = state.events.filter((e) => e.starts_at >= nowISO()).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0] ?? null;
      const docs = state.documents.filter((d) => canSee(d.audience))
        .sort((a, b) => b.posted_on.localeCompare(a.posted_on)).slice(0, 3);
      const anns = state.announcements.filter((a) => canSee(a.audience)).sort((a, b) => b.posted_at.localeCompare(a.posted_at));
      // No linked home: the balance below means nothing and the screens do not show it (they show "not linked yet").
      const balance = lot ? balanceOf(lot.id) : summarizeBalance([], []);
      return clone({ session: session()!, balance, next_event: next, announcements: anns, new_documents: docs });
    },

    async getMyLedger() {
      await wait(); requireSignedIn();
      const lot = myLotOrNull();
      if (!lot) return { entries: [], invoices: [] };
      const entries = lotEntries(lot.id).sort((a, b) => b.posted_on.localeCompare(a.posted_on));
      const invoices = lotInvoices(lot.id).sort((a, b) => b.due_on.localeCompare(a.due_on));
      return clone({ entries, invoices });
    },

    async getPayLink(invoiceId: string) {
      await wait(); requireSignedIn();
      const inv = state.invoices.find((i) => i.id === invoiceId && i.lot_id === myLot().id);
      if (!inv) throw new Error('That invoice was not found.');
      if (inv.status === 'open') {
        // In the demo a pay link instantly starts a bank payment that is still processing.
        inv.status = 'processing';
        state.ledger.push({
          id: newId('le'), lot_id: inv.lot_id, posted_on: nowISO().slice(0, 10), kind: 'payment',
          description: 'Bank payment', detail: 'Ending 6789', amount_cents: -inv.amount_cents,
          status: 'processing', method: 'ach', invoice_id: inv.id, external_ref: null,
        });
        save();
      }
      return '#/paid?demo=1';
    },

    async listDocuments() {
      await wait();
      return clone(state.documents.filter((d) => canSee(d.audience)).sort((a, b) => b.posted_on.localeCompare(a.posted_on)));
    },

    async openDocument(id: string) {
      await wait();
      const d = state.documents.find((x) => x.id === id);
      if (!d || !canSee(d.audience)) throw new Error('That document was not found.');
      const text = `${d.title}\n\nThis is a sample document for the demo. In the real portal this opens the actual file through a short-lived private link.\n`;
      return `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
    },

    async listEvents() {
      await wait();
      return clone(state.events.filter((e) => signedIn() || e.is_public).sort((a, b) => a.starts_at.localeCompare(b.starts_at)));
    },

    async listPublicEvents() {
      await wait();
      return clone(state.events.filter((e) => e.is_public).sort((a, b) => a.starts_at.localeCompare(b.starts_at)));
    },
    async sendMessage(input: { topic: MessageTopic; body: string; lotId?: string }) {
      await wait(); requireSignedIn();
      const body = input.body.trim();
      if (!body) throw new Error('Please write a message first.');
      const first = myLot();
      // an optional lot must be one of my current lots; left out, the first one
      const lot = input.lotId ? myLots().find((l) => l.id === input.lotId) : first;
      if (!lot) throw new Error('You are not a current owner of that lot.');
      const ownerHere = myOwners().find((o) => state.lot_owners.some((lo) => lo.owner_id === o.id && lo.lot_id === lot.id && isCurrent(lo))) ?? me();
      // At most 10 messages per sign-in per hour and 30 per day (mirrors send_message in 0006_grok.sql).
      const mine = new Set(myOwners().map((o) => o.id));
      const nowMs = Date.parse(nowISO());
      const recent = (ms: number) => state.messages.filter((x) => x.channel === 'portal' && x.owner_id && mine.has(x.owner_id)
        && Date.parse(x.created_at) > nowMs - ms).length;
      if (recent(3_600_000) >= 10 || recent(86_400_000) >= 30) {
        throw new Error('You\'ve sent a lot of messages today. Please call or email the board.');
      }
      const m: Message = {
        id: newId('msg'), lot_id: lot.id, owner_id: ownerHere.id, topic: input.topic,
        subject: body.length > 60 ? `${body.slice(0, 57)}...` : body, body, status: 'acknowledged',
        created_at: nowISO(), answered_at: null,
        due_at: input.topic === 'records' ? addBusinessDays(nowISO(), 10) : null,
        gmail_thread_id: null, assigned_to: null, channel: 'portal',
      };
      state.messages.push(m);
      if (m.topic === 'records') {
        addTask({ kind: 'records_request', lot_id: lot.id, title: m.subject, summary: 'Virginia allows 10 business days to respond.', due_at: m.due_at, ref_id: m.id });
      }
      save();
      return clone(m);
    },

    async listMyMessages() {
      await wait(); requireSignedIn();
      return clone(state.messages.filter((m) => myOwners().some((o) => o.id === m.owner_id && hasCurrentLot(o.id))).sort((a, b) => b.created_at.localeCompare(a.created_at)));
    },

    async updateNoticePrefs(input) {
      await wait(); requireSignedIn();
      const o = me();
      if (input.email_notice_consent && !o.email_notice_consent) o.email_notice_consent_at = nowISO();
      if (!input.email_notice_consent) o.email_notice_consent_at = null;
      o.email_notice_consent = input.email_notice_consent;
      o.board_notice_request = input.board_notice_request;
      save();
      return clone(o);
    },

    // ---- Board ----
    async getBoardDashboard(): Promise<BoardDashboard> {
      await wait(); requireBoard();
      const weekAgo = new Date(new Date(nowISO()).getTime() - 7 * 86400000).toISOString();
      const week = state.messages.filter((m) => m.created_at >= weekAgo);
      // "Waiting" is every unresolved message, however old; received and answered are this week only.
      const waiting = state.messages.filter((m) => m.status !== 'answered' && m.status !== 'closed');
      const oldest = waiting.reduce((mx, m) => Math.max(mx, businessDaysBetween(m.created_at, nowISO())), 0);
      const paid = state.lots.filter((l) => { const s = balanceOf(l.id).state; return s === 'paid' || s === 'credit'; }).length;
      return clone({
        lots_total: state.lots.length, lots_paid: paid,
        owners_signed_in: state.owners.filter((o) => o.user_id).length,
        open_tasks: state.tasks.filter((t) => t.status === 'open'),
        messages_this_week: { received: week.length, answered: week.filter((m) => m.answered_at).length, waiting: waiting.length, oldest_waiting_business_days: oldest },
      });
    },

    async listTasks() {
      await wait(); requireBoard();
      const open = state.tasks.filter((t) => t.status === 'open');
      const closed = state.tasks.filter((t) => t.status !== 'open');
      return clone([...open, ...closed]);
    },

    async resolveTask(id, action, note, ownerId) {
      await wait(); requireBoard();
      const task = state.tasks.find((t) => t.id === id);
      if (!task) throw new Error('That task was not found.');
      if (task.status !== 'open') throw new Error('That task is already closed.');
      // Same rule as the database: these two close only by a decision, never by dismissal.
      if (action === 'dismiss' && (task.kind === 'check_confirm' || task.kind === 'claim_attach')) {
        throw new Error('This task cannot be dismissed. Approve or reject it.');
      }
      // Same rule as resolve_claim_request: nobody decides a claim made with their own sign-in (approve or reject).
      const ownClaim = task.kind === 'claim_attach' ? state.claims.find((c) => c.id === task.ref_id) : undefined;
      if (ownClaim?.user_id && ownClaim.user_id === boardMember()?.user_id) {
        throw new Error('You cannot decide a claim made with your own sign-in. Another board member must.');
      }
      if (action === 'dismiss') {
        task.status = 'dismissed';
      } else if (task.kind === 'check_confirm') {
        // approve = it is on the deposit; reject = not on the deposit. May throw (two-person rule).
        confirmCheck(task.ref_id!, action === 'approve' ? 'deposited' : 'returned');
        task.status = 'done';   // reject is still a decision
      } else if (action === 'reject') {
        task.status = task.kind === 'claim_attach' ? 'done' : 'dismissed';
        const claim = task.kind === 'claim_attach' ? state.claims.find((c) => c.id === task.ref_id) : null;
        if (claim) {
          claim.status = 'rejected';
          // rejecting gives the claim code back so the owner can try again; approving keeps it used
          if (claim.code) state.used_codes = state.used_codes.filter((c) => c !== claim.code);
        }
      } else {
        const m = state.messages.find((x) => x.id === task.ref_id);
        if (task.kind === 'template_reply' && m) useTemplate(m.id, task.template_id ?? 'tpl-meeting');
        else if ((task.kind === 'draft_approval' || task.kind === 'records_request') && m) markAnswered(m);
        if (task.kind === 'claim_attach') {
          const claim = state.claims.find((c) => c.id === task.ref_id);
          if (claim) { attachClaim(claim, ownerId); claim.status = 'approved'; }
        }
        task.status = 'done';
      }
      task.resolved_by = PAT_USER; task.resolved_at = nowISO();
      if (note) task.summary = `${task.summary} Note: ${note}`;
      save();
      return clone(task);
    },

    async listLots(query?: string): Promise<LotRow[]> {
      await wait(); requireBoard();
      const q = (query ?? '').trim().toLowerCase();
      const rows = state.lots.map((lot) => {
        const owners = ownersOf(lot.id);
        const b = balanceOf(lot.id);
        return { lot, owners, balance_cents: b.balance_cents, state: b.state };
      }).filter((r) => !q
        || String(r.lot.lot_number) === q || r.lot.street_address.toLowerCase().includes(q)
        || r.owners.some((o) => o.full_name.toLowerCase().includes(q) || (o.email ?? '').toLowerCase().includes(q)));
      return clone(rows);
    },

    async listInbox(filter) {
      await wait(); requireBoard();
      return clone(state.messages
        .filter((m) => (!filter?.status || m.status === filter.status) && (!filter?.topic || m.topic === filter.topic))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)));
    },

    async listTemplates(): Promise<ReplyTemplate[]> {
      await wait(); requireBoard();
      return clone(state.templates);
    },

    async replyWithTemplate(messageId, templateId) {
      await wait(); requireBoard();
      const m = useTemplate(messageId, templateId);
      save();
      return m;
    },

    async logCheck(input) {
      await wait(); requireBoard();
      if (!state.lots.some((l) => l.id === input.lot_id)) throw new Error('That lot was not found.');
      if (!(input.amount_cents > 0)) throw new Error('Enter the check amount.');
      const check: CheckRecord = {
        id: newId('chk'), lot_id: input.lot_id, check_number: input.check_number, amount_cents: input.amount_cents,
        received_on: input.received_on, logged_by: loggerUser, deposit_confirmed_by: null, state: 'received',
      };
      state.checks.push(check);
      const lot = state.lots.find((l) => l.id === input.lot_id)!;
      addTask({ kind: 'check_confirm', lot_id: lot.id, title: `Check #${check.check_number} for ${formatCents(check.amount_cents)}`, summary: `Logged by the secretary on ${check.received_on}. A second board member confirms it is on the bank deposit before Lot ${lot.lot_number} shows Paid.`, due_at: null, ref_id: check.id });
      save();
      return clone(check);
    },

    async confirmCheckDeposit(checkId, outcome) {
      await wait();
      const c = confirmCheck(checkId, outcome);
      save();
      return c;
    },

    async markCheckReturned(checkId, note) {
      await wait(); requireBoard();
      const check = state.checks.find((c) => c.id === checkId);
      if (!check) throw new Error('That check was not found.');
      if (check.state === 'returned') throw new Error('That check was already returned.');
      if (check.state !== 'deposited') throw new Error('That check has not been deposited yet. Mark it as not on the deposit instead.');
      check.state = 'returned';
      applyCheckReturn(check, note ?? null);
      save();
      return clone(check);
    },

    async previewBillRun(input): Promise<BillRunPreview> {
      await wait(); requireBoard();
      const yearInvoiceIds = new Set(state.invoices.filter((i) => i.number.startsWith(`${input.year}-`)).map((i) => i.id));
      const lots: BillRunPreview['lots'] = [];
      let email = 0; let paper = 0; let billed = 0; let processingTotal = 0; let creditOnly = 0;
      for (const lot of state.lots) {
        const owners = ownersOf(lot.id);
        // Email only when EVERY current owner has consented and has an address (mirrors deliveryFor in bill-run.ts):
        // one owner's consent must not take paper away from a co-owner who has not elected e-mail notice.
        const owner = owners.length > 0 && owners.every((o) => o.email_notice_consent && o.email && o.email.trim() !== '');
        // Carried = what the lot already owes, not counting this year's own run: its charge (even one with no invoice
        // behind it, a credit-only lot) and every payment, credit or refund linked to this year's invoices.
        const carriedEntries = lotEntries(lot.id).filter((e) => !((e.invoice_id && yearInvoiceIds.has(e.invoice_id)) || (e.external_ref ?? '').startsWith(`inv:${input.year}-`)));
        const carriedSummary = summarizeBalance(carriedEntries, []);
        const carried = carriedSummary.balance_cents;            // processing payments are NOT subtracted (as in lot_balances)
        const processing = carriedSummary.processing_cents;     // shown separately so the board can see it
        const delivery = owner ? 'email' : 'paper';
        // A credit bigger than the dues means no invoice, never a negative one (mirrors apply_bill_run / buildBillRun).
        const due = carried + input.amount_cents;
        const total = Math.max(0, due);
        const creditLeft = Math.max(0, -due);
        const noInvoice = due < 0;
        lots.push({
          lot_id: lot.id, lot_number: lot.lot_number, owner_name: owners.map((o) => o.full_name).join(' and '), carried_cents: carried,
          processing_cents: processing, total_cents: total, delivery, credit_left_cents: creditLeft, no_invoice: noInvoice,
        });
        if (delivery === 'email') email++; else paper++;
        if (noInvoice) creditOnly++;
        billed += total; processingTotal += processing;
      }
      return { year: input.year, due_on: input.due_on, amount_cents: input.amount_cents, lots, totals: { lots: lots.length, email, paper, billed_cents: billed, processing_cents: processingTotal, credit_only: creditOnly } };
    },

    async postAnnouncement(input): Promise<Announcement> {
      await wait(); requireBoard();
      const a: Announcement = { id: newId('ann'), title: input.title, body: input.body, audience: input.audience, posted_at: nowISO() };
      state.announcements.push(a); save();
      return clone(a);
    },

    async addDocument(input: { folder: DocumentFolder; title: string; audience: Audience; file: File | null; is_draft: boolean }): Promise<DocumentItem> {
      await wait(); requireBoard();
      if (input.folder === 'board_packets' && input.audience !== 'board') throw new Error('Board packets are for the board only.');   // same rule as the database
      const id = newId('doc');
      const d: DocumentItem = { id, folder: input.folder, title: input.title, audience: input.audience, is_draft: input.is_draft, posted_on: nowISO().slice(0, 10), storage_path: `demo/${input.folder}/${id}.pdf` };
      state.documents.push(d); save();
      return clone(d);
    },

    async addEvent(input: { title: string; kind: EventKind; starts_at: string; location: string | null; video_url: string | null; is_public: boolean }): Promise<HoaEvent> {
      await wait(); requireBoard();
      const e: HoaEvent = { id: newId('ev'), notes: null, ...input };
      state.events.push(e); save();
      return clone(e);
    },

    async listClaimRequests() {
      await wait(); requireBoard();
      return clone(state.claims.map(({ code: _code, ...c }) => c));
    },
  };
}
