// Remembers where a person was heading when they were sent to sign in (for example "enter my letter code"), so it
// survives a full-page round trip through Google or an emailed link. localStorage, not sessionStorage: an emailed
// link usually opens in a new tab. Storage can be blocked; every call is wrapped.
const KEY = 'portal.afterSignIn';

// Only in-app paths: starts with one slash, never a protocol-relative or sign-in loop.
export function safeNext(path: string | null | undefined): string | null {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/sign-in')) return null;
  return path;
}

export function rememberNext(path: string | null | undefined): void {
  const p = safeNext(path);
  if (!p) return;
  try { localStorage.setItem(KEY, p); } catch { /* storage blocked: the default landing screen still works */ }
}

export function peekNext(): string | null {
  try { return safeNext(localStorage.getItem(KEY)); } catch { return null; }
}

// Returns the remembered destination once, then forgets it.
export function takeNext(): string | null {
  const p = peekNext();
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  return p;
}
