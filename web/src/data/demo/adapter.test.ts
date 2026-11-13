import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addBusinessDays, businessDaysBetween } from '../../lib/ledger';
import { DEMO_CLAIM_CODE, DEMO_NOW, createDemoApi, demoReset, demoSwitchPersona } from './adapter';
import { FOLDER_LABELS } from '../types';
import { PAT_USER, createSeed } from './seed';

const make = (persona: 'owner' | 'board' | 'signed_out' | 'unlinked' = 'owner', extra = {}) =>
  createDemoApi({ persona, latencyMs: 0, ...extra });

beforeEach(() => { window.localStorage.clear(); });

describe('sign in', () => {
  it('is signed out until sign-in, then Pat on lot 42', async () => {
    const api = make('signed_out');
    expect(await api.getSession()).toBeNull();
    await api.signInWithGoogle();
    const s = (await api.getSession())!;
    expect(s.owner?.first_name).toBe('Pat');
    expect(s.lot?.lot_number).toBe(42);
    expect(s.lot?.street_address).toBe('118 Sample Lane');
    expect(s.board).toBeNull();
  });
  it('magic link also signs in and never reveals the roster', async () => {
    const api = make('signed_out');
    expect(await api.sendSignInLink('nobody@example.com')).toEqual({ sent: true });
    expect(await api.getSession()).not.toBeNull();
  });
  it('board persona has the treasurer seat; owner persona does not', async () => {
    expect((await make('board').getSession())!.board?.role).toBe('treasurer');
    expect((await make('owner').getSession())!.board).toBeNull();
  });
});

describe('balances and pay', () => {
  it('Pat owes the carried 2,500 plus the 2027 charge', async () => {
    const home = await make().getOwnerHome();
    expect(home.balance.balance_cents).toBe(20000);
    expect(home.balance.state).toBe('unpaid');
    expect(home.balance.next_due_on).toBe('2027-05-15');
    expect(home.next_event?.starts_at).toBe('2027-01-20T00:00:00Z');
  });
  it('ledger history has the returned payment and check #881', async () => {
    const { entries } = await make().getMyLedger();
    expect(entries.some((e) => e.status === 'returned' && e.posted_on.startsWith('2026'))).toBe(true);
    const chk = entries.find((e) => e.external_ref === '881')!;
    expect(chk.status).toBe('cleared');
    expect(chk.method).toBe('check');
  });
  it('getPayLink returns the demo page and records a processing payment that is not yet counted', async () => {
    const api = make();
    const { invoices } = await api.getMyLedger();
    const open = invoices.find((i) => i.status === 'open')!;
    expect(await api.getPayLink(open.id)).toBe('#/paid?demo=1');
    await api.getPayLink(open.id); // second click must not double up
    const { entries } = await api.getMyLedger();
    const processing = entries.filter((e) => e.status === 'processing');
    expect(processing).toHaveLength(1);
    expect(processing[0].method).toBe('ach');
    const home = await api.getOwnerHome();
    expect(home.balance.balance_cents).toBe(20000);
    expect(home.balance.processing_cents).toBe(17500);
  });
});

describe('messages', () => {
  it('acknowledges a message', async () => {
    const m = await make().sendMessage({ topic: 'question', body: 'Hello board' });
    expect(m.status).toBe('acknowledged');
    expect(m.due_at).toBeNull();
  });
  it('a records request gets a 10 business day clock and a board task', async () => {
    const api = make('board');
    const m = await api.sendMessage({ topic: 'records', body: 'Please send the minutes.' });
    expect(m.due_at).toBe(addBusinessDays(DEMO_NOW, 10));
    expect((await api.listTasks()).some((t) => t.ref_id === m.id && t.kind === 'records_request')).toBe(true);
  });
});

