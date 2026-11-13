import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fakeApi, session, renderAt } from './fakeApi';
import { setApi } from '../../data/api';
import App from '../../App';
import Documents from './Documents';
import Message from './Message';
import Calendar from './Calendar';
import PayReturn from './PayReturn';
import Settings from './Settings';
import PublicEvents from './PublicEvents';
import { setAppNow } from '../../lib/clock';
import type { DocumentItem, HoaEvent, Message as Msg } from '../../data/types';

afterEach(() => { cleanup(); setAppNow(null); localStorage.clear(); vi.restoreAllMocks(); location.hash = ''; });

describe('claim code without a dead end', () => {
  it('signed out: Sign-in -> claim -> sign in -> lands on the code form', async () => {
    let signedIn = false;
    const unmatched = { ...session, owner: null, lot: null };
    setApi(fakeApi({
      getSession: async () => (signedIn ? unmatched : null),
      signInWithGoogle: async () => { signedIn = true; },
    }));
    location.hash = '#/sign-in';
    render(<App />);
    fireEvent.click(await screen.findByRole('link', { name: 'Have a code from your letter?' }));
    // signed-out claim page explains the order and offers a way forward (no bounce back to sign-in)
    fireEvent.click(await screen.findByRole('link', { name: 'Sign in, then enter my code' }));
    expect(await screen.findByText(/Step 1 of 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByLabelText('Code from your letter')).toBeTruthy();
    expect(location.hash).toBe('#/claim');
  });

  it('keeps the destination across a full-page sign-in round trip', async () => {
    // First visit: heading to /claim while signed out, then the page is left (Google) and reloaded signed in.
    setApi(fakeApi({ getSession: async () => null }));
    location.hash = '#/claim';
    const first = render(<App />);
    fireEvent.click(await screen.findByRole('link', { name: 'Sign in, then enter my code' }));
    await screen.findByText(/Step 1 of 2/);
    first.unmount();
    // Reload at "/" with a session (the provider returned the person to the app root)
    setApi(fakeApi({ getSession: async () => ({ ...session, owner: null, lot: null }) }));
    location.hash = '';
    render(<App />);
    expect(await screen.findByLabelText('Code from your letter')).toBeTruthy();
  });

  it('a signed-out deep link goes to sign-in and comes back after sign in', async () => {
    let signedIn = false;
    setApi(fakeApi({ getSession: async () => (signedIn ? session : null), signInWithGoogle: async () => { signedIn = true; }, listDocuments: async () => [] }));
    location.hash = '#/documents';
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(location.hash).toBe('#/documents'));
  });
});

describe('opening a document', () => {
  const doc: DocumentItem = { id: 'd1', folder: 'minutes', title: 'Minutes', storage_path: 'x', audience: 'owners', posted_on: '2027-01-01', is_draft: true };
  it('opens the tab during the tap, before the link arrives', async () => {
    const win = { closed: false, opener: null, document: { title: '' }, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    let release!: (u: string) => void;
    renderAt(<Documents />, '/documents', fakeApi({ listDocuments: async () => [doc], openDocument: () => new Promise((r) => { release = r; }) }));
    fireEvent.click((await screen.findAllByRole('button', { name: /Minutes/ }))[0]);
    expect(open).toHaveBeenCalledTimes(1);
    release('https://files.example/m.pdf');
    await waitFor(() => expect(win.location.href).toBe('https://files.example/m.pdf'));
  });
  it('closes the blank tab and says so when the link fails', async () => {
    const win = { closed: false, opener: null, document: { title: '' }, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    renderAt(<Documents />, '/documents', fakeApi({ listDocuments: async () => [doc], openDocument: async () => { throw new Error('x'); } }));
    fireEvent.click((await screen.findAllByRole('button', { name: /Minutes/ }))[0]);
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not open/);
    expect(win.close).toHaveBeenCalled();
  });
  it('uses singular and plural document counts', async () => {
    renderAt(<Documents />, '/documents', fakeApi({ listDocuments: async () => [doc] }));
    expect(await screen.findByText('1 document')).toBeTruthy();
    expect(screen.getAllByText('0 documents').length).toBeGreaterThan(0);
  });
});

describe('Message screen', () => {
  const sent: Msg = { id: 'm1', lot_id: 'l1', owner_id: 'o1', topic: 'maintenance', subject: 'Light out', body: 'The light by the mailboxes is out.',
    status: 'answered', created_at: '2027-01-05T15:00:00Z', answered_at: '2027-01-06T15:00:00Z', due_at: null, gmail_thread_id: null, assigned_to: null, channel: 'portal' };

  it('opens a message to show what was sent and where the reply went', async () => {
    renderAt(<Message />, '/message', fakeApi({ listMyMessages: async () => [sent] }));
    const row = (await screen.findByText('Light out')).closest('details')!;
    expect(within(row).getByText('The light by the mailboxes is out.')).toBeTruthy();
    expect(row.textContent).toMatch(/Replies are sent to pat@example\.test/);
  });

  it('states the 10-business-day timeline for a records request, 2 days otherwise', async () => {
    renderAt(<Message />, '/message', fakeApi());
    expect((await screen.findByText(/within 2 business days/))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Records request' }));
    expect(screen.getByText(/10 business days/)).toBeTruthy();
    expect(screen.queryByText(/2 business days/)).toBeNull();
  });
});

describe('Calendar', () => {
  const events: HoaEvent[] = [
    { id: 'a', title: 'Annual meeting', kind: 'annual_meeting', starts_at: '2027-03-16T23:00:00Z', location: null, video_url: null, notes: null, is_public: true },
    { id: 'b', title: 'Board meeting', kind: 'board_meeting', starts_at: '2027-03-17T23:00:00Z', location: null, video_url: null, notes: null, is_public: true },
    { id: 'c', title: 'Dues due', kind: 'dues_date', starts_at: '2027-05-15T04:00:00Z', location: null, video_url: null, notes: null, is_public: true },
  ];
  it('gives screen readers the full date, and only board meetings say they are open', async () => {
    setAppNow('2027-03-01T15:00:00Z');
    renderAt(<Calendar />, '/calendar', fakeApi({ listEvents: async () => events }));
    expect(await screen.findByText(/Tuesday, March 16, 2027/)).toBeTruthy();
    expect(screen.getAllByText('Board meetings are open to owners')).toHaveLength(1);
    expect(screen.getByText(/Saturday, May 15, 2027/).parentElement!.textContent).toMatch(/Sat · all day/);
  });
  it('signed-out public view lists public events only', async () => {
    setAppNow('2027-03-01T15:00:00Z');
    const listPublicEvents = vi.fn(async () => events.slice(0, 1));
    renderAt(<PublicEvents />, '/events', fakeApi({ getSession: async () => null, listPublicEvents }));
    expect(await screen.findByText('Annual meeting')).toBeTruthy();
    expect(screen.queryByText('Dues due')).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy();
  });
});

describe('wording', () => {
  it('PayReturn does not claim a payment is processing', () => {
    renderAt(<PayReturn />, '/paid', fakeApi());
    expect(screen.getByRole('status').textContent).toBe('We’re checking your payment. Your bill will update shortly.');
    expect(screen.queryByText(/Your payment is processing/)).toBeNull();
  });
  it('Settings matches the bill-run rule: paper unless they chose email', async () => {
    renderAt(<Settings />, '/settings', fakeApi());
    expect(await screen.findByText(/Bills come on paper by mail unless you choose/)).toBeTruthy();
    expect(screen.queryByText(/if we have your email, by email too/)).toBeNull();
  });
});
