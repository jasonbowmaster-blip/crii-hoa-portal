import { appNow } from '../../lib/clock';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getApi } from '../../data/api';
import type { BoardDashboard, BoardTask, TaskKind } from '../../data/types';
import { businessDaysBetween } from '../../lib/ledger';
import BoardHeader, { errorText } from './BoardNav';

const KIND_LABEL: Record<TaskKind, string> = {
  check_confirm: 'Check', payment_returned: 'Returned payment', claim_attach: 'Claim code',
  template_reply: 'Question', draft_approval: 'Draft reply', records_request: 'Records request',
  returned_mail: 'Returned mail', roster_change: 'Roster change',
};

interface Choice { action: 'approve' | 'reject' | 'dismiss'; label: string; done: string }

function choicesFor(kind: TaskKind): [Choice, Choice] {
  switch (kind) {
    case 'check_confirm':
      return [{ action: 'approve', label: 'Confirm deposit', done: 'Deposit confirmed' },
              { action: 'reject', label: 'Not on the deposit', done: 'Marked as not on the deposit' }];
    case 'claim_attach':
      return [{ action: 'approve', label: 'Approve', done: 'Approved' },
              { action: 'reject', label: 'Reject', done: 'Rejected' }];
    case 'template_reply':
      return [{ action: 'approve', label: 'Send template reply', done: 'Sent by you from the template' },
              { action: 'dismiss', label: 'Write my own', done: 'Left for you to answer' }];
    case 'draft_approval': case 'records_request':
      return [{ action: 'approve', label: 'Approve and send', done: 'Sent with your approval' },
              { action: 'dismiss', label: 'Edit draft', done: 'Set aside to edit' }];
    default:
      return [{ action: 'approve', label: 'Mark as handled', done: 'Handled' },
              { action: 'dismiss', label: 'Dismiss', done: 'Dismissed' }];
  }
}

function flagFor(t: BoardTask): { text: string; warn: boolean } | null {
  if (t.due_at) {
    const n = businessDaysBetween(appNow().toISOString(), t.due_at);
    return { text: `${n} business day${n === 1 ? '' : 's'} left`, warn: n < 3 };
  }
  if (t.kind === 'check_confirm') return { text: 'Needs a second person', warn: true };
  if (t.kind === 'template_reply') return { text: 'Template fits', warn: false };
  if (t.kind === 'draft_approval') return { text: 'Draft ready', warn: false };
  return null;
}

export default function BoardHome() {
  const [dash, setDash] = useState<BoardDashboard | null>(null);
  const [lotNumbers, setLotNumbers] = useState<Record<string, number>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    const api = getApi();
    api.getBoardDashboard().then(setDash).catch((e) => setError(errorText(e)));
    api.listLots().then((rows) => {
      const m: Record<string, number> = {};
      rows.forEach((r) => { m[r.lot.id] = r.lot.lot_number; });
      setLotNumbers(m);
    }).catch(() => { /* lot numbers are a nicety; tasks still work without them */ });
  }, []);

  async function resolve(t: BoardTask, c: Choice) {
    setError('');
    try {
      await getApi().resolveTask(t.id, c.action);
      setDone((d) => ({ ...d, [t.id]: c.done }));
    } catch (e) { setError(errorText(e)); }
  }

  if (!dash) {
    return (
      <main className="page">
        <BoardHeader title="Board view" />
        {error ? <p className="error" role="alert">{error}</p> : <p aria-busy="true">Loading…</p>}
      </main>
    );
  }
  const m = dash.messages_this_week;
  const openCount = dash.open_tasks.filter((t) => !done[t.id]).length;

  return (
    <main className="page">
      <BoardHeader title="Board view" />
      <div className="grid-2">
        <div className="card"><span className="eyebrow">Dues paid</span><p className="board-stat">{dash.lots_paid} of {dash.lots_total}</p></div>
        <div className="card"><span className="eyebrow">Owners signed in</span><p className="board-stat">{dash.owners_signed_in} of {dash.lots_total}</p></div>
      </div>

      <h2 className="section-label">Needs a board decision · {openCount} open</h2>
      <p className="error" role="alert" hidden={!error}>{error}</p>
      <div aria-live="polite" style={{ display: 'contents' }}>
        {dash.open_tasks.map((t) => {
          const [yes, alt] = choicesFor(t.kind);
          const flag = flagFor(t);
          const lot = t.lot_id && lotNumbers[t.lot_id] ? ` · Lot ${lotNumbers[t.lot_id]}` : '';
          return (
            <section className="card" key={t.id} aria-label={t.title}>
              <p className="eyebrow">{KIND_LABEL[t.kind]}{lot}</p>
              {flag && !done[t.id] && <span className={`board-flag${flag.warn ? ' board-flag--warn' : ''}`}>{flag.text}</span>}
              <p className="row__title">{t.title}</p>
              <p className="row__meta">{t.summary}</p>
              {done[t.id]
                ? <p className="board-ok">{done[t.id]}</p>
                : (
                  <div className="board-actions">
                    <button type="button" className="btn btn--primary" onClick={() => resolve(t, yes)}>{yes.label}</button>
                    <button type="button" className="btn" onClick={() => resolve(t, alt)}>{alt.label}</button>
                  </div>
                )}
            </section>
          );
        })}
        {dash.open_tasks.length === 0 && <p className="sub">Nothing is waiting on the board.</p>}
      </div>

      <section className="card">
        <h2 className="row__title">Message queue this week</h2>
        <p className="row__meta">
          {m.received} in, {m.answered} answered by board members, {m.waiting} waiting, oldest {m.oldest_waiting_business_days} business day{m.oldest_waiting_business_days === 1 ? '' : 's'}. Every reply is sent by a person.
        </p>
      </section>

      <div className="grid-2">
        <Link className="tile" to="/board/post">Post announcement</Link>
        <Link className="tile" to="/board/post">Upload document</Link>
        <Link className="tile" to="/board/inbox">Inbox</Link>
        <Link className="tile" to="/board/bill-run">Bill run</Link>
      </div>
    </main>
  );
}
