import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { getApi } from '../../data/api';
import { useSession } from '../../session';
import Page from '../../components/Page';
import ContactFooter from '../../components/ContactFooter';

export default function Settings() {
  const { session, refresh } = useSession();
  const navigate = useNavigate();
  const owner = session?.owner ?? null;
  const [notice, setNotice] = useState(owner?.email_notice_consent ?? false);
  const [meetings, setMeetings] = useState(owner?.board_notice_request ?? false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNotice(owner?.email_notice_consent ?? false);
    setMeetings(owner?.board_notice_request ?? false);
  }, [owner?.email_notice_consent, owner?.board_notice_request]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null); setSaved(false);
    try {
      await getApi().updateNoticePrefs({ email_notice_consent: notice, board_notice_request: meetings });
      await refresh();
      setSaved(true);
    } catch { setError('We could not save your choices. Please try again.'); }
  }

  async function signOut() {
    await getApi().signOut();
    await refresh();
    navigate('/sign-in');
  }

  return (
    <Page title="Notices and email" sub="These are two separate choices. Virginia law lets the HOA email official notices only to owners who agree to it.">
      <form className="card" onSubmit={save}>
        <label style={{ display: 'flex', gap: 12, alignItems: 'flex-start', minHeight: 44 }}>
          <input type="checkbox" checked={notice} onChange={(e) => { setNotice(e.target.checked); setSaved(false); }} style={{ width: 24, height: 24, flexShrink: 0 }} />
          <span>
            <strong>Email me official notices</strong><br />
            <span className="sub">Budgets, annual meeting notices, rule changes and other notices the law requires. We record the date you agreed. Until you opt in, official notices and bills keep coming on paper by mail.</span>
          </span>
        </label>
        <label style={{ display: 'flex', gap: 12, alignItems: 'flex-start', minHeight: 44 }}>
          <input type="checkbox" checked={meetings} onChange={(e) => { setMeetings(e.target.checked); setSaved(false); }} style={{ width: 24, height: 24, flexShrink: 0 }} />
          <span>
            <strong>Send me board meeting notices</strong><br />
            <span className="sub">Dates and agendas for board meetings, every other month. This choice lasts one year at a time; we ask again each year.</span>
          </span>
        </label>
        <button type="submit" className="btn btn--primary btn--block">Save my choices</button>
        <div aria-live="polite">
          {saved && <p className="sub">Saved. Thank you.</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </form>
      {owner && (
        <section className="card">
          <h2 className="row__title">Where we send paper</h2>
          <p className="sub">{owner.mailing_address}</p>
          <p className="notice">Need to change it? Message the board. Bills come on paper by mail unless you choose “Email me official notices” above. Only then do they come by email instead.</p>
        </section>
      )}
      <button type="button" className="btn btn--block" onClick={signOut}>Sign out</button>
      <ContactFooter />
    </Page>
  );
}
