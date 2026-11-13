// CORS for the functions the browser calls directly (bill-run). The allowed origin comes from the PORTAL_ORIGIN
// setting (one origin, or several separated by commas), never '*': the bill run takes a bearer token, so it must
// only answer pages served from the portal. When the setting is missing or the request comes from another origin,
// no Access-Control-Allow-Origin header is sent and the browser blocks the call.

export function allowedOrigins(setting: string | undefined): string[] {
  return (setting ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter((o) => o !== '' && o !== '*');
}

export function corsHeaders(requestOrigin: string | null | undefined, setting: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
  const origin = (requestOrigin ?? '').replace(/\/+$/, '');
  if (origin !== '' && allowedOrigins(setting).includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

// Answer to an OPTIONS preflight: 204 with the headers above.
export function preflight(requestOrigin: string | null | undefined, setting: string | undefined): { status: number; headers: Record<string, string> } {
  return { status: 204, headers: corsHeaders(requestOrigin, setting) };
}
