import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getApi } from '../../data/api';
import { useSession } from '../../session';
import { config } from '../../config';

export default function SignIn() {
  const { session, refresh } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (session) navigate('/', { replace: true }); }, [session, navigate]);

  async function google() {
    setBusy(true); setError(null);
    try { await getApi().signInWithGoogle(); await refresh(); navigate('/'); }
    catch { setError('Sign-in did not finish. Please try again.'); }
    finally { setBusy(false); }
  }

  async function emailLink(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) { setError('Enter your email address.'); return; }
    setBusy(true); setError(null);
    try { await getApi().sendSignInLink(email.trim()); setSent(true); await refresh(); }
    catch { setError('We could not send the link. Please try again.'); }
    finally { setBusy(false); }
  }

  return (
    <main className="page">
      <p className="eyebrow">{config.hoaName} neighbors</p>
      <h1 className="title">Sign in</h1>
      <p className="sub">Your account is already set up. Sign in with the email we have on file for your home.</p>
      <button type="button" className="btn btn--block" onClick={google} disabled={busy}>Continue with Google</button>
      {sent ? (
        <div className="card card--tint" role="status" aria-live="polite">
          <strong>Check your email</strong>
          <span className="sub">If that address is on file, a sign-in link is on its way. It works once and expires soon.</span>
        </div>
      ) : (
        <form className="card" onSubmit={emailLink} noValidate>
          <label className="field">Your email
            <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>Email me a sign-in link</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="notice">
        No password to remember. Signing in with a different email than the one we have? Every home’s letter has a
        one-time code that links it. Or write to <a href={`mailto:${config.boardEmail}`}>{config.boardEmail}</a>.
      </p>
      <Link to="/claim">Have a code from your letter?</Link>
      <p className="notice">An official {config.hoaName} site · {config.domain}</p>
    </main>
  );
}