describe('documents', () => {
  it('has every folder and hides board documents from owners', async () => {
    const owner = await make('owner').listDocuments();
    const board = await make('board').listDocuments();
    // board packets are board-only (database rule), so owners see every folder except that one
    for (const folder of Object.keys(FOLDER_LABELS)) expect(owner.some((d) => d.folder === folder)).toBe(folder !== 'board_packets');
    for (const folder of Object.keys(FOLDER_LABELS)) expect(board.some((d) => d.folder === folder)).toBe(true);
    expect(owner.some((d) => d.audience === 'board')).toBe(false);
    expect(board.some((d) => d.audience === 'board')).toBe(true);
  });
  it('owners cannot open a board document; open returns a data URL', async () => {
    const api = make('owner');
    const boardDoc = (await make('board').listDocuments()).find((d) => d.audience === 'board')!;
    await expect(api.openDocument(boardDoc.id)).rejects.toThrow();
    const pub = (await api.listDocuments())[0];
    expect(await api.openDocument(pub.id)).toMatch(/^data:/);
  });
  it('signed-out visitors see only public documents', async () => {
    const docs = await make('signed_out').listDocuments();
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((d) => d.audience === 'public')).toBe(true);
  });
});

describe('board access', () => {
  it('refuses board calls for owners', async () => {
    const api = make('owner');
    await expect(api.getBoardDashboard()).rejects.toThrow(/board/i);
    await expect(api.listTasks()).rejects.toThrow();
    await expect(api.listTemplates()).rejects.toThrow();
  });
  it('dashboard matches the mock-up numbers', async () => {
    const d = await make('board').getBoardDashboard();
    expect(d.lots_total).toBe(150);
    expect(d.lots_paid).toBe(96);
    expect(d.owners_signed_in).toBe(61);
    expect(d.open_tasks).toHaveLength(4);
    expect(d.messages_this_week).toMatchObject({ received: 18, answered: 14, waiting: 4 });
  });
  it('counts every unresolved message as waiting, not only this week\'s', async () => {
    const d = await make('board', { now: '2027-03-01T15:00:00Z' }).getBoardDashboard();
    expect(d.messages_this_week.received).toBe(0);
    expect(d.messages_this_week.waiting).toBeGreaterThanOrEqual(4);
  });
  it('public events work signed out and expose only public events', async () => {
    const ev = await make('signed_out').listPublicEvents();
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => e.is_public)).toBe(true);
  });
  it('has the four mock-up tasks and four approved templates', async () => {
    const api = make('board');
    const tasks = await api.listTasks();
    expect(tasks.map((t) => t.lot_id)).toEqual(['lot-023', 'lot-061', 'lot-088', 'lot-005']);
    const rec = tasks.find((t) => t.kind === 'records_request')!;
    expect(businessDaysBetween(DEMO_NOW, rec.due_at!)).toBe(8);
    const tpls = await api.listTemplates();
    expect(tpls.map((t) => t.name)).toEqual(['Meeting times', 'How to pay', 'Document link', 'We got your message']);
    expect(tpls.every((t) => t.approved_on)).toBe(true);
  });
  it('lists 150 lots and searches them', async () => {
    const api = make('board');
    expect(await api.listLots()).toHaveLength(150);
    const found = await api.listLots('118 Sample');
    expect(found.some((r) => r.lot.lot_number === 42)).toBe(true);
  });
  it('template reply marks the message answered', async () => {
    const api = make('board');
    const m = await api.replyWithTemplate('msg-61', 'tpl-meeting');
    expect(m.status).toBe('answered');
    expect((await api.listTasks()).find((t) => t.id === 'task-q61')!.status).toBe('done');
  });
});

