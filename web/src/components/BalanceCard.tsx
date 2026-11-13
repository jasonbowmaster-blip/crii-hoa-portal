import { useState } from 'react';
import type { BalanceSummary } from '../data/types';
import { getApi } from '../data/api';
import { longDate } from './dates';
import StatusPill from './StatusPill';
import Amount from './Amount';

// Balance, state pill and (only when something is owed) a Pay now button.
export default function BalanceCard({ balance }: { balance: BalanceSummary }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { state, open_invoice } = balance;
  const owed = state === 'unpaid' && open_invoice !== null;
  const shown = state === 'processing' ? balance.processing_cents : Math.abs(balance.balance_cents);
  const due = balance.next_due_on ? longDate(balance.next_due_on) : null;

  async function pay() {
    if (!open_invoice) return;
    setBusy(true); setError(null);
    try { window.location.assign(await getApi().getPayLink(open_invoice.id)); }
    catch { setError('We could not open the payment page. Please try again, or message the board.'); setBusy(false); }
  }

  return (
    <section className="card" aria-label="Your balance">
      <div className="row" style={{ alignItems: 'center' }}>
        <h2 className="section-label" style={{ margin: 0 }}>{state === 'credit' ? 'Your credit' : 'Your balance'}</h2>
        <StatusPill status={state} />
      </div>
      <p className="big-amount"><Amount cents={shown} /></p>
      <p className="sub">
        {state === 'paid' && 'You are paid up. Thank you.'}
        {state === 'credit' && 'This credit applies to your next bill.'}
        {state === 'processing' && 'Your payment is processing. It counts once it clears, usually 2 to 4 business days.'}
        {state === 'unpaid' && `Dues plus any balance carried from before${due ? ` · due by ${due}, no late fee before then` : ''}`}
      </p>
      {owed && <button type="button" className="btn btn--primary btn--block" onClick={pay} disabled={busy}>Pay now</button>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
