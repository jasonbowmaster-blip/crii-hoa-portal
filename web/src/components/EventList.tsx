import { appNow } from '../lib/clock';
import type { HoaEvent } from '../data/types';
import { dayNum, eventWhen, fullDate, monthAbbr, monthTitle } from './dates';

// Upcoming events grouped by month. Shared by the owner Calendar and the signed-out public view.
export default function EventList({ events, loading, error }: { events: HoaEvent[]; loading?: boolean; error?: string | null }) {
  const startOfToday = appNow(); startOfToday.setHours(0, 0, 0, 0);
  const upcoming = events
    .filter((e) => new Date(e.starts_at) >= startOfToday)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const months: { title: string; events: HoaEvent[] }[] = [];
  for (const e of upcoming) {
    const title = monthTitle(e.starts_at);
    const last = months[months.length - 1];
    if (last && last.title === title) last.events.push(e); else months.push({ title, events: [e] });
  }
  return (
    <>
      {months.map((m) => (
        <section key={m.title}>
          <h2 className="section-label">{m.title}</h2>
          <ul className="card" style={{ margin: 0, padding: '6px 18px' }}>
            {m.events.map((e) => (
              <li key={e.id} className="row" style={{ listStyle: 'none', justifyContent: 'flex-start' }}>
                {/* The short month/day block is decoration; the full date is read from the line below. */}
                <div aria-hidden="true" style={{ minWidth: 44, textAlign: 'center' }}><strong>{monthAbbr(e.starts_at)}</strong><br />{dayNum(e.starts_at)}</div>
                <div className="row__main">
                  <span className="row__title">{e.title}</span>
                  <span className="row__meta"><span className="sr-only">{fullDate(e.starts_at)}, </span>{eventWhen(e.starts_at, e.kind)}{e.location ? ` · ${e.location}` : ''}</span>
                  {e.video_url && <a href={e.video_url}>Join by video</a>}
                  {e.notes && <span className="row__meta">{e.notes}</span>}
                  {e.kind === 'board_meeting' && <span className="row__meta">Board meetings are open to owners</span>}
                  {e.kind === 'annual_meeting' && <span className="row__meta">Annual meeting of all owners</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!loading && !error && months.length === 0 && <p className="sub">No upcoming events are posted yet.</p>}
    </>
  );
}