describe('checks and the two-person rule', () => {
  it('the treasurer confirming check #1042 marks lot 23 paid', async () => {
    const api = make('board');
    const before = (await api.listLots('23')).find((r) => r.lot.lot_number === 23)!;
    expect(before.state).toBe('unpaid');
    const task = await api.resolveTask('task-chk', 'approve');
    expect(task.status).toBe('done');
    const after = (await api.listLots('23')).find((r) => r.lot.lot_number === 23)!;
    expect(after.state).toBe('paid');
    expect(after.balance_cents).toBe(0);
  });
  it('logCheck records a different person, so the treasurer can confirm', async () => {
    const api = make('board');
    const c = await api.logCheck({ lot_id: 'lot-042', check_number: '2001', amount_cents: 20000, received_on: '2027-01-13' });
    expect(c.logged_by).not.toBe((await api.getSession())!.user_id);
    const done = await api.confirmCheckDeposit(c.id, 'deposited');
    expect(done.state).toBe('deposited');
    expect((await api.getOwnerHome()).balance.state).toBe('paid');
  });
  it('refuses when the confirming user is the one who logged it', async () => {
    const api = make('board', { checkLoggerUserId: 'user-pat' });
    const c = await api.logCheck({ lot_id: 'lot-042', check_number: '2002', amount_cents: 100, received_on: '2027-01-13' });
    await expect(api.confirmCheckDeposit(c.id, 'deposited')).rejects.toThrow(/cannot also confirm/);
    const task = (await api.listTasks()).find((t) => t.ref_id === c.id)!;
    await expect(api.resolveTask(task.id, 'approve')).rejects.toThrow(/cannot also confirm/);
    expect((await api.listTasks()).find((t) => t.id === task.id)!.status).toBe('open');
  });
});

describe('dismiss and returned checks (same rules as 0004_gaps.sql)', () => {
  it('dismiss cannot close a check_confirm or a claim_attach task, but can close others', async () => {
    const api = make('board');
    await expect(api.resolveTask('task-chk', 'dismiss')).rejects.toThrow(/cannot be dismissed/);
    expect((await api.listTasks()).find((t) => t.id === 'task-chk')!.status).toBe('open');
    expect((await api.resolveTask('task-q61', 'dismiss')).status).toBe('dismissed');
    // a claim task
    const owner = make('owner');
    await owner.redeemClaimCode(DEMO_CLAIM_CODE);
    const claimTask = (await make('board').listTasks()).find((t) => t.kind === 'claim_attach')!;
    await expect(make('board').resolveTask(claimTask.id, 'dismiss')).rejects.toThrow(/cannot be dismissed/);
    expect((await make('board').listClaimRequests())[0].status).toBe('pending');
  });
  it('a check marked not on the deposit leaves a returned row and a payment_returned task, balance unchanged', async () => {
    const api = make('board');
    const before = (await api.listLots('23')).find((r) => r.lot.lot_number === 23)!.balance_cents;
    const t = await api.resolveTask('task-chk', 'reject');
    expect(t.status).toBe('done');
    const after = (await api.listLots('23')).find((r) => r.lot.lot_number === 23)!;
    expect(after.balance_cents).toBe(before);
    expect((await api.listTasks()).some((x) => x.kind === 'payment_returned' && x.ref_id === 'chk-1042' && x.status === 'open')).toBe(true);
  });
  it('a deposited check that bounces: balance back up, invoice reopens, task opens', async () => {
    const api = make('board');
    await api.resolveTask('task-chk', 'approve');
    const paid = (await api.listLots('23')).find((r) => r.lot.lot_number === 23)!;
    expect(paid.state).toBe('paid');
    await expect(api.markCheckReturned('chk-nope')).rejects.toThrow(/not found/);
    const c = await api.markCheckReturned('chk-1042', 'NSF');
    expect(c.state).toBe('returned');
    const row = (await api.listLots('23')).find((r) => r.lot.lot_number === 23)!;
    expect(row.state).toBe('unpaid');
    expect(row.balance_cents).toBe(17500);
    const task = (await api.listTasks()).find((x) => x.kind === 'payment_returned' && x.ref_id === 'chk-1042')!;
    expect(task.status).toBe('open');
    expect(task.summary).toContain('NSF');
    await expect(api.markCheckReturned('chk-1042')).rejects.toThrow(/already returned/);
  });
  it('a bounced check reopens the invoice it settled', async () => {
    const api = make('board');
    const c = await api.logCheck({ lot_id: 'lot-042', check_number: '3001', amount_cents: 20000, received_on: '2027-01-13' });
    await api.confirmCheckDeposit(c.id, 'deposited');
    expect((await api.getMyLedger()).invoices.some((i) => i.status === 'open')).toBe(false);
    await api.markCheckReturned(c.id);
    const { invoices, entries } = await api.getMyLedger();
    expect(invoices.filter((i) => i.status === 'open')).toHaveLength(1);
    expect(entries.find((e) => e.external_ref === `check:${c.id}`)!.status).toBe('returned');
    expect((await api.getOwnerHome()).balance.state).toBe('unpaid');
  });
  it('a check that was never deposited cannot be marked returned this way', async () => {
    await expect(make('board').markCheckReturned('chk-1042')).rejects.toThrow(/not been deposited/);
  });
  it('owners cannot mark a check returned', async () => {
    await expect(make('owner').markCheckReturned('chk-881')).rejects.toThrow(/board members only/);
  });
});

