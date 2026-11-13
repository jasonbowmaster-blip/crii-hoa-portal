import { getApi } from '../../data/api';
import type { HoaEvent } from '../../data/types';
import { useAsync } from '../../components/useAsync';
import Page from '../../components/Page';
import ContactFooter from '../../components/ContactFooter';
import { dayNum, monthAbbr, monthTitle, weekdayTime } from '../../components/dates';

export default function Calendar() {
  const { data, error, loading } = useAsync(() => getApi().listEvents());
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const upcoming = (data ?? [])
    .filter((e) => new Date(e.starts_at) >= startOfToday)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const months: { title: string; events: HoaEvent[] }[] = [];
  for (const e of upcoming) {
    const title = monthTitle(e.starts_at);
    const last = months[months.length - 1];
    if (last && last.title === title) last.events.push(e); else months.push({ title, events: [e] });
  }

  return (
    <Page title="Calendar" sub="Board meetings are every other month and open to all owners. Agendas post here when the board gets them." loading={loading} error={error}>
      {months.map((m) => (
        <section key={m.title}>
          <h2 className="section-label">{m.title}</h2>
          <ul className="card" style={{ margin: 0, padding: '6px 18px' }}>
            {m.events.map((e) => (
              <li key={e.id} className="row" style={{ listStyle: 'none', justifyContent: 'flex-start' }}>
                <div aria-hidden="true" style={{ minWidth: 44, textAlign: 'center' }}><strong>{monthAbbr(e.starts_at)}</strong><br />{dayNum(e.starts_at)}</div>
                <div className="row__main">
                  <span className="row__title">{e.title}</span>
                  <span className="row__meta">{weekdayTime(e.starts_at)}{e.location ? ` · ${e.location}` : ''}</span>
                  {e.video_url && <a href={e.video_url}>Join by video</a>}
                  {e.notes && <span className="row__meta">{e.notes}</span>}
                  {(e.kind === 'board_meeting' || e.kind === 'annual_meeting') && <span className="row__meta">Board meetings are open to owners</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!loading && !error && months.length === 0 && <p className="sub">No upcoming events are posted yet.</p>}
      <ContactFooter />
    </Page>
  );
}
