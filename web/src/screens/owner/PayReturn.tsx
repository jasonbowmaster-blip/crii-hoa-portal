import { Link } from 'react-router-dom';
import { useSession } from '../../session';
import ContactFooter from '../../components/ContactFooter';

// Where the payment page sends owners back to.
export default function PayReturn() {
  const { session } = useSession();
  return (
    <main className="page">
      <h1 className="title">Thank you, {session?.owner?.first_name ?? 'neighbor'}</h1>
      <p className="sub" role="status">
        We’re checking your payment. Your bill will update shortly.
      </p>
      <section className="card">
        <p className="row__title">What to expect</p>
        <p className="sub">
          Card payments usually show Paid within minutes. Bank payments can take 2 to 4 business days to clear, and your bill
          shows Processing until then. Open My bill to see where yours stands.
        </p>
      </section>
      <Link to="/bill" className="btn btn--block">See my bill</Link>
      <Link to="/" className="btn btn--primary btn--block">Back to home</Link>
      <ContactFooter />
    </main>
  );
}
