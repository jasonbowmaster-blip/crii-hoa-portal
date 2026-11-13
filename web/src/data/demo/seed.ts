// Sample data for the in-browser demo. Everything here is made up: fake streets,
// example.com emails, invented names. The demo clock is frozen at DEMO_NOW so the
// screens always read the same way ("next board meeting Tue Jan 19").
import { config } from '../../config';
import { addBusinessDays } from '../../lib/ledger';
import type {
  Announcement, BoardMember, BoardTask, CheckRecord, ClaimRequest, DocumentItem, HoaEvent,
  Invoice, LedgerEntry, Lot, LotOwner, Message, Owner, ReplyTemplate,
} from '../types';

// 'unlinked' = signed in, but the sign-in does not match any home yet (the claim-code case)
export type Persona = 'owner' | 'board' | 'signed_out' | 'unlinked';

export const DEMO_NOW = '2027-01-13T15:00:00Z'; // a Wednesday
export const PAT_USER = 'user-pat';
export const SAM_USER = 'user-sam'; // "Sam (secretary)", the second person for the two-person rule
export const PAT_LOT_NUMBER = 42;
export const DEMO_CLAIM_CODE = 'DEMO-CODE-0042-XYZ';
export const ASSESSMENT_2027 = 17500;
export const ASSESSMENT_2026 = 17000;

export interface DemoState {
  persona: Persona;
  seq: number; // counter for new ids
  lots: Lot[];
  owners: Owner[];
  lot_owners: LotOwner[];
  board: BoardMember[];
  invoices: Invoice[];
  ledger: LedgerEntry[];
  checks: CheckRecord[];
  messages: Message[];
  documents: DocumentItem[];
  events: HoaEvent[];
  announcements: Announcement[];
  tasks: BoardTask[];
  templates: ReplyTemplate[];
  claims: ClaimRequest[];
  used_codes: string[];
}

const pad = (n: number, w = 3) => String(n).padStart(w, '0');
const lotId = (n: number) => `lot-${pad(n)}`;
const ownerId = (n: number) => `owner-${pad(n)}`;
const invNumber = (n: number) => `2027-${pad(n)}`;

const STREETS = ['Sample Lane', 'Example Court', 'Placeholder Drive', 'Test Terrace', 'Demo Way', 'Model Circle'];
const FIRST = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Drew', 'Avery', 'Quinn', 'Robin', 'Dana', 'Lee', 'Skyler', 'Reese'];
const LAST = ['Sample', 'Demo', 'Placeholder', 'Testington', 'Mockley', 'Fakerton', 'Exemplar', 'Pretend', 'Dummer', 'Stub'];

// Lots with a role in the mock-ups. They are never in the random "paid" group.
const SPECIAL = new Set([42, 7, 23, 88, 5, 61]);

function buildLotsAndOwners() {
  const lots: Lot[] = [];
  const owners: Owner[] = [];
  const lot_owners: LotOwner[] = [];
  for (let n = 1; n <= 150; n++) {
    const isPat = n === PAT_LOT_NUMBER;
    const first = isPat ? 'Pat' : FIRST[n % FIRST.length];
    const last = isPat ? 'Example' : LAST[Math.floor(n / FIRST.length) % LAST.length];
    const street = STREETS[n % STREETS.length];
    const address = isPat ? '118 Sample Lane' : `${100 + ((n * 7) % 90)} ${street}`;
    const hasEmail = isPat || n % 11 !== 0;
    const consent = isPat ? false : hasEmail && n % 2 === 0;
    const signedIn = isPat || (n * 7) % 150 < 60; // 60 others + Pat = 61 owners signed in
    lots.push({ id: lotId(n), lot_number: n, street_address: address, status: 'active' });
    owners.push({
      id: ownerId(n),
      full_name: `${first} ${last}`,
      first_name: first,
      email: hasEmail ? (isPat ? 'pat.example@example.com' : `${first}.${last}${n}@example.com`.toLowerCase()) : null,
      phone: null,
      mailing_address: `${address}, Sampleville, VA 20000`,
      email_notice_consent: consent,
      email_notice_consent_at: consent ? '2026-03-01T14:00:00Z' : null,
      board_notice_request: false,
      user_id: isPat ? PAT_USER : signedIn ? `user-owner-${pad(n)}` : null,
      last_sign_in_at: signedIn ? '2027-01-05T13:00:00Z' : null,
    });
    lot_owners.push({ lot_id: lotId(n), owner_id: ownerId(n), starts_on: '2019-06-01', ends_on: null });
  }
  return { lots, owners, lot_owners };
}

