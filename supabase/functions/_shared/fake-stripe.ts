// A fake Stripe for tests: records every request and answers like the real API would, with predictable ids.
export interface RecordedRequest { method: string; path: string; headers: Record<string, string>; body: URLSearchParams; query: URLSearchParams }

export function fakeStripe(opts: { existingInvoices?: any[]; failOn?: (path: string) => { status: number; code?: string } | null } = {}) {
  const requests: RecordedRequest[] = [];
  const byKey = new Map<string, any>();
  let n = 0;
  const fetchFn = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(input);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const req: RecordedRequest = { method: init.method ?? 'GET', path: u.pathname, headers, body: new URLSearchParams(String(init.body ?? '')), query: u.searchParams };
    requests.push(req);
    const fail = opts.failOn?.(u.pathname);
    if (fail) return Response.json({ error: { message: 'boom', code: fail.code } }, { status: fail.status });
    const key = headers['Idempotency-Key'];
    if (key && byKey.has(key)) return Response.json(byKey.get(key));   // Stripe replays the first answer
    let out: any;
    if (req.method === 'GET') out = { data: opts.existingInvoices ?? [] };
    else if (u.pathname === '/v1/customers') out = { id: `cus_${++n}` };
    else if (u.pathname === '/v1/invoices') out = { id: `in_${++n}`, status: 'draft', total: 0, metadata: Object.fromEntries([...req.body].filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v])) };
    else if (u.pathname === '/v1/invoiceitems') out = { id: `ii_${++n}` };
    else if (u.pathname.endsWith('/finalize')) out = { id: u.pathname.split('/')[3], status: 'open', hosted_invoice_url: `https://invoice.stripe.com/i/test_${u.pathname.split('/')[3]}` };
    else out = { id: 'x', status: 'paid' };
    if (key) byKey.set(key, out);
    return Response.json(out);
  };
  return { fetchFn, requests };
}
