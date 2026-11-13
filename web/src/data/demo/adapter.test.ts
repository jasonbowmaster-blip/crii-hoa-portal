import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addBusinessDays, businessDaysBetween } from '../../lib/ledger';
import { DEMO_CLAIM_CODE, DEMO_NOW, createDemoApi, demoReset, demoSwitchPersona } from './adapter';
import { FOLDER_LABELS } from '../types';

const make = (persona: 'owner' | 'board' | 'signed_out' = 'owner', extra = {}) =>
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
    for (const folder of Object.keys(FOLDER_LABELS)) expect(owner.some((d) => d.folder === folder)).toBe(true);
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
