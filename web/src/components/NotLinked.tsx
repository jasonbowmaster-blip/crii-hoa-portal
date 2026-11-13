import { Link } from 'react-router-dom';
import { config } from '../config';
import type { Session } from '../data/types';

// True when the signed-in person is matched to a home. Without one there is no balance to show,
// and an empty ledger must never be read as "paid up".
export const isLinked = (s: Session | null | undefined): boolean => !!s && !!s.owner && !!s.lot;

// Shown on Home and My bill instead of a balance when the sign-in is not matched to a home.
export default function NotLinked() {
  return (
    <section className="card" aria-label="Your home is not linked yet">
      <h2 className="section-label" style={{ margin: 0 }}>Your home</h2>
      <p className="row__title">We couldn’t match this sign-in to a home yet</p>
      <p className="sub">
        That usually means the email you signed in with is not the one we have on file. Nothing is wrong with your account,
        and we are not showing a balance because we cannot tell which home it would be for.
      </p>
      <Link to="/claim" className="btn btn--primary btn--block">Enter the code from your letter</Link>
      <p className="sub">
        No letter or code? Email <a href={`mailto:${config.boardEmail}`}>{config.boardEmail}</a> or call {config.phone}
        and the board will link your home.
      </p>
    </section>
  );
}