function buildBilling() {
  const invoices: Invoice[] = [];
  const ledger: LedgerEntry[] = [];
  const checks: CheckRecord[] = [];

  // 96 of the other 144 lots have paid (this is the "96 of 150" on the board view).
  const candidates = [...Array(150).keys()].map((i) => i + 1).filter((n) => !SPECIAL.has(n));
  candidates.sort((a, b) => ((a * 37) % 151) - ((b * 37) % 151));
  const paid = new Set(candidates.slice(0, 96));

  for (let n = 1; n <= 150; n++) {
    const id = lotId(n);
    const invId = `inv-${invNumber(n)}`;
    const isPaid = paid.has(n);
    const processing = n === 7;
    invoices.push({
      id: invId, lot_id: id, number: invNumber(n), description: '2027 annual assessment',
      amount_cents: ASSESSMENT_2027, issued_on: '2027-01-01', due_on: '2027-05-15',
      status: isPaid ? 'paid' : processing ? 'processing' : 'open',
      stripe_invoice_id: null, hosted_invoice_url: null, paid_outside_stripe: false,
    });

    if (n === PAT_LOT_NUMBER) {
      // Pat's 2026 history: charge, a bank payment the bank returned, then check #881.
      invoices.push({
        id: 'inv-2026-042', lot_id: id, number: '2026-042', description: '2026 annual assessment',
        amount_cents: ASSESSMENT_2026, issued_on: '2026-02-14', due_on: '2026-05-15',
        status: 'paid', stripe_invoice_id: null, hosted_invoice_url: null, paid_outside_stripe: true,
      });
      ledger.push(
        { id: 'le-042-2026-charge', lot_id: id, posted_on: '2026-02-14', kind: 'charge', description: '2026 annual assessment', detail: 'Invoice 2026-042, due May 15', amount_cents: ASSESSMENT_2026, status: 'cleared', method: null, invoice_id: 'inv-2026-042', external_ref: null },
        { id: 'le-042-2026-ach', lot_id: id, posted_on: '2026-02-20', kind: 'payment', description: 'Bank payment', detail: 'Returned by the bank', amount_cents: -ASSESSMENT_2026, status: 'returned', method: 'ach', invoice_id: 'inv-2026-042', external_ref: null },
        { id: 'le-042-2026-check', lot_id: id, posted_on: '2026-03-02', kind: 'payment', description: 'Check #881', detail: 'Deposit confirmed', amount_cents: -ASSESSMENT_2026, status: 'cleared', method: 'check', invoice_id: 'inv-2026-042', external_ref: '881' },
        { id: 'le-042-open', lot_id: id, posted_on: '2027-01-01', kind: 'opening_balance', description: 'Carried from before Jan 1', detail: 'From the old system’s records', amount_cents: 2500, status: 'cleared', method: null, invoice_id: null, external_ref: null },
      );
      checks.push({ id: 'chk-881', lot_id: id, check_number: '881', amount_cents: ASSESSMENT_2026, received_on: '2026-02-27', logged_by: SAM_USER, deposit_confirmed_by: PAT_USER, state: 'deposited' });
    }

    ledger.push({
      id: `le-${pad(n)}-2027-charge`, lot_id: id, posted_on: '2027-01-01', kind: 'charge',
      description: '2027 annual assessment', detail: `Invoice ${invNumber(n)}, due May 15`,
      amount_cents: ASSESSMENT_2027, status: 'cleared', method: null, invoice_id: invId, external_ref: null,
    });
    if (isPaid || processing) {
      ledger.push({
        id: `le-${pad(n)}-2027-pay`, lot_id: id, posted_on: processing ? '2027-01-11' : `2027-01-${pad(2 + (n % 9), 2)}`,
        kind: 'payment', description: n % 3 === 0 ? 'Card payment' : 'Bank payment',
        detail: `Ending ${pad(1000 + ((n * 37) % 9000), 4)}`, amount_cents: -ASSESSMENT_2027,
        status: processing ? 'processing' : 'cleared', method: n % 3 === 0 ? 'card' : 'ach',
        invoice_id: invId, external_ref: null,
      });
    }
  }

  // Check #1042 for lot 23: logged by the secretary, waiting for a second person.
  checks.push({ id: 'chk-1042', lot_id: lotId(23), check_number: '1042', amount_cents: ASSESSMENT_2027, received_on: '2027-01-11', logged_by: SAM_USER, deposit_confirmed_by: null, state: 'received' });
  return { invoices, ledger, checks };
}

function msg(over: Partial<Message> & Pick<Message, 'id' | 'lot_id' | 'topic' | 'subject' | 'body' | 'status' | 'created_at'>): Message {
  const n = over.lot_id ? Number(over.lot_id.slice(4)) : 0;
  return {
    owner_id: over.lot_id ? ownerId(n) : null, answered_at: null, due_at: null,
    gmail_thread_id: null, assigned_to: null, channel: 'portal', ...over,
  };
}

