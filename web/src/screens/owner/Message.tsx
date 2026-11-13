import { useState, type FormEvent } from 'react';
import { getApi } from '../../data/api';
import type { MessageTopic } from '../../data/types';
import { useSession } from '../../session';
import { useAsync } from '../../components/useAsync';
import Page from '../../components/Page';
import StatusPill from '../../components/StatusPill';
import ContactFooter from '../../components/ContactFooter';
import { config } from '../../config';
import { shortDate } from '../../components/dates';

const TOPICS: { id: MessageTopic; label: string }[] = [
  { id: 'question', label: 'Question' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'arb', label: 'Home change' },
  { id: 'billing', label: 'Billing' },
  { id: 'records', label: 'Records request' },
  { id: 'other', label: 'Something else' },
];
const topicLabel = (t: MessageTopic) => TOPICS.find((x) => x.id === t)?.label ?? 'Message';

export default function Message() {
  const { session } = useSession();
  const recent = useAsync(() => getApi().listMyMessages());
  const [topic, setTopic] = useState<MessageTopic>('question');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sentTopic, setSentTopic] = useState<MessageTopic | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) { setError('Please write your message before sending.'); return; }
    setBusy(true); setError(null);
    try {
      await getApi().sendMessage({ topic, body: body.trim() });
      setSentTopic(topic); setBody(''); recent.reload();
    } catch { setError('We could not send your message. Please try again, or email the board.'); }
    finally { setBusy(false); }
  }

  return (
    <Page title="Message the board" sub={`Goes to the board’s inbox, the same place as ${config.boardEmail} and the HOA phone. The board replies within 2 business days.`}>
      <div aria-live="polite">
        {sentTopic && (
          <section className="card card--tint">
            <h2 className="row__title">We got your message</h2>
            <p className="sub">
              Thanks, {session?.owner?.first_name || 'neighbor'}. Your {topicLabel(sentTopic).toLowerCase()} message is with the board.
              The board replies within 2 business days.
            </p>
            <button type="button" className="btn" onClick={() => setSentTopic(null)}>Send another</button>
          </section>
        )}
      </div>
      {!sentTopic && (
        <form className="card" onSubmit={send} noValidate>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="row__title">What is it about?</legend>
            <div className="chips" style={{ marginTop: 8 }}>
              {TOPICS.map((t) => (
                <button key={t.id} type="button" className="chip" aria-pressed={topic === t.id} onClick={() => setTopic(t.id)}>{t.label}</button>
              ))}
            </div>
          </fieldset>
          <label className="field">Your message
            <textarea className="input" rows={5} value={body} onChange={(e) => setBody(e.target.value)} aria-invalid={error ? true : undefined} />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>Send to the board</button>
        </form>
      )}
      <p className="notice">Prefer email or phone? {config.boardEmail} · {config.phone}. Same inbox either way.</p>
      {(recent.data?.length ?? 0) > 0 && (
        <section>
          <h2 className="section-label">Your recent messages</h2>
          <ul className="card" style={{ margin: 0, padding: '6px 18px' }}>
            {recent.data!.map((m) => (
              <li key={m.id} className="row" style={{ listStyle: 'none' }}>
                <div className="row__main">
                  <span className="row__title">{m.subject || m.body.slice(0, 50)}</span>
                  <span className="row__meta">{topicLabel(m.topic)} · {shortDate(m.created_at)}</span>
                </div>
                <StatusPill status={m.status} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <ContactFooter />
    </Page>
  );
}
