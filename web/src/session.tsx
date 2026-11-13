import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getApi } from './data/api';
import type { Session } from './data/types';

interface Ctx { session: Session | null; loading: boolean; refresh: () => Promise<void> }
const SessionCtx = createContext<Ctx>({ session: null, loading: true, refresh: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setSession(await getApi().getSession()); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return <SessionCtx.Provider value={{ session, loading, refresh }}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);
