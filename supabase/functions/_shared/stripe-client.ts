// A very small Stripe client: fetch against api.stripe.com with form-encoded bodies (no SDK).
// TEST MODE ONLY: the constructor refuses any key that does not start with sk_test_ or rk_test_.
// The key is never put in an error message or a log line.

export class StripeKeyError extends Error {}

export class StripeApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null, readonly retryable: boolean) { super(message); }
}

export function isTestKey(key: string | undefined | null): boolean {
  return typeof key === 'string' && (key.startsWith('sk_test_') || key.startsWith('rk_test_'));
}

export function assertTestKey(key: string | undefined | null): asserts key is string {
  if (!key) throw new StripeKeyError('STRIPE_SECRET_KEY is not set.');
  if (!isTestKey(key)) {
    throw new StripeKeyError('Only Stripe TEST keys (sk_test_ or rk_test_) are allowed here. A live key was refused.');
  }
}

// Stripe's form encoding: nested objects as a[b]=1, arrays as a[0]=x. Null and undefined are left out.
export function formEncode(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  const add = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => add(`${key}[${i}]`, v));
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    else pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return pairs.join('&');
}

export interface StripeClient {
  post(path: string, params: Record<string, unknown>, idempotencyKey: string): Promise<any>;
  get(path: string, query?: Record<string, unknown>): Promise<any>;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function createStripeClient(key: string | undefined, fetchFn: FetchFn = fetch, baseUrl = 'https://api.stripe.com'): StripeClient {
  assertTestKey(key);
  const call = async (method: 'GET' | 'POST', path: string, params: Record<string, unknown>, idempotencyKey?: string) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    let url = `${baseUrl}${path}`;
    let body: string | undefined;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      body = formEncode(params);
    } else {
      const q = formEncode(params);
      if (q) url += `?${q}`;
    }
    let res: Response;
    try {
      res = await fetchFn(url, { method, headers, body });
    } catch {
      throw new StripeApiError('Could not reach Stripe.', 0, null, true);
    }
    const json: any = await res.json().catch(() => null);
    if (!res.ok) {
      const code = json?.error?.code ?? null;
      const message = String(json?.error?.message ?? `Stripe answered ${res.status}`);
      throw new StripeApiError(message, res.status, code, res.status === 429 || res.status >= 500);
    }
    return json;
  };
  return {
    post: (path, params, idempotencyKey) => call('POST', path, params, idempotencyKey),
    get: (path, query = {}) => call('GET', path, query),
  };
}
