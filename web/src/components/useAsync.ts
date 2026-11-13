import { useCallback, useEffect, useState } from 'react';

// Runs an async loader on mount and whenever `reload` is called.
export function useAsync<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let live = true;
    setLoading(true);
    load().then(
      (d) => { if (live) { setData(d); setError(null); setLoading(false); } },
      (e: unknown) => { if (live) { setError(e instanceof Error ? e.message : 'Something went wrong.'); setLoading(false); } },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  return { data, error, loading, reload };
}