function buildMessages(): Message[] {
  const out: Message[] = [
    msg({ id: 'msg-pat-1', lot_id: lotId(42), topic: 'question', subject: 'Where do I find the fence rules?', body: 'Where do I find the fence rules?', status: 'answered', created_at: '2026-12-02T16:00:00Z', answered_at: '2026-12-03T14:00:00Z', assigned_to: SAM_USER }),
    // Four waiting this week, matching the board mock-up.
    msg({ id: 'msg-61', lot_id: lotId(61), topic: 'question', subject: 'When is the next board meeting?', body: 'When is the next board meeting?', status: 'new', created_at: '2027-01-12T21:00:00Z' }),
    msg({ id: 'msg-88', lot_id: lotId(88), topic: 'billing', subject: 'Asks to split dues into two payments', body: 'Could we pay our dues in two payments this year?', status: 'draft_waiting', created_at: '2027-01-12T18:00:00Z' }),
    msg({ id: 'msg-5', lot_id: lotId(5), topic: 'records', subject: 'Wants last year’s bank statements', body: 'I would like to see last year’s bank statements.', status: 'acknowledged', created_at: '2027-01-11T15:00:00Z', due_at: addBusinessDays('2027-01-11T15:00:00Z', 10) }),
    msg({ id: 'msg-110', lot_id: lotId(110), topic: 'maintenance', subject: 'Light out by the mailboxes', body: 'The light by the mailboxes has been out for a week.', status: 'acknowledged', created_at: '2027-01-12T14:00:00Z' }),
  ];
  // 14 answered this week (the mock-up says 11 of them with approved templates).
  for (let i = 0; i < 14; i++) {
    const day = 7 + (i % 6); // Jan 7 .. Jan 12
    const lot = 10 + i * 9;
    out.push(msg({
      id: `msg-done-${i + 1}`, lot_id: lotId(lot), topic: i % 3 === 0 ? 'question' : 'other',
      subject: i % 3 === 0 ? 'Question about trash pickup' : 'Quick question',
      body: 'Sample message from an owner.', status: 'answered',
      created_at: `2027-01-${pad(day, 2)}T15:00:00Z`, answered_at: `2027-01-${pad(day, 2)}T20:00:00Z`, assigned_to: i % 2 ? SAM_USER : PAT_USER,
    }));
  }
  return out;
}

const SAMPLE_DOCS: [DocumentItem['folder'], string, DocumentItem['audience'], string, boolean][] = [
  ['governing', 'Declaration of covenants', 'owners', '2019-06-01', false],
  ['governing', 'Bylaws', 'owners', '2019-06-01', false],
  ['governing', 'Articles of incorporation', 'public', '2019-06-01', false],
  ['rules_arb', 'Rules and regulations', 'owners', '2026-04-10', false],
  ['rules_arb', 'ARB guidelines', 'owners', '2026-04-10', false],
  ['minutes', 'Board meeting minutes, November 2026', 'owners', '2026-12-08', false],
  ['minutes', 'Board meeting minutes, December 2026 (draft)', 'owners', '2027-01-06', true],
  ['minutes', 'Annual meeting minutes, 2026', 'owners', '2026-04-02', false],
  ['board_packets', 'Annual meeting packet, 2026', 'owners', '2026-03-10', false],
  ['board_packets', 'Board packet, January 2027 (board only)', 'board', '2027-01-12', false],
  ['budgets', '2027 budget', 'owners', '2026-11-20', false],
  ['budgets', '2026 year-end financial summary', 'owners', '2027-01-08', false],
  ['forms', 'Architectural review request form', 'public', '2026-04-10', false],
  ['forms', 'Records request form', 'public', '2026-04-10', false],
];

function buildDocuments(): DocumentItem[] {
  return SAMPLE_DOCS.map(([folder, title, audience, posted_on, is_draft], i) => ({
    id: `doc-${pad(i + 1)}`, folder, title, audience, posted_on, is_draft,
    storage_path: `demo/${folder}/${pad(i + 1)}.pdf`,
  }));
}

function buildEvents(): HoaEvent[] {
  return [
    { id: 'ev-board-jan', title: 'Board meeting', kind: 'board_meeting', starts_at: '2027-01-20T00:00:00Z', location: '[Meeting place]', video_url: 'https://example.com/demo-meeting', notes: 'Tuesday, January 19, 7:00 PM. Owners are welcome.', is_public: true },
    { id: 'ev-tree', title: 'Tree work along Sample Lane', kind: 'tree_work', starts_at: '2027-01-26T13:00:00Z', location: 'Sample Lane', video_url: null, notes: 'Crews will trim trees along the common area. Please move cars off the street by 8:00 AM.', is_public: true },
    { id: 'ev-board-feb', title: 'Board meeting', kind: 'board_meeting', starts_at: '2027-02-17T00:00:00Z', location: '[Meeting place]', video_url: 'https://example.com/demo-meeting', notes: null, is_public: true },
    { id: 'ev-annual', title: 'Annual meeting', kind: 'annual_meeting', starts_at: '2027-03-16T23:00:00Z', location: 'Community center', video_url: null, notes: 'Election of directors and the 2027 budget report.', is_public: true },
    { id: 'ev-dues', title: '2027 annual assessment due', kind: 'dues_date', starts_at: '2027-05-15T04:00:00Z', location: null, video_url: null, notes: null, is_public: true },
  ];
}

