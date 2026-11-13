import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import { setApi } from '../../data/api';
import type { LotRow, PortalApi } from '../../data/api';

// Test helper: a fake PortalApi. Every method throws unless a test overrides it.
export function installFakeApi(overrides: Partial<PortalApi>): PortalApi {
  const api = new Proxy(overrides, {
    get(target, prop: string) {
      return (target as Record<string, unknown>)[prop] ?? (() => Promise.reject(new Error(`unexpected call: ${prop}`)));
    },
  }) as unknown as PortalApi;
  setApi(api);
  return api;
}

export function renderBoard(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

export const LOT_ROWS: LotRow[] = [
  {
    lot: { id: 'l23', lot_number: 23, street_address: '23 Sample Lane', status: 'active' },
    owners: [{ id: 'o1', full_name: 'Sample Owner', first_name: 'Sample', email: 'sample@example.test', phone: null, mailing_address: '', email_notice_consent: false, email_notice_consent_at: null, board_notice_request: false, user_id: null, last_sign_in_at: null }],
    balance_cents: 17500, state: 'unpaid',
  },
];
