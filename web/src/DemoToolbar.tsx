import { useNavigate } from 'react-router-dom';
import { useSession } from './session';
import { demoReset, demoSwitchPersona } from './data/demo/adapter';

// Only rendered in demo mode. Lets a board member preview both sides of the portal.
export default function DemoToolbar() {
  const { session, refresh } = useSession();
  const nav = useNavigate();
  const go = async (p: 'owner' | 'board' | 'signed_out', path: string) => {
    demoSwitchPersona(p);
    await refresh();
    nav(path);
  };
  const reset = async () => { demoReset(); await refresh(); nav('/sign-in'); };
  const isBoard = !!session?.board;
  return (
    <div className="demo-banner" role="region" aria-label="Preview controls">
      <span>Preview with sample data. Nothing here is real or sent. </span>
      <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button type="button" className="btn btn--link" onClick={() => go('owner', '/')} aria-pressed={!!session && !isBoard}>View as owner</button>
        <button type="button" className="btn btn--link" onClick={() => go('board', '/board')} aria-pressed={isBoard}>View as board</button>
        <button type="button" className="btn btn--link" onClick={reset}>Start over</button>
      </span>
    </div>
  );
}
