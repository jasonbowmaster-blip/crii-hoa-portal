import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { getApi } from '../../data/api';
import type { LotRow } from '../../data/api';
import BoardHeader, { errorText } from './BoardNav';

// "175.50" -> 17550 without floating point. Returns null if not a valid amount.
export function dollarsToCents(input: string): number | null {
  const m = /^\$?\s*(\d{1,9})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/,/g, ''));
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
  return cents > 0 ? cents : null;
}

export default function BoardChecks() {
  const [lots, setLots] = useState<LotRow[]>([]);
  const [lotId, setLotId] = useState('');
  const [number, setNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [received, setReceived] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  useEffect(() => { getApi().listLots().then(setLots).catch((e) => setError(errorText(e))); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(''); setOk('');
    const cents = dollarsToCents(amount);
    if (!lotId) return setError('Choose a lot.');
    if (cents === null) return setError('Enter the amount in dollars, like 175.50.');
    try {
      const rec = await getApi().logCheck({ lot_id: lotId, check_number: number.trim(), amount_cents: cents, received_on: received });
      setOk(`Check ${rec.check_number} logged. A second board member must confirm it is on the bank deposit before the lot shows Paid.`);
      setNumber(''); setAmount('');
    } catch (err) { setError(errorText(err)); }
  }

  return (
    <main className="page">
      <BoardHeader title="Checks" />
      <form className="card board-form" onSubmit={submit}>
        <label className="field">Lot
          <select className="input" required value={lotId} onChange={(e) => setLotId(e.target.value)}>
            <option value="">Choose a lot</option>
            {lots.map((r) => <option key={r.lot.id} value={r.lot.id}>Lot {r.lot.lot_number} · {r.lot.street_address}</option>)}
          </select>
        </label>
        <label className="field">Check number
          <input className="input" required value={number} onChange={(e) => setNumber(e.target.value)} inputMode="numeric" />
        </label>
        <label className="field">Amount in dollars
          <input className="input" required value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="175.50" />
        </label>
        <label className="field">Date received
          <input className="input" type="date" required value={received} onChange={(e) => setReceived(e.target.value)} />
        </label>
        <button type="submit" className="btn btn--primary btn--block">Log check</button>
        <p className="notice">A second board member must confirm the deposit before the lot shows Paid. The person who logs a check cannot be the one who confirms it.</p>
        <p role="alert" className="error" hidden={!error}>{error}</p>
        <p role="status" className="board-ok">{ok}</p>
      </form>
      <section className="card">
        <h2 className="row__title">Checks waiting for a second person</h2>
        <p className="row__meta">Each logged check shows up as a task on the Overview. The second board member confirms it there.</p>
        <Link className="btn" to="/board">Go to Overview</Link>
      </section>
    </main>
  );
}
