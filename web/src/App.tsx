import type { ReactElement } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './session';
import { config } from './config';
import DemoToolbar from './DemoToolbar';

// Owner screens (owned by the owner-UI lane)
import SignIn from './screens/owner/SignIn';
import ClaimCode from './screens/owner/ClaimCode';
import Home from './screens/owner/Home';
import Bill from './screens/owner/Bill';
import PayReturn from './screens/owner/PayReturn';
import Documents from './screens/owner/Documents';
import Message from './screens/owner/Message';
import Calendar from './screens/owner/Calendar';
import Settings from './screens/owner/Settings';
// Board screens (owned by the board-UI lane)
import BoardHome from './screens/board/BoardHome';
import BoardInbox from './screens/board/BoardInbox';
import BoardLots from './screens/board/BoardLots';
import BoardChecks from './screens/board/BoardChecks';
import BoardBillRun from './screens/board/BoardBillRun';
import BoardPost from './screens/board/BoardPost';

function Guard({ children, board = false }: { children: ReactElement; board?: boolean }) {
  const { session, loading } = useSession();
  if (loading) return <p className="page" aria-busy="true">Loading…</p>;
  if (!session) return <Navigate to="/sign-in" replace />;
  if (board && !session.board) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <SessionProvider>
      <HashRouter>
        {config.dataMode === 'demo' && <DemoToolbar />}
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/claim" element={<Guard><ClaimCode /></Guard>} />
          <Route path="/" element={<Guard><Home /></Guard>} />
          <Route path="/bill" element={<Guard><Bill /></Guard>} />
          <Route path="/paid" element={<Guard><PayReturn /></Guard>} />
          <Route path="/documents" element={<Guard><Documents /></Guard>} />
          <Route path="/message" element={<Guard><Message /></Guard>} />
          <Route path="/calendar" element={<Guard><Calendar /></Guard>} />
          <Route path="/settings" element={<Guard><Settings /></Guard>} />
          <Route path="/board" element={<Guard board><BoardHome /></Guard>} />
          <Route path="/board/inbox" element={<Guard board><BoardInbox /></Guard>} />
          <Route path="/board/lots" element={<Guard board><BoardLots /></Guard>} />
          <Route path="/board/checks" element={<Guard board><BoardChecks /></Guard>} />
          <Route path="/board/bill-run" element={<Guard board><BoardBillRun /></Guard>} />
          <Route path="/board/post" element={<Guard board><BoardPost /></Guard>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </SessionProvider>
  );
}
