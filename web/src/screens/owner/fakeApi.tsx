// Test helper: a small in-memory PortalApi and a render wrapper. Not used by the app.
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render } from '@testing-library/react';
import { setApi, type PortalApi } from '../../data/api';
import { SessionProvider } from '../../session';
import type { BalanceSummary, LedgerEntry, Owner, Session } from '../../data/types';

export const owner: Owner = {
  id: 'o1', full_name: 'Pat Rivera', first_name: 'Pat', email: 'pat@example.test', phone: null,
  mailing_address: '118 Sample Lane, Sampleton, VA 20000', email_notice_consent: false, email_notice_consent_at: null,
  board_notice_request: false, user_id: 'u1', last_sign_in_at: null,
};
export const session: Session = {
  user_id: 'u1', email: 'pat@example.test', owner,
  lot: { id: 'l1', lot_number: 42, street_address: '118 Sample Lane', status: 'active' }, board: null,
};
export const paidBalance: BalanceSummary = { balance_cents: 0, processing_cents: 0, state: 'paid', next_due_on: null, open_invoice: null };

export function entry(p: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: 'e1', lot_id: 'l1', posted_on: '2027-02-01', kind: 'charge', description: 'Charge', detail: null,
    amount_cents: 0, status: 'cleared', method: null, invoice_id: null, external_ref: null, ...p,
  };
}

export function fakeApi(over: Partial<PortalApi> = {}): PortalApi {
  const impl: Partial<PortalApi> = {
    getSession: async () => session,
    getOwnerHome: async () => ({ session, balance: paidBalance, next_event: null, announcements: [], new_documents: [] }),
    getMyLedger: async () => ({ entries: [], invoices: [] }),
    listMyMessages: async () => [],
    ...over,
  };
  return new Proxy(impl, {
    get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : () => { throw new Error(`not implemented in fake: ${String(k)}`); }),
  }) as PortalApi;
}

export function renderAt(ui: ReactElement, path: string, api: PortalApi) {
  setApi(api);
  return render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={path} element={ui} />
          <Route path="/" element={<p>HOME PAGE</p>} />
          <Route path="/sign-in" element={<p>SIGN IN PAGE</p>} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
}