function buildTemplates(): ReplyTemplate[] {
  const approved_on = '2026-12-15';
  return [
    { id: 'tpl-meeting', name: 'Meeting times', version: 1, approved_on, body: `Thank you for asking. The next board meeting is Tuesday, January 19, 2027 at 7:00 PM. The date, place and video link are on the Calendar page. Owners are welcome. Board of ${config.hoaName}` },
    { id: 'tpl-pay', name: 'How to pay', version: 1, approved_on, body: `You can pay on the My bill page by bank payment or card, or mail a check to the address on your invoice. A payment that is still processing counts once it clears. Questions: ${config.boardEmail}` },
    { id: 'tpl-doc', name: 'Document link', version: 1, approved_on, body: 'The document you asked about is on the Documents page. Choose its folder and open it from the list. Tell us if you cannot find it.' },
    { id: 'tpl-ack', name: 'We got your message', version: 1, approved_on, body: `We got your message. A board member will reply within a few business days. For urgent safety problems please call ${config.phone}.` },
  ];
}

function buildTasks(): BoardTask[] {
  const t = (x: Partial<BoardTask> & Pick<BoardTask, 'id' | 'kind' | 'lot_id' | 'title' | 'summary' | 'created_at' | 'ref_id'>): BoardTask =>
    ({ status: 'open', due_at: null, resolved_by: null, resolved_at: null, ...x });
  return [
    t({ id: 'task-chk', kind: 'check_confirm', lot_id: lotId(23), title: 'Check #1042 for $175.00', summary: 'Logged by the secretary on Jan 11. A second board member confirms it is on the bank deposit before Lot 23 shows Paid.', created_at: '2027-01-11T16:00:00Z', ref_id: 'chk-1042' }),
    t({ id: 'task-q61', kind: 'template_reply', lot_id: lotId(61), title: 'When is the next board meeting?', summary: 'Suggested template: Meeting times. Fills in the next date and link from the calendar.', created_at: '2027-01-12T21:00:00Z', ref_id: 'msg-61' }),
    t({ id: 'task-b88', kind: 'draft_approval', lot_id: lotId(88), title: 'Asks to split dues into two payments', summary: 'Draft reply offers the board-approved two-payment option.', created_at: '2027-01-12T18:05:00Z', ref_id: 'msg-88' }),
    t({ id: 'task-r5', kind: 'records_request', lot_id: lotId(5), title: 'Wants last year’s bank statements', summary: 'Virginia allows 10 business days. Draft lists what we will share and the copy fee schedule.', created_at: '2027-01-11T15:05:00Z', ref_id: 'msg-5', due_at: addBusinessDays('2027-01-11T15:00:00Z', 10) }),
  ];
}

export function createSeed(persona: Persona = 'signed_out'): DemoState {
  const { lots, owners, lot_owners } = buildLotsAndOwners();
  const { invoices, ledger, checks } = buildBilling();
  return {
    persona, seq: 1, lots, owners, lot_owners,
    board: [
      { user_id: PAT_USER, owner_id: ownerId(PAT_LOT_NUMBER), role: 'treasurer', is_admin: true, term_ends_on: '2027-03-16', active: true },
      { user_id: SAM_USER, owner_id: null, role: 'secretary', is_admin: false, term_ends_on: '2027-03-16', active: true },
    ],
    invoices, ledger, checks,
    messages: buildMessages(),
    documents: buildDocuments(),
    events: buildEvents(),
    announcements: [
      { id: 'ann-tree', title: 'Tree work on Sample Lane, January 26', body: 'Crews will trim trees along the common area on Tuesday, January 26 starting at 8:00 AM. Please move cars off the street that morning.', posted_at: '2027-01-08T14:00:00Z', audience: 'owners' },
      { id: 'ann-annual', title: 'Annual meeting set for March 16', body: 'The annual meeting is Tuesday, March 16 at 7:00 PM. A formal notice will follow.', posted_at: '2026-12-10T14:00:00Z', audience: 'owners' },
    ],
    tasks: buildTasks(),
    templates: buildTemplates(),
    claims: [],
    used_codes: [],
  };
}
