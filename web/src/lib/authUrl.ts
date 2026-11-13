// Sign-in callbacks. HashRouter owns the part of the URL after "#", so the callback must come back as a plain
// "?code=..." query string on the app's own address (the PKCE flow), never as "#access_token=...".

// Where the sign-in provider sends people back to: the app's address without any hash or query.
export const appReturnUrl = (loc: Pick<Location, 'origin' | 'pathname'> = location): string => `${loc.origin}${loc.pathname}`;

const CALLBACK_PARAMS = ['code', 'error', 'error_code', 'error_description'];

// The same address with the sign-in callback parameters removed (the hash route is kept).
export function stripAuthParams(href: string): string {
  const u = new URL(href);
  CALLBACK_PARAMS.forEach((k) => u.searchParams.delete(k));
  return u.toString();
}

export const hasAuthCallback = (href: string): boolean => {
  const u = new URL(href);
  return CALLBACK_PARAMS.some((k) => u.searchParams.has(k));
};
