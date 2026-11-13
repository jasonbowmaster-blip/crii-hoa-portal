import { Link } from 'react-router-dom';
import { getApi } from '../../data/api';
import { useAsync } from '../../components/useAsync';
import Page from '../../components/Page';
import BalanceCard from '../../components/BalanceCard';
import BoardLink from '../../components/BoardLink';
import ContactFooter from '../../components/ContactFooter';
import { config } from '../../config';
import { daysAgo, dayNum, greeting, monthAbbr, weekdayTime } from '../../components/dates';

export default function Home() {
  const { data, error, loading } = useAsync(() => getApi().getOwnerHome());
  const s = data?.session;
  const ev = data?.next_event;
  const ann = data?.announcements[0];
  const ago = ann ? daysAgo(ann.posted_at) : 0;

  return (
    <Page title={data ? `${greeting()}, ${s?.owner?.first_name ?? 'neighbor'}` : config.hoaName} loading={loading} error={error}>
      {data && s && (
        <>
          {s.lot && <p className="sub">Lot {s.lot.lot_number} · {s.lot.street_address}</p>}
          <BalanceCard balance={data.balance} />
          <Link to="/bill">See my bill and payment history</Link>
          {ev && (
            <Link to="/calendar" className="card" style={{ flexDirection: 'row', textDecoration: 'none', color: 'inherit' }}>
              <div aria-hidden="true"><strong>{monthAbbr(ev.starts_at)}</strong><br />{dayNum(ev.starts_at)}</div>
              <div>
                <p className="eyebrow">Next up</p>
                <p className="row__title">{ev.title}</p>
                <p className="row__meta">{weekdayTime(ev.starts_at)}{ev.location ? ` · ${ev.location}` : ev.video_url ? ' · Video link on the calendar' : ''}</p>
              </div>
            </Link>
          )}
          {ann && (
            <section className="card">
              <p className="eyebrow">Announcement · {ago <= 0 ? 'today' : ago === 1 ? '1 day ago' : `${ago} days ago`}</p>
              <p className="row__title">{ann.title}</p>
              <p className="sub">{ann.body}</p>
            </section>
          )}
          <div className="grid-2">
            <Link to="/message" className="tile">Message the board</Link>
            <Link to="/documents" className="tile">Documents</Link>
          </div>
          <Link to="/settings">Notice and email settings</Link>
          <BoardLink />
          <ContactFooter />
        </>
      )}
    </Page>
  );
}
