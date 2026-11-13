import type { ReactNode } from 'react';
import TabBar from './TabBar';

// Standard owner page: title, body, tab bar. Shows a loading or error line instead of the body.
export default function Page({ title, sub, loading, error, children }: {
  title: string; sub?: string; loading?: boolean; error?: string | null; children?: ReactNode;
}) {
  return (
    <>
      <main className="page page--tabbed">
        <h1 className="title">{title}</h1>
        {sub && <p className="sub">{sub}</p>}
        {loading && <p className="sub" aria-busy="true">Loading…</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {!loading && !error && children}
      </main>
      <TabBar />
    </>
  );
}
