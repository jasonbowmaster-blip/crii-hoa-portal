import { Link } from 'react-router-dom';
import { getApi } from '../../data/api';
import { useAsync } from '../../components/useAsync';
import EventList from '../../components/EventList';
import ContactFooter from '../../components/ContactFooter';
import { config } from '../../config';

// Signed-out page: only events the board marked public (such as meeting notices). Nothing about homes, bills or owners.
export default function PublicEvents() {
  const { data, error, loading } = useAsync(() => getApi().listPublicEvents());
  return (
    <main className="page">
      <p className="eyebrow">{config.hoaName} neighbors</p>
      <h1 className="title">Public meeting dates</h1>
      <p className="sub">Meeting notices and dates the board has posted for everyone. Owners can sign in to see the full calendar.</p>
      {loading && <p className="sub" aria-busy="true">Loading…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {!loading && !error && <EventList events={data ?? []} />}
      <Link to="/sign-in" className="btn btn--block">Sign in</Link>
      <ContactFooter />
    </main>
  );
}
