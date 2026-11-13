import { useState } from 'react';
import type { FormEvent } from 'react';
import { getApi } from '../../data/api';
import type { BillRunPreview } from '../../data/types';
import { formatCents } from '../../lib/ledger';
import BoardHeader, { errorText } from './BoardNav';
import { dollarsToCents } from './BoardChecks';

export default function BoardBillRun() {
  const [year, setYear] = useState('2027');
  const [amount, setAmount] = useState('175.00');
  const [due, setDue] = useState('2027-05-15');
  const [preview, setPreview] = useState<BillRunPreview | null>(null);
  const [error, setError] = useState('');

  async function run(e: FormEvent) {
    e.preventDefault();
    setError('');
    const cents = dollarsToCents(amount);
    if (cents === null) return setError('Enter the amount in dollars, like 175.00.');
    try {
      setPreview(await getApi().previewBillRun({ year: Number(year), amount_cents: cents, due_on: due }));
    } catch (err) { setError(errorText(err)); setPreview(null); }
  }

  return (
    <main className="page page--wide">
      <BoardHeader title="Bill run" />
      <form className="card board-form" onSubmit={run}>
        <label className="field">Year
          <input className="input" type="number" required value={year} onChange={(e) => setYear(e.target.value)} />
        </label>
        <label className="field">Amount per lot in dollars
          <input className="input" required value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </label>
        <label className="field">Due date
          <input className="input" type="date" required value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <button type="submit" className="btn btn--primary">Preview bill run</button>
        <p role="alert" className="error" hidden={!error}>{error}</p>
      </form>

      <div aria-live="polite" style={{ display: 'contents' }}>
        {preview && (
          <section className="card" aria-label="Bill run preview">
            <h2 className="row__title">{preview.year} bill run preview</h2>
            <p className="row__meta">
              {preview.totals.lots} lots · {preview.totals.email} by email · {preview.totals.paper} on paper · Total billed {formatCents(preview.totals.billed_cents)}
            </p>
            <div className="table-scroll">
              <table className="data">
                <thead><tr><th>Lot</th><th>Owner</th><th>Carried</th><th>Total</th><th>Delivery</th></tr></thead>
                <tbody>
                  {preview.lots.map((l) => (
                    <tr key={l.lot_id}>
                      <td>{l.lot_number}</td><td>{l.owner_name}</td>
                      <td>{formatCents(l.carried_cents)}</td><td>{formatCents(l.total_cents)}</td>
                      <td>{l.delivery === 'email' ? 'Email' : 'Paper'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      <section className="card">
        <button type="button" className="btn btn--block" disabled aria-describedby="send-off">Send bills</button>
        <p id="send-off" className="notice">Sending is turned off in this prototype. The treasurer approves the real run after the board vote.</p>
      </section>
    </main>
  );
}
