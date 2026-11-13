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
    getApi().listLots(query.trim() || undefined)
      .then((r) => { setRows(r); setError(''); })
      .catch((e) => setError(errorText(e)));
  }, [query]);

  return (
    <main className="page page--wide">
      <BoardHeader title="Lots" />
      <label className="field">Search by lot, address or owner
        <input className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="sub" aria-live="polite">{rows ? `${rows.length} lot${rows.length === 1 ? '' : 's'}` : 'Loading…'}</p>
      <div className="card table-scroll">
        <table className="data">
          <thead><tr><th>Lot</th><th>Address</th><th>Owners</th><th>Balance</th><th>State</th></tr></thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.lot.id}>
                <td>{r.lot.lot_number}</td>
                <td>{r.lot.street_address}</td>
                <td>{r.owners.map((o) => (
                  <div key={o.id}>{o.full_name}{o.email ? <span className="row__meta"> · {o.email}</span> : null}</div>
                ))}</td>
                <td>{formatCents(r.balance_cents)}</td>
                <td><span className={`pill pill--${r.state === 'credit' ? 'paid' : r.state}`}>{STATE_LABEL[r.state]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