describe('claim codes', () => {
  it('accepts the sample code once, creating a claim and a task', async () => {
    const api = make('board');
    expect((await api.redeemClaimCode('demo-code-0042-xyz')).ok).toBe(true);
    const claims = await api.listClaimRequests();
    expect(claims).toHaveLength(1);
    expect(claims[0].status).toBe('pending');
    expect((await api.listTasks()).some((t) => t.kind === 'claim_attach')).toBe(true);
    expect((await api.redeemClaimCode(DEMO_CLAIM_CODE)).ok).toBe(false);
  });
  it('rejects unknown codes and needs sign-in', async () => {
    expect((await make().redeemClaimCode('NOPE')).ok).toBe(false);
    await expect(make('signed_out').redeemClaimCode(DEMO_CLAIM_CODE)).rejects.toThrow();
  });
});

describe('bill run preview', () => {
  it('includes carried balances and email only with consent', async () => {
    const api = make('board');
    const p = await api.previewBillRun({ year: 2027, amount_cents: 17500, due_on: '2027-05-15' });
    expect(p.lots).toHaveLength(150);
    const pat = p.lots.find((l) => l.lot_number === 42)!;
    expect(pat.carried_cents).toBe(2500);
    expect(pat.total_cents).toBe(20000);
    expect(pat.delivery).toBe('paper'); // Pat has not elected email notice
    const other = p.lots.find((l) => l.lot_number === 1)!;
    expect(other.carried_cents).toBe(0);
    expect(p.totals.email + p.totals.paper).toBe(150);
    expect(p.totals.billed_cents).toBe(p.lots.reduce((s, l) => s + l.total_cents, 0));
    const owners = await api.listLots();
    const emailLots = p.lots.filter((l) => l.delivery === 'email').map((l) => l.lot_id);
    for (const r of owners) {
      const o = r.owners[0];
      expect(emailLots.includes(r.lot.id)).toBe(!!(o.email_notice_consent && o.email));
    }
  });
  it('turning on email notice changes Pat to email', async () => {
    const api = make('board');
    await api.updateNoticePrefs({ email_notice_consent: true, board_notice_request: false });
    const p = await api.previewBillRun({ year: 2027, amount_cents: 17500, due_on: '2027-05-15' });
    expect(p.lots.find((l) => l.lot_number === 42)!.delivery).toBe('email');
  });
});

describe('bill run and payments still processing', () => {
  it('does not subtract a processing payment from the carried balance, but shows it separately', async () => {
    const owner = make('owner');
    const inv = (await owner.getMyLedger()).invoices.find((i) => i.status === 'open')!;
    await owner.getPayLink(inv.id);                        // starts a bank payment that is still processing
    const p = await make('board').previewBillRun({ year: 2028, amount_cents: 18000, due_on: '2028-05-15' });
    const pat = p.lots.find((l) => l.lot_number === 42)!;
    expect(pat.processing_cents).toBe(inv.amount_cents);
    expect(pat.carried_cents).toBe(inv.amount_cents + 2500);   // still owed until it clears
    expect(pat.total_cents).toBe(18000 + inv.amount_cents + 2500);
    expect(p.totals.processing_cents).toBe(p.lots.reduce((n, l) => n + (l.processing_cents ?? 0), 0));
    expect(p.totals.processing_cents).toBeGreaterThanOrEqual(inv.amount_cents);
    expect(p.lots.find((l) => l.lot_number === 1)!.processing_cents).toBe(0);
  });
});

