import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { entry, fakeApi, owner, paidBalance, renderAt, session } from './fakeApi';
import SignIn from './SignIn';
import Home from './Home';
import Bill from './Bill';
import Message from './Message';
import Settings from './Settings';
import { setAppNow } from '../../lib/clock';

afterEach(() => { cleanup(); setAppNow(null); });

describe('SignIn', () => {
  it('signs in with Google, refreshes the session and goes home', async () => {
    let signedIn = false;
    const api = fakeApi({
      getSession: async () => (signedIn ? session : null),
      signInWithGoogle: async () => { signedIn = true; },
    });
    renderAt(<SignIn />, '/sign-in', api);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByText('HOME PAGE')).toBeTruthy();
  });

  it('says Check your email without revealing whether the address is on file', async () => {
    const sendSignInLink = vi.fn(async () => ({ sent: true as const }));
    renderAt(<SignIn />, '/sign-in', fakeApi({ getSession: async () => null, sendSignInLink }));
    fireEvent.change(await screen.findByLabelText('Your email'), { target: { value: 'nobody@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByText('Check your email')).toBeTruthy();
    expect(sendSignInLink).toHaveBeenCalledWith('nobody@example.test');
    expect(screen.getByRole('link', { name: 'Have a code from your letter?' })).toBeTruthy();
  });
});

describe('Home', () => {
  it('shows the paid balance and no Pay now button', async () => {
    renderAt(<Home />, '/', fakeApi());
    expect(await screen.findByText(/Pat/)).toBeTruthy();
    expect(screen.getByText('Lot 42 · 118 Sample Lane')).toBeTruthy();
    expect(screen.getByText('$0.00')).toBeTruthy();
    expect(screen.getByText('Paid')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pay now' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Board view' })).toBeNull();
  });

  it('shows Pay now when something is owed', async () => {
    const invoice = { id: 'i1', lot_id: 'l1', number: '2027-042', description: '2027 annual assessment', amount_cents: 45000,
      issued_on: '2027-01-01', due_on: '2027-05-15', status: 'open' as const, stripe_invoice_id: null, hosted_invoice_url: null, paid_outside_stripe: false };
    const balance = { balance_cents: 45000, processing_cents: 0, state: 'unpaid' as const, next_due_on: '2027-05-15', open_invoice: invoice };
    renderAt(<Home />, '/', fakeApi({ getOwnerHome: async () => ({ session, balance, next_event: null, announcements: [], new_documents: [] }) }));
    expect(await screen.findByRole('button', { name: 'Pay now' })).toBeTruthy();
    expect(screen.getByText('$450.00')).toBeTruthy();
  });
});

describe('Bill', () => {
  it('shows a Processing pill for a payment that is still clearing', async () => {
    const entries = [
      entry({ id: 'a', description: 'Bank payment', kind: 'payment', amount_cents: -45000, status: 'processing', detail: 'Ending 0000' }),
      entry({ id: 'b', description: '2027 annual assessment', amount_cents: 45000, posted_on: '2027-01-01' }),
    ];
    setAppNow('2027-03-01T15:00:00Z');
    renderAt(<Bill />, '/bill', fakeApi({ getMyLedger: async () => ({ entries, invoices: [] }) }));
    expect(await screen.findByText('Bank payment')).toBeTruthy();
    expect(screen.getAllByText('Processing').length).toBeGreaterThan(0);
    expect(screen.getByText('−$450.00')).toBeTruthy();
    expect(screen.getByText('This year')).toBeTruthy();
  });
});

describe('Message', () => {
  it('requires a non-empty message', async () => {
    const sendMessage = vi.fn();
    renderAt(<Message />, '/message', fakeApi({ sendMessage }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send to the board' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/write your message/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends and shows the confirmation panel', async () => {
    const sendMessage = vi.fn(async () => ({}) as never);
    renderAt(<Message />, '/message', fakeApi({ sendMessage }));
    fireEvent.click(await screen.findByRole('button', { name: 'Billing' }));
    fireEvent.change(screen.getByLabelText('Your message'), { target: { value: 'My bill looks off.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to the board' }));
    expect(await screen.findByText('We got your message')).toBeTruthy();
    expect(sendMessage).toHaveBeenCalledWith({ topic: 'billing', body: 'My bill looks off.' });
    expect(screen.getByRole('button', { name: 'Send another' })).toBeTruthy();
  });
});

describe('Settings', () => {
  it('saves both choices and confirms', async () => {
    const updateNoticePrefs = vi.fn(async () => owner);
    renderAt(<Settings />, '/settings', fakeApi({ updateNoticePrefs }));
    await screen.findByText(owner.mailing_address); // session has loaded
    fireEvent.click(screen.getByLabelText(/Email me official notices/));
    fireEvent.click(screen.getByLabelText(/Send me board meeting notices/));
    fireEvent.click(screen.getByRole('button', { name: 'Save my choices' }));
    await waitFor(() => expect(updateNoticePrefs).toHaveBeenCalledWith({ email_notice_consent: true, board_notice_request: true }));
    expect(await screen.findByText('Saved. Thank you.')).toBeTruthy();
  });
});

describe('not linked yet', () => {
  const unlinked = { ...session, owner: null, lot: null };
  const emptyHome = { session: unlinked, balance: paidBalance, next_event: null, announcements: [], new_documents: [] };

  it('Home says the sign-in is not matched and never says paid up', async () => {
    renderAt(<Home />, '/', fakeApi({ getSession: async () => unlinked, getOwnerHome: async () => emptyHome }));
    expect(await screen.findByText('We couldn’t match this sign-in to a home yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Enter the code from your letter' }).getAttribute('href')).toBe('/claim');
    expect(screen.getAllByRole('link').some((a) => (a.getAttribute('href') ?? '').startsWith('mailto:'))).toBe(true);
    expect(screen.queryByText(/paid up/i)).toBeNull();
    expect(screen.queryByText('Paid')).toBeNull();
    expect(screen.queryByText('$0.00')).toBeNull();
  });

  it('My bill shows the same state, not an empty paid-up bill', async () => {
    renderAt(<Bill />, '/bill', fakeApi({ getSession: async () => unlinked }));
    expect(await screen.findByText('We couldn’t match this sign-in to a home yet')).toBeTruthy();
    expect(screen.queryByText(/paid up/i)).toBeNull();
    expect(screen.queryByText('Nothing on your bill yet.')).toBeNull();
  });
});
