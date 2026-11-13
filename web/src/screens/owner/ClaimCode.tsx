import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { getApi } from '../../data/api';
import { useSession } from '../../session';
import ContactFooter from '../../components/ContactFooter';

export default function ClaimCode() {
  const { session, loading, refresh } = useSession();
  const [code, setCode] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) { setResult({ ok: false, message: 'Enter the code from your letter.' }); return; }
    setBusy(true);
    try {
      const r = await getApi().redeemClaimCode(code.trim());
      setResult(r);
      if (r.ok) await refresh();
    } catch { setResult({ ok: false, message: 'We could not check that code. Please try again.' }); }
    finally { setBusy(false); }
  }

  if (loading) return <main className="page" aria-busy="true"><p className="sub">Loading…</p></main>;

  // The code can only be linked to a sign-in, so signed-out visitors are sent to sign in first and come straight back here.
  if (!session) {
    return (
      <main className="page">
        <h1 className="title">Enter your code</h1>
        <p className="sub">Every home’s letter has a one-time code. Entering it links your sign-in to your home. First, sign in with any email or Google account you like; you will come right back to this step.</p>
        <Link to="/sign-in?next=%2Fclaim" className="btn btn--primary btn--block">Sign in, then enter my code</Link>
        <Link to="/sign-in">Back to sign in</Link>
        <ContactFooter />
      </main>
    );
  }

  return (
    <main className="page">
      <h1 className="title">Enter your code</h1>
      <p className="sub">Every home’s letter has a one-time code. Entering it links your sign-in to your home.</p>
      <form className="card" onSubmit={submit} noValidate>
        <label className="field">Code from your letter
          <input className="input" value={code} autoComplete="off" onChange={(e) => setCode(e.target.value)} />
        </label>
        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>Link my home</button>
      </form>
      <div aria-live="polite">
        {result && <p className={result.ok ? 'sub' : 'error'}>{result.message}</p>}
      </div>
      <Link to="/">Back to home</Link>
      <ContactFooter />
    </main>
  );
}