describe('persistence and toolbar helpers', () => {
  it('saves under one key and a new api picks it up', async () => {
    const api = make('owner');
    await api.sendMessage({ topic: 'other', body: 'persist me' });
    expect(window.localStorage.getItem('hoa-portal-demo-v1')).toBeTruthy();
    const again = createDemoApi({ latencyMs: 0 });
    expect((await again.listMyMessages()).some((m) => m.body === 'persist me')).toBe(true);
  });
  it('works when storage throws', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      const api = make('owner');
      const m = await api.sendMessage({ topic: 'question', body: 'hi' });
      expect(m.status).toBe('acknowledged');
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
  it('demoSwitchPersona and demoReset change the active api', async () => {
    const api = make('owner');
    await expect(api.listTasks()).rejects.toThrow();
    demoSwitchPersona('board');
    expect(await api.listTasks()).toHaveLength(4);
    await api.resolveTask('task-chk', 'approve');
    demoReset();
    expect(await api.getSession()).toBeNull(); // reset goes back to signed out
    demoSwitchPersona('board');
    expect((await api.listTasks()).find((t) => t.id === 'task-chk')!.status).toBe('open');
  });
});

describe('access: unlinked sign-in, shared household, drafts', () => {
  it('an unmatched sign-in has no owner or lot, an empty bill and no pay link', async () => {
    const api = make('unlinked');
    const s = (await api.getSession())!;
    expect(s.owner).toBeNull();
    expect(s.lot).toBeNull();
    expect(await api.getMyLedger()).toEqual({ entries: [], invoices: [] });
    await expect(api.sendMessage({ topic: 'question', body: 'hello' })).rejects.toThrow(/not linked/i);
    expect(await api.listMyMessages()).toEqual([]);
  });

  it('one sign-in linked to two owner records and lots gets a session without error', async () => {
    const seed = createSeed('owner');
    const second = seed.owners.find((o) => o.id === 'owner-043')!;
    second.user_id = PAT_USER;                       // the shared household email links a second owner record
    const secondLot = seed.lot_owners.find((lo) => lo.owner_id === second.id)!.lot_id;
    window.localStorage.setItem('hoa-portal-demo-v1', JSON.stringify(seed));
    const api = make('owner');
    const s = (await api.getSession())!;
    expect(s.owners).toHaveLength(2);
    expect(s.lots).toHaveLength(2);
    expect(s.lot?.lot_number).toBe(42);              // the earliest link stays the primary lot
    expect(s.lots!.map((l) => l.id)).toContain(secondLot);
    expect((await api.getOwnerHome()).session.lots).toHaveLength(2);
  });

  it('owners see draft minutes marked as drafts; board-only documents stay hidden', async () => {
    const owner = make('owner');
    const docs = await owner.listDocuments();
    expect(docs.some((d) => d.is_draft && d.folder === 'minutes')).toBe(true);
    expect(docs.every((d) => d.audience !== 'board')).toBe(true);
    expect((await owner.getOwnerHome()).new_documents.length).toBeGreaterThan(0);
  });

  it('claim approval asks the board to verify against county land records', async () => {
    const owner = make('owner');
    await owner.redeemClaimCode(DEMO_CLAIM_CODE);
    const board = make('board');
    const task = (await board.listTasks()).find((t) => t.kind === 'claim_attach')!;
    expect(task.summary).toMatch(/county land records/);
  });

  it('dues paid counts paid and credit lots, the same rule as the database', async () => {
    const dash = await make('board').getBoardDashboard();
    const lots = await make('board').listLots();
    expect(dash.lots_paid).toBe(lots.filter((l) => l.state === 'paid' || l.state === 'credit').length);
  });
});

describe('review fixes (mirror 0005_review.sql)', () => {
  const KEY = 'hoa-portal-demo-v1';
  const store = (seed: ReturnType<typeof createSeed>) => window.localStorage.setItem(KEY, JSON.stringify(seed));

  it('a deposited check posts on the day it was received, not the day it was confirmed', async () => {
    const api = make('board');
    const c = await api.logCheck({ lot_id: 'lot-042', check_number: '3001', amount_cents: 20000, received_on: '2027-01-05' });
    await api.confirmCheckDeposit(c.id, 'deposited');
    const row = (await api.getMyLedger()).entries.find((e) => e.external_ref === `check:${c.id}`)!;
    expect(row.posted_on).toBe('2027-01-05');
    expect(row.posted_on).not.toBe(DEMO_NOW.slice(0, 10));
  });

  it('board packets can only be board-only', async () => {
    const api = make('board');
    await expect(api.addDocument({ folder: 'board_packets', title: 'Packet', audience: 'owners', file: null, is_draft: false })).rejects.toThrow(/board only/i);
    const ok = await api.addDocument({ folder: 'board_packets', title: 'Packet', audience: 'board', file: null, is_draft: false });
    expect(ok.audience).toBe('board');
    expect((await make('owner').listDocuments()).some((d) => d.folder === 'board_packets')).toBe(false);
  });

  it('a former owner loses the lot and the messages the day after ends_on, not on it', async () => {
    const seed = createSeed('owner');
    const lo = seed.lot_owners.find((x) => x.owner_id === 'owner-042')!;
    lo.ends_on = DEMO_NOW.slice(0, 10);                          // last day: still an owner
    store(seed);
    expect((await make('owner').getSession())!.lot?.lot_number).toBe(42);
    expect((await make('owner').listMyMessages()).length).toBeGreaterThan(0);
    lo.ends_on = '2027-01-12';                                   // yesterday: gone
    store(seed);
    expect((await make('owner').getSession())!.lot).toBeNull();
    expect(await make('owner').listMyMessages()).toEqual([]);
  });

  it('sendMessage takes an optional lot that must be one of mine', async () => {
    const seed = createSeed('owner');
    const second = seed.owners.find((o) => o.id === 'owner-043')!;
    second.user_id = PAT_USER;
    store(seed);
    const api = make('owner');
    const first = await api.sendMessage({ topic: 'question', body: 'default' });
    expect(first.lot_id).toBe('lot-042');
    const chosen = await api.sendMessage({ topic: 'question', body: 'second lot', lotId: 'lot-043' });
    expect(chosen.lot_id).toBe('lot-043');
    expect(chosen.owner_id).toBe('owner-043');
    await expect(api.sendMessage({ topic: 'question', body: 'forged', lotId: 'lot-044' })).rejects.toThrow(/not a current owner/);
  });

  it('a credit larger than the dues means no invoice: carried, listed, never negative', async () => {
    const board = make('board');
    const paidLot = (await board.listLots()).find((r) => r.state === 'paid' && r.balance_cents === 0 && r.lot.lot_number !== 42)!;
    const c = await board.logCheck({ lot_id: paidLot.lot.id, check_number: '3100', amount_cents: 25000, received_on: '2027-01-05' });
    await board.confirmCheckDeposit(c.id, 'deposited');
    const p = await board.previewBillRun({ year: 2028, amount_cents: 18000, due_on: '2028-05-15' });
    const row = p.lots.find((l) => l.lot_id === paidLot.lot.id)!;
    expect(row).toMatchObject({ carried_cents: -25000, total_cents: 0, credit_left_cents: 7000, no_invoice: true });
    expect(p.totals.credit_only).toBe(1);
    expect(p.lots.every((l) => l.total_cents >= 0)).toBe(true);
    expect(p.totals.billed_cents).toBe(p.lots.reduce((s, l) => s + l.total_cents, 0));
  });

  it('previewing the run again after this year\'s charge and payments are posted carries nothing new', async () => {
    const board = make('board');
    const a = await board.previewBillRun({ year: 2027, amount_cents: 17500, due_on: '2027-05-15' });
    const b = await board.previewBillRun({ year: 2027, amount_cents: 17500, due_on: '2027-05-15' });
    expect(b).toEqual(a);
    expect(a.lots.filter((l) => l.carried_cents < 0)).toEqual([]);   // paid lots do not show as carrying a credit
  });

  it('claim approval attaches to the existing roster owner; several owners need a choice', async () => {
    // one roster owner: the sign-in goes onto that record, no second owner appears
    const seed = createSeed('board');
    const lot43 = seed.lots.find((l) => l.id === 'lot-043')!;
    seed.owners.find((o) => o.id === 'owner-043')!.user_id = null;
    seed.claims.push({ id: 'claim-x', lot_id: lot43.id, email: 'new.person@example.com', created_at: DEMO_NOW, status: 'pending' });
    seed.tasks.push({ id: 'task-claim-x', kind: 'claim_attach', lot_id: lot43.id, title: 'Claim', summary: 'x', status: 'open', created_at: DEMO_NOW, due_at: null, ref_id: 'claim-x', resolved_by: null, resolved_at: null });
    store(seed);
    const api = make('board');
    const ownersBefore = seed.owners.length;
    await api.resolveTask('task-claim-x', 'approve');
    const after = JSON.parse(window.localStorage.getItem(KEY)!) as ReturnType<typeof createSeed>;
    expect(after.owners).toHaveLength(ownersBefore);
    expect(after.owners.find((o) => o.id === 'owner-043')!.user_id).toBe(PAT_USER);
    expect(after.claims.find((c) => c.id === 'claim-x')!.status).toBe('approved');

    // two roster owners: refused without a choice, nothing changes; a chosen owner of the lot works; a stranger does not
    const seed2 = createSeed('board');
    seed2.owners.push({ ...seed2.owners.find((o) => o.id === 'owner-043')!, id: 'owner-043b', user_id: null, full_name: 'Second Owner' });
    seed2.owners.find((o) => o.id === 'owner-043')!.user_id = null;
    seed2.lot_owners.push({ lot_id: 'lot-043', owner_id: 'owner-043b', starts_on: '2019-06-01', ends_on: null });
    seed2.claims.push({ id: 'claim-y', lot_id: 'lot-043', email: 'new.person@example.com', created_at: DEMO_NOW, status: 'pending' });
    seed2.tasks.push({ id: 'task-claim-y', kind: 'claim_attach', lot_id: 'lot-043', title: 'Claim', summary: 'x', status: 'open', created_at: DEMO_NOW, due_at: null, ref_id: 'claim-y', resolved_by: null, resolved_at: null });
    store(seed2);
    const api2 = make('board');
    await expect(api2.resolveTask('task-claim-y', 'approve')).rejects.toThrow(/several owners/);
    await expect(api2.resolveTask('task-claim-y', 'approve', undefined, 'owner-044')).rejects.toThrow(/not a current owner/);
    expect((await api2.listClaimRequests()).find((c) => c.id === 'claim-y')!.status).toBe('pending');
    await api2.resolveTask('task-claim-y', 'approve', undefined, 'owner-043b');
    const after2 = JSON.parse(window.localStorage.getItem(KEY)!) as ReturnType<typeof createSeed>;
    expect(after2.owners.find((o) => o.id === 'owner-043b')!.user_id).toBe(PAT_USER);
    expect(after2.owners.find((o) => o.id === 'owner-043')!.user_id).toBeNull();
  });
});

describe('review round 6 (mirror 0006_grok.sql)', () => {
  const KEY = 'hoa-portal-demo-v1';
  const store = (seed: ReturnType<typeof createSeed>) => window.localStorage.setItem(KEY, JSON.stringify(seed));
  const read = () => JSON.parse(window.localStorage.getItem(KEY)!) as ReturnType<typeof createSeed>;
  const claimTask = (id: string, lot: string) => ({ id: `task-${id}`, kind: 'claim_attach' as const, lot_id: lot, title: 'Claim', summary: 'x', status: 'open' as const, created_at: DEMO_NOW, due_at: null, ref_id: id, resolved_by: null, resolved_at: null });

  it('a board member cannot approve or reject a claim made with their own sign-in', async () => {
    await make('owner').redeemClaimCode(DEMO_CLAIM_CODE);
    const board = make('board');
    const task = (await board.listTasks()).find((t) => t.kind === 'claim_attach')!;
    await expect(board.resolveTask(task.id, 'approve')).rejects.toThrow(/your own sign-in/);
    await expect(board.resolveTask(task.id, 'reject')).rejects.toThrow(/your own sign-in/);
    expect((await board.listClaimRequests())[0].status).toBe('pending');
    expect((await board.listTasks()).find((t) => t.id === task.id)!.status).toBe('open');
  });

  it('rejecting gives the claim code back; approving keeps it used', async () => {
    const seed = createSeed('board');
    seed.used_codes.push(DEMO_CLAIM_CODE);
    seed.claims.push({ id: 'claim-r', lot_id: 'lot-042', email: 'x@example.com', created_at: DEMO_NOW, status: 'pending', user_id: 'user-someone-else', code: DEMO_CLAIM_CODE });
    seed.tasks.push(claimTask('claim-r', 'lot-042'));
    store(seed);
    await make('board').resolveTask('task-claim-r', 'reject');
    expect(read().used_codes).not.toContain(DEMO_CLAIM_CODE);
    expect((await make('owner').redeemClaimCode(DEMO_CLAIM_CODE)).ok).toBe(true);

    const seed2 = createSeed('board');
    seed2.owners.find((o) => o.id === 'owner-043')!.user_id = null;
    seed2.used_codes.push(DEMO_CLAIM_CODE);
    seed2.claims.push({ id: 'claim-a', lot_id: 'lot-043', email: 'x@example.com', created_at: DEMO_NOW, status: 'pending', user_id: 'user-someone-else', code: DEMO_CLAIM_CODE });
    seed2.tasks.push(claimTask('claim-a', 'lot-043'));
    store(seed2);
    await make('board').resolveTask('task-claim-a', 'approve');
    expect(read().used_codes).toContain(DEMO_CLAIM_CODE);
  });

  it('send_message: 10 an hour and 30 a day per sign-in, with a friendly refusal', async () => {
    const api = make('owner');
    for (let i = 0; i < 10; i++) await api.sendMessage({ topic: 'question', body: `hello ${i}` });
    await expect(api.sendMessage({ topic: 'question', body: 'eleventh' })).rejects.toThrow("You've sent a lot of messages today. Please call or email the board.");
    // two hours later the hour is quiet, so only the daily count matters: 10 sent + 20 more = 30
    const twoHours = new Date(Date.parse(DEMO_NOW) + 2 * 3_600_000).toISOString();
    const s = read();
    const tmpl = s.messages.find((m) => m.owner_id === 'owner-042')!;
    for (let i = 0; i < 20; i++) s.messages.push({ ...tmpl, id: `pad-${i}`, channel: 'portal', created_at: new Date(Date.parse(DEMO_NOW) + 3_600_000).toISOString() });
    store(s);
    await expect(make('owner', { now: twoHours }).sendMessage({ topic: 'question', body: 'over the day' })).rejects.toThrow(/sent a lot of messages/);
  });

  it('bill run: one owner\'s consent does not take paper from a co-owner who has not elected email', async () => {
    const seed = createSeed('board');
    seed.owners.find((o) => o.id === 'owner-002')!.email_notice_consent = true;   // lot 2 owner consents
    seed.owners.find((o) => o.id === 'owner-004')!.email_notice_consent = true;
    seed.owners.push({ ...seed.owners.find((o) => o.id === 'owner-004')!, id: 'owner-004b', full_name: 'Co Owner', email: 'co@example.com', email_notice_consent: false, user_id: null });
    seed.lot_owners.push({ lot_id: 'lot-004', owner_id: 'owner-004b', starts_on: '2019-06-01', ends_on: null });
    store(seed);
    const p = await make('board').previewBillRun({ year: 2027, amount_cents: 17500, due_on: '2027-05-15' });
    expect(p.lots.find((l) => l.lot_number === 4)!.delivery).toBe('paper');
    expect(p.lots.find((l) => l.lot_number === 2)!.delivery).toBe('email');
    const seed2 = read();
    seed2.owners.find((o) => o.id === 'owner-004b')!.email_notice_consent = true;
    store(seed2);
    expect((await make('board').previewBillRun({ year: 2027, amount_cents: 17500, due_on: '2027-05-15' })).lots.find((l) => l.lot_number === 4)!.delivery).toBe('email');
  });
});

