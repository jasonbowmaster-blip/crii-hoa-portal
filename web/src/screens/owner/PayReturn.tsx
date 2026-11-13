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
        Your payment is processing. Bank payments take 2 to 4 business days to clear; your bill shows Processing
        until then, then Paid. Card payments show Paid right away.
      </p>
      <section className="card">
        <p className="row__title">What happens next</p>
        <p className="sub">
          If your bank returns the payment, your bill shows Unpaid again and we email you. No late fee applies
          while a payment is processing.
        </p>
      </section>
      <Link to="/bill" className="btn btn--block">See my bill</Link>
      <Link to="/" className="btn btn--primary btn--block">Back to home</Link>
      <ContactFooter />
    </main>
  );
}
