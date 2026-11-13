import { appNow } from '../../lib/clock';
import { useEffect, useState } from 'react';
import { getApi } from '../../data/api';
import type { Message, MessageStatus, MessageTopic, ReplyTemplate } from '../../data/types';
import { businessDaysBetween } from '../../lib/ledger';
import BoardHeader, { errorText } from './BoardNav';

const STATUSES: MessageStatus[] = ['new', 'acknowledged', 'draft_waiting', 'escalated', 'answered', 'closed'];
const TOPICS: MessageTopic[] = ['question', 'maintenance', 'arb', 'billing', 'records', 'complaint', 'other'];
const label = (s: string) => { const t = s.replace(/_/g, ' '); return t[0].toUpperCase() + t.slice(1); };

function age(iso: string): string {
  const days = Math.floor((appNow().getTime() - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`;
}

function MessageRow({ m, templates, lotNumber, onReplied }: { m: Message; templates: ReplyTemplate[]; lotNumber?: number; onReplied: (m: Message) => void }) {
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const left = m.due_at && m.topic === 'records' ? businessDaysBetween(appNow().toISOString(), m.due_at) : null;

  async function reply(templateId: string) {
    if (!templateId) return;
    setErr(''); setMsg('');
    try {
      const updated = await getApi().replyWithTemplate(m.id, templateId);
      setMsg('Reply sent by you from the template.');
      onReplied(updated);
    } catch (e) { setErr(errorText(e)); }
  }

  return (
    <section className="card" aria-label={m.subject}>
      <p className="eyebrow">{label(m.topic)}{lotNumber ? ` · Lot ${lotNumber}` : ''} · {age(m.created_at)}</p>
      <p className="row__title">{m.subject}</p>
      <p className="row__meta">{m.body}</p>
      <p className="row__meta">Status: {label(m.status)}</p>
      {left !== null && (
        <p className={`row__meta${left < 3 ? ' board-due--warn' : ''}`}>
          Due {m.due_at!.slice(0, 10)} · {left} business day{left === 1 ? '' : 's'} left
        </p>
      )}
      {!['answered', 'closed'].includes(m.status) && <label className="field">
        Reply with template
        <select className="input" value="" onChange={(e) => reply(e.target.value)}>
          <option value="">Choose a template</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>}
      <p className="board-ok" role="status">{msg}</p>
      {err && <p className="error" role="alert">{err}</p>}
    </section>
  );
}

export default function BoardInbox() {
  const [status, setStatus] = useState<MessageStatus | ''>('');
  const [topic, setTopic] = useState<MessageTopic | ''>('');
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [templates, setTemplates] = useState<ReplyTemplate[]>([]);
  const [lotNumbers, setLotNumbers] = useState<Record<string, number>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    getApi().listLots().then((rows) => {
      const m: Record<string, number> = {};
      rows.forEach((r) => { m[r.lot.id] = r.lot.lot_number; });
      setLotNumbers(m);
    }).catch(() => { /* lot numbers are a nicety */ });
    getApi().listTemplates()
      .then((all) => setTemplates(all.filter((t) => t.approved_on)))
      .catch((e) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    setMessages(null);
    getApi().listInbox({ status: status || undefined, topic: topic || undefined })
      .then(setMessages).catch((e) => setError(errorText(e)));
  }, [status, topic]);

  function replied(u: Message) {
    setMessages((list) => list && list.map((m) => (m.id === u.id ? u : m)));
  }

  return (
    <main className="page page--wide">
      <BoardHeader title="Inbox" />
      <div className="board-filters">
        <label className="field">Status
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as MessageStatus | '')}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        </label>
        <label className="field">Topic
          <select className="input" value={topic} onChange={(e) => setTopic(e.target.value as MessageTopic | '')}>
            <option value="">All topics</option>
            {TOPICS.map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        </label>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {messages === null && !error && <p aria-busy="true">Loading…</p>}
      {messages?.length === 0 && <p className="sub">No messages match.</p>}
      {messages?.map((m) => <MessageRow key={m.id} m={m} templates={templates} lotNumber={m.lot_id ? lotNumbers[m.lot_id] : undefined} onReplied={replied} />)}
      <p className="notice">Templates are board-approved fixed text. Anything about money, enforcement, ARB or legal needs a board member's own reply.</p>
    </main>
  );
}
