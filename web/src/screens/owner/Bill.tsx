import { Link } from 'react-router-dom';
import { getApi } from '../../data/api';
import { useAsync } from '../../components/useAsync';
import { useSession } from '../../session';
import { summarizeBalance } from '../../lib/ledger';
import type { LedgerEntry } from '../../data/types';
import Page from '../../components/Page';
import BalanceCard from '../../components/BalanceCard';
import StatusPill from '../../components/StatusPill';
import Amount from '../../components/Amount';
import ContactFooter from '../../components/ContactFooter';
import { longDate } from '../../components/dates';

function Row({ e }: { e: LedgerEntry }) {
  const pill = e.status === 'processing' ? 'processing' : e.status === 'returned' ? 'returned' : e.kind === 'payment' ? 'paid' : null;
  const meta = [longDate(e.posted_on), e.status === 'returned' && !e.detail ? 'Returned by the bank' : e.detail].filter(Boolean).join(' · ');
  return (
    <li className="row" style={{ listStyle: 'none' }}>
      <div className="row__main">
        <span className="row__title">{e.description}</span>
        <span className="row__meta">{meta}</span>
      </div>
      <div className="row__end">
        <Amount cents={e.status === 'returned' ? 0 : e.amount_cents} className="row__title" />
        {pill && <StatusPill status={pill} />}
      </div>
    </li>
  );
}

export default function Bill() {
  const { session } = useSession();
  const { data, error, loading } = useAsync(() => getApi().getMyLedger());
  const entries = [...(data?.entries ?? [])].sort((a, b) => b.posted_on.localeCompare(a.posted_on) || b.id.localeCompare(a.id));
  const year = entries[0]?.posted_on.slice(0, 4) ?? String(new Date().getFullYear());
  const thisYear = entries.filter((e) => e.posted_on.startsWith(year));
  const earlier = entries.filter((e) => !e.posted_on.startsWith(year));

  return (
    <Page title="My bill" sub={session?.lot ? `Lot ${session.lot.lot_number} · ${session.lot.street_address}` : undefined} loading={loading} error={error}>
      {data && (
        <>
          <BalanceCard balance={summarizeBalance(data.entries, data.invoices)} />
          <p className="notice">A payment that is still processing counts once it clears.</p>
          {[['This year', thisYear], ['Earlier', earlier]].map(([label, list]) => {
            const rows = list as LedgerEntry[];
            return rows.length > 0 && (
              <section key={label as string}>
                <h2 className="section-label">{label as string}</h2>
                <ul className="card" style={{ margin: 0, padding: '6px 18px' }}>{rows.map((e) => <Row key={e.id} e={e} />)}</ul>
              </section>
            );
          })}
          {entries.length === 0 && <p className="sub">Nothing on your bill yet.</p>}
          <p className="notice">Something look wrong? <Link to="/message">Message the board</Link> and pick Billing.</p>
          <ContactFooter />
        </>
      )}
    </Page>
  );
}
