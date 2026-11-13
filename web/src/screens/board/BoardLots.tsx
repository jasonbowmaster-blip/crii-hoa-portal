import { useEffect, useState } from 'react';
import { getApi } from '../../data/api';
import type { LotRow } from '../../data/api';
import { formatCents } from '../../lib/ledger';
import BoardHeader, { errorText } from './BoardNav';

const STATE_LABEL = { paid: 'Paid', unpaid: 'Unpaid', processing: 'Processing', credit: 'Credit' } as const;

export default function BoardLots() {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<LotRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;   // ignore a slow answer to an older search
    getApi().listLots(query.trim() || undefined)
      .then((r) => { if (live) { setRows(r); setError(''); } })
      .catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [query]);

  return (
    <main className="page page--wide">
      <BoardHeader title="Lots" />
      <label className="field">Search by lot, address or owner
        <input className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="sub" aria-live="polite">{rows ? `${rows.length} lot${rows.length === 1 ? '' : 's'}` : 'Loading…'}</p>
      <div className="card table-scroll lots-card">
        <table className="data data--stack">
          <thead><tr><th>Lot</th><th>Address</th><th>Owners</th><th>Balance</th><th>State</th></tr></thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.lot.id}>
                <td data-label="Lot" className="cell-lot">{r.lot.lot_number}</td>
                <td data-label="Address" className="cell-address">{r.lot.street_address}</td>
                <td data-label="Owners" className="cell-owners">{r.owners.map((o) => (
                  <div key={o.id}>{o.full_name}{o.email ? <span className="row__meta"> · {o.email}</span> : null}</div>
                ))}</td>
                <td data-label="Balance">{formatCents(r.balance_cents)}</td>
                <td data-label="State"><span className={`pill pill--${r.state === 'credit' ? 'paid' : r.state}`}>{STATE_LABEL[r.state]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
