import { appNow } from '../../lib/clock';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getApi } from '../../data/api';
import type { BoardDashboard, BoardTask, TaskKind } from '../../data/types';
import { businessDaysUntil, deadlineText } from '../../lib/ledger';
import { config } from '../../config';
import type { ReplyTemplate } from '../../data/types';
import BoardHeader, { errorText } from './BoardNav';

const KIND_LABEL: Record<TaskKind, string> = {
  check_confirm: 'Check', payment_returned: 'Returned payment', claim_attach: 'Claim code',
  template_reply: 'Question', draft_approval: 'Draft reply', records_request: 'Records request',
  returned_mail: 'Returned mail', roster_change: 'Roster change',
};

// `compose` choices never resolve the task: the board member answers from the board email inbox and the request stays open.
interface Choice { action: 'approve' | 'reject' | 'dismiss' | 'compose'; label: string; done: string }

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
              { action: 'compose', label: 'Write my own', done: '' }];
    case 'draft_approval': case 'records_request':
      return [{ action: 'approve', label: 'Approve and send', done: 'Sent with your approval' },
              { action: 'compose', label: 'Edit draft', done: '' }];
    default:
      return [{ action: 'approve', label: 'Mark as handled', done: 'Handled' },
              { action: 'dismiss', label: 'Dismiss', done: 'Dismissed' }];
  }
}

function flagFor(t: BoardTask): { text: string; warn: boolean } | null {
  if (t.due_at) {
    const n = businessDaysUntil(appNow().toISOString(), t.due_at);
    return { text: deadlineText(n), warn: n < 3 };
  }
  if (t.kind === 'check_confirm') return { text: 'Needs a second person', warn: true };
  if (t.kind === 'template_reply') return { text: 'Template fits', warn: false };
  if (t.kind === 'draft_approval') return { text: 'Draft ready', warn: false };
  return null;
}

const SENDS_REPLY: TaskKind[] = ['template_reply', 'draft_approval', 'records_request'];

// The text the owner would receive, or null when this view cannot show it.
function outgoingText(t: BoardTask, templates: ReplyTemplate[]): string | null {
  if (t.draft_body) return t.draft_body;
  if (t.kind !== 'template_reply') return null;
  const byId = t.template_id ? templates.find((x) => x.id === t.template_id) : undefined;
  const byName = templates.find((x) => t.summary.includes(x.name));
  return (byId ?? byName)?.body ?? null;
}

function TaskCard({ t, lot, templates, doneText, onResolve }: {
  t: BoardTask; lot: string; templates: ReplyTemplate[]; doneText?: string; onResolve: (t: BoardTask, c: Choice) => Promise<void>;
}) {
  const [yes, alt] = choicesFor(t.kind);
  const flag = flagFor(t);
  const sendsReply = SENDS_REPLY.includes(t.kind);
  const text = sendsReply ? outgoingText(t, templates) : null;
  const [panel, setPanel] = useState<'confirm' | 'compose' | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    try { await onResolve(t, yes); } finally { setBusy(false); }
  }

  return (
    <section className="card" aria-label={t.title}>
      <p className="eyebrow">{KIND_LABEL[t.kind]}{lot}</p>
      {flag && !doneText && <span className={`board-flag${flag.warn ? ' board-flag--warn' : ''}`}>{flag.text}</span>}
      <p className="row__title">{t.title}</p>
      <p className="row__meta">{t.summary}</p>
      {doneText ? <p className="board-ok">{doneText}</p> : (
        <>
          {panel === 'confirm' && (
            <div className="board-confirm" role="group" aria-label="Confirm before sending">
              <p className="row__title">This is exactly what the owner will get</p>
              <blockquote className="board-quote">{text}</blockquote>
              <p className="board-warn-note">
                {config.dataMode === 'demo'
                  ? 'Preview only: nothing is delivered to anyone from this sample portal. Sending here only marks the request as answered in the sample data.'
                  : 'Sending marks this request as answered in the portal. Check that the reply also goes out from the board email inbox.'}
              </p>
              <div className="board-actions">
                <button type="button" className="btn btn--primary" disabled={busy} onClick={send}>Yes, send this reply</button>
                <button type="button" className="btn" onClick={() => setPanel(null)}>Cancel</button>
              </div>
            </div>
          )}
          {panel === 'compose' && (
            <div className="board-confirm" role="note">
              <p className="row__title">Reply from the board email inbox</p>
              <p className="body16">
                Replies you write yourself go out from <a href={`mailto:${config.boardEmail}`}>{config.boardEmail}</a>, not from this page. This request stays on your list until it is answered.
              </p>
              <button type="button" className="btn" onClick={() => setPanel(null)}>Close</button>
            </div>
          )}
          {panel === null && (
            <div className="board-actions">
              {sendsReply && text === null ? (
                <p className="body16">The reply text is not shown on this screen. Read and send it from the board email inbox.</p>
              ) : (
                <button type="button" className="btn btn--primary" onClick={() => (sendsReply ? setPanel('confirm') : onResolve(t, yes))}>{yes.label}</button>
              )}
              <button type="button" className="btn" onClick={() => (alt.action === 'compose' ? setPanel('compose') : onResolve(t, alt))}>{alt.label}</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default function BoardHome() {
  const [dash, setDash] = useState<BoardDashboard | null>(null);
  const [lotNumbers, setLotNumbers] = useState<Record<string, number>>({});
  const [templates, setTemplates] = useState<ReplyTemplate[]>([]);
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
    api.listTemplates().then(setTemplates).catch(() => { /* without them a template task shows no text and cannot be sent from here */ });
  }, []);

  async function resolve(t: BoardTask, c: Choice) {
    setError('');
    if (c.action === 'compose') return;
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
          const lot = t.lot_id && lotNumbers[t.lot_id] ? ` · Lot ${lotNumbers[t.lot_id]}` : '';
          return <TaskCard key={t.id} t={t} lot={lot} templates={templates} doneText={done[t.id]} onResolve={resolve} />;
        })}
        {dash.open_tasks.length === 0 && <p className="sub">Nothing is waiting on the board.</p>}
      </div>

      <section className="card">
        <h2 className="row__title">Message queue this week</h2>
        <p className="row__meta">
          This week: {m.received} in, {m.answered} answered by board members. Still waiting, from any week: {m.waiting}, oldest {m.oldest_waiting_business_days} business day{m.oldest_waiting_business_days === 1 ? '' : 's'}. Every reply is sent by a person.
        </p>
      </section>

      <div className="grid-2">
        <Link className="tile" to={{ pathname: '/board/post', hash: '#h-ann' }}>Post announcement</Link>
        <Link className="tile" to={{ pathname: '/board/post', hash: '#h-doc' }}>Upload document</Link>
        <Link className="tile" to="/board/inbox">Inbox</Link>
        <Link className="tile" to="/board/bill-run">Bill run</Link>
      </div>
    </main>
  );
}
