import { describe, expect, it } from 'vitest';
import { createStripeClient, formEncode, isTestKey, StripeApiError, StripeKeyError } from './stripe-client.ts';
import { fakeStripe } from './fake-stripe.ts';

describe('test-key guard', () => {
  it('accepts only sk_test_ and rk_test_', () => {
    expect(isTestKey('sk_test_abc')).toBe(true);
    expect(isTestKey('rk_test_abc')).toBe(true);
    for (const k of ['sk_live_abc', 'rk_live_abc', 'pk_test_abc', '', undefined, 'sk_test']) expect(isTestKey(k)).toBe(false);
  });
  it('refuses a live key with a clear error and never calls Stripe or echoes the key', () => {
    const f = fakeStripe();
    let err: unknown;
    try { createStripeClient('sk_live_SECRETVALUE', f.fetchFn); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StripeKeyError);
    expect((err as Error).message).toMatch(/TEST keys.*live key was refused/);
    expect((err as Error).message).not.toContain('SECRETVALUE');
    expect(f.requests).toHaveLength(0);
  });
  it('refuses a missing key', () => { expect(() => createStripeClient(undefined)).toThrow(/not set/); });
});

describe('formEncode', () => {
  it('encodes nested objects and arrays the way Stripe expects', () => {
    expect(decodeURIComponent(formEncode({ a: 1, b: { c: 'x y' }, d: ['p', 'q'], e: false, f: null, g: undefined })))
      .toBe('a=1&b[c]=x y&d[0]=p&d[1]=q&e=false');
  });
});

describe('client', () => {
  it('sends a bearer key, a form body and the idempotency key', async () => {
    const f = fakeStripe();
    const c = createStripeClient('sk_test_k', f.fetchFn);
    await c.post('/v1/customers', { name: 'Lot 1' }, 'key-1');
    expect(f.requests[0].headers).toMatchObject({ Authorization: 'Bearer sk_test_k', 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': 'key-1' });
    expect(f.requests[0].body.get('name')).toBe('Lot 1');
  });
  it('marks 429 and 5xx as retryable, and 4xx as not', async () => {
    const mk = (status: number) => createStripeClient('sk_test_k', fakeStripe({ failOn: () => ({ status }) }).fetchFn).post('/v1/x', {}, 'k');
    await expect(mk(503)).rejects.toMatchObject({ retryable: true });
    await expect(mk(429)).rejects.toMatchObject({ retryable: true });
    await expect(mk(400)).rejects.toMatchObject({ retryable: false });
    await expect(mk(400)).rejects.toBeInstanceOf(StripeApiError);
  });
  it('treats a network failure as retryable', async () => {
    const c = createStripeClient('sk_test_k', async () => { throw new Error('down'); });
    await expect(c.get('/v1/invoices')).rejects.toMatchObject({ retryable: true });
  });
});
