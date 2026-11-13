import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { main, WEBHOOK_EVENTS, FUNCTIONS, isTestKey, parseArgs } from './setup-test-project.mjs';

const ROOT = join(__dirname, '..');
const STRIPE = 'sk_test_FAKEKEY123';
const TOKEN = 'sbp_FAKETOKEN123';
const ENV = { HOA_SUPABASE_ACCESS_TOKEN: TOKEN, HOA_STRIPE_TEST_KEY: STRIPE };
const collect = () => { const lines = []; return { lines, log: (s) => lines.push(s) }; };
const neverFetch = () => { throw new Error('network used'); };
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status });

// A fake of just enough of the Management API and Stripe to run the whole script twice.
function fakeWorld(opts = {}) {
  const calls = []; const queries = []; const state = new Map(); let secrets = {}; let project = opts.project ?? null; let webhooks = [];
  const fetch = async (url, init) => {
    const u = new URL(url); const m = init.method; const body = init.body && typeof init.body === 'string' && init.body.startsWith('[') || init.body?.startsWith?.('{') ? JSON.parse(init.body) : init.body;
    calls.push({ m, url, body, headers: init.headers });
    if (u.host === 'api.stripe.com') {
      if (m === 'GET') return jsonRes({ data: webhooks });
      if (m === 'DELETE') { webhooks = webhooks.filter((w) => !url.endsWith(w.id)); return jsonRes({ deleted: true }); }
      const id = `we_${webhooks.length + 1}`; const p = new URLSearchParams(body);
      webhooks.push({ id, url: p.get('url') }); return jsonRes({ id, secret: 'whsec_REALSECRET', url: p.get('url') });
    }
    const path = u.pathname.replace('/v1', '');
    if (path === '/organizations') return jsonRes(opts.orgs ?? [{ slug: 'hoa-org', name: 'HOA' }]);
    if (path.startsWith('/organizations/')) return jsonRes({ plan: opts.plan ?? 'free' });
    if (path === '/projects' && m === 'GET') return jsonRes(project ? [project] : []);
    if (path === '/projects' && m === 'POST') { project = { ref: 'abcdefghijklmnopqrst', name: body.name, organization_slug: body.organization_slug, status: 'COMING_UP' }; return jsonRes(project); }
    if (path.endsWith('/health')) return jsonRes(['auth', 'db', 'rest', 'storage'].map((name) => ({ name, status: 'ACTIVE_HEALTHY' })));
    if (path === `/projects/${project?.ref}`) { project.status = 'ACTIVE_HEALTHY'; return jsonRes(project); }
    if (path.endsWith('/api-keys')) return jsonRes([{ name: 'anon', type: 'legacy', api_key: 'ANON.PUBLIC.KEY' }, { name: 'service_role', type: 'legacy', api_key: 'SERVICE.ROLE.SECRETKEY' }]);
    if (path.endsWith('/secrets')) { for (const s of body) secrets[s.name] = s.value; return jsonRes({}); }
    if (path.endsWith('/database/query')) {
      const q = body.query; queries.push(q);
      if (q.includes('select key, value from public.setup_state')) return jsonRes([...state].map(([key, value]) => ({ key, value })));
      for (const mm of q.matchAll(/insert into public\.setup_state \(key, value\) values \('([^']+)', '([^']+)'\)/g)) state.set(mm[1], mm[2]);
      if (q.includes('e2e_install_schedules')) return jsonRes([{ result: 'installed' }]);
      return jsonRes([]);
    }
    return jsonRes({ message: `unexpected ${m} ${url}` }, 404);
  };
  return { fetch, calls, queries, secrets: () => secrets, webhooks: () => webhooks };
}

const base = (extra = {}) => {
  const out = collect(); const writes = []; const runs = [];
  return { out, writes, runs, deps: { fetch: neverFetch, log: out.log, sleep: async () => {}, writeFile: (...a) => writes.push(a),
    run: (cmd, args, o) => { runs.push([cmd, args, o]); return { status: 0, stdout: '3.1.0' }; }, root: ROOT, ...extra } };
};

describe('dry run', () => {
  it('prints every request, makes none, writes nothing, and hides secrets', async () => {
    const b = base();
    await main(['--dry-run'], ENV, b.deps);   // fetch is neverFetch: any network call would throw
    const text = b.out.lines.join('\n');
    expect(b.writes).toEqual([]);
    expect(b.runs).toEqual([]);   // not even the supabase CLI version check
    expect(text).not.toContain(STRIPE);
    expect(text).not.toContain(TOKEN);
    for (const want of ['GET https://api.supabase.com/v1/organizations', 'POST https://api.supabase.com/v1/projects ', '/database/query', '/secrets',
      'GET https://api.stripe.com/v1/webhook_endpoints', 'POST https://api.stripe.com/v1/webhook_endpoints', '/api-keys', 'region_selection', 'us-east-1']) {
      expect(text).toContain(want);
    }
    const sqlFiles = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql'));
    expect(sqlFiles).toContain('0007_e2e.sql');
    for (const f of sqlFiles) expect(text).toContain(`[${f}]`);
    expect(text).toContain('[seed/sample.sql]');
    for (const fn of FUNCTIONS) expect(text).toContain(`functions deploy ${fn} `);
    expect(text).toMatch(/deploy stripe-webhook .*--no-verify-jwt/);
    expect(text).not.toMatch(/deploy bill-send .*--no-verify-jwt/);
  });
  it('still refuses a live Stripe key', async () => {
    await expect(main(['--dry-run'], { HOA_STRIPE_TEST_KEY: 'sk_live_abc' }, base().deps)).rejects.toThrow(/live key was refused/);
  });
});

describe('guards', () => {
  it('refuses a live or non-test Stripe key before any request', async () => {
    for (const k of ['sk_live_abc', 'rk_live_abc', 'pk_test_abc']) {
      await expect(main([], { ...ENV, HOA_STRIPE_TEST_KEY: k }, base().deps)).rejects.toThrow(/TEST key/);
    }
  });
  it('needs both environment variables', async () => {
    await expect(main([], { HOA_STRIPE_TEST_KEY: STRIPE }, base().deps)).rejects.toThrow(/HOA_SUPABASE_ACCESS_TOKEN/);
    await expect(main([], { HOA_SUPABASE_ACCESS_TOKEN: TOKEN }, base().deps)).rejects.toThrow(/HOA_STRIPE_TEST_KEY/);
  });
  it('asks for --org when the token sees several organizations', async () => {
    const w = fakeWorld({ orgs: [{ slug: 'a', name: 'A' }, { slug: 'b', name: 'B' }] });
    await expect(main([], ENV, base({ fetch: w.fetch }).deps)).rejects.toThrow(/--org/);
    expect(w.calls.some((c) => c.m === 'POST')).toBe(false);
  });
  it('refuses to create a project in an organization that is not on the free plan', async () => {
    const w = fakeWorld({ plan: 'pro' });
    await expect(main([], ENV, base({ fetch: w.fetch }).deps)).rejects.toThrow(/FREE/);
    expect(w.calls.some((c) => c.m === 'POST' && c.url.endsWith('/projects'))).toBe(false);
  });
  it('stops on a paused project instead of waiting forever', async () => {
    const w = fakeWorld({ project: { ref: 'abcdefghijklmnopqrst', name: 'hoa-portal-test', status: 'INACTIVE' } });
    await expect(main([], ENV, base({ fetch: w.fetch }).deps)).rejects.toThrow(/Restore it/);
  });
  it('parseArgs rejects unknown options', () => { expect(() => parseArgs(['--wat'])).toThrow(/Unknown option/); });
});

describe('a real run (fake services)', () => {
  it('sets everything up, then a second run skips finished work and keeps the webhook secret', async () => {
    const w = fakeWorld();
    const b = base({ fetch: w.fetch });
    const r1 = await main([], ENV, b.deps);
    expect(r1.applied).toHaveLength(8);
    // the project was created free-plan, in the right region, with a generated password
    const create = w.calls.find((c) => c.m === 'POST' && c.url.endsWith('/projects'));
    expect(create.body).toMatchObject({ name: 'hoa-portal-test', organization_slug: 'hoa-org', region_selection: { type: 'specific', code: 'us-east-1' } });
    expect(create.body.db_pass.length).toBeGreaterThan(20);
    expect(create.body.plan).toBeUndefined();
    // secrets
    expect(w.secrets()).toMatchObject({ STRIPE_SECRET_KEY: STRIPE, PORTAL_ORIGIN: 'http://localhost:5173', STRIPE_WEBHOOK_SECRET: 'whsec_REALSECRET' });
    // webhook created with exactly the events the mapper handles
    const hook = w.calls.find((c) => c.m === 'POST' && c.url.includes('stripe.com'));
    const p = new URLSearchParams(hook.body);
    expect(p.get('url')).toBe('https://abcdefghijklmnopqrst.supabase.co/functions/v1/stripe-webhook');
    expect([...p].filter(([k]) => k.startsWith('enabled_events')).map(([, v]) => v)).toEqual(WEBHOOK_EVENTS);
    // migrations in order, each recorded
    const names = w.queries.filter((q) => q.includes("values ('migration:")).map((q) => /migration:(\S+?)'/.exec(q)[1]);
    expect(names).toEqual(['0001_init.sql', '0002_money.sql', '0003_access.sql', '0004_gaps.sql', '0005_review.sql', '0006_grok.sql', '0007_e2e.sql']);
    expect(w.queries.some((q) => q.includes('vault.create_secret'))).toBe(true);
    // .env.local: public key only
    const [path, text] = b.writes[0];
    expect(path.endsWith('web/.env.local')).toBe(true);
    expect(text).toBe('VITE_DATA_MODE=supabase\nVITE_SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co\nVITE_SUPABASE_ANON_KEY=ANON.PUBLIC.KEY\n');
    expect(text).not.toContain('SERVICE');
    // nothing secret in the log
    const log = b.out.lines.join('\n');
    for (const s of [STRIPE, TOKEN, 'SERVICE.ROLE.SECRETKEY', 'whsec_REALSECRET']) expect(log).not.toContain(s);
    // functions deployed with the 3.x flag
    expect(b.runs.filter(([, a]) => a.includes('deploy')).map(([, a]) => a[4])).toEqual(FUNCTIONS);
    expect(b.runs.find(([, a]) => a.includes('stripe-webhook'))[1]).toContain('--remote=abcdefghijklmnopqrst');

    // second run
    const before = w.calls.length;
    const b2 = base({ fetch: w.fetch });
    const r2 = await main([], ENV, b2.deps);
    expect(r2.applied).toEqual([]);
    expect(r2.skipped).toHaveLength(8);
    const second = w.calls.slice(before);
    expect(second.some((c) => c.m === 'POST' && c.url.endsWith('/projects'))).toBe(false);          // no second project
    expect(second.some((c) => c.m === 'POST' && c.url.includes('stripe.com'))).toBe(false);          // no second webhook
    expect(second.some((c) => c.m === 'DELETE')).toBe(false);
    expect(w.secrets().STRIPE_WEBHOOK_SECRET).toBe('whsec_REALSECRET');                              // not reset to the placeholder
    expect(w.webhooks()).toHaveLength(1);
  });
  it('recreates a webhook endpoint whose signing secret was never stored', async () => {
    const w = fakeWorld();
    await main([], ENV, base({ fetch: w.fetch }).deps);
    // pretend the stored marker was lost
    const lost = fakeWorld({ project: { ref: 'abcdefghijklmnopqrst', name: 'hoa-portal-test', status: 'ACTIVE_HEALTHY' } });
    const hook = { id: 'we_old', url: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/stripe-webhook' };
    const orig = lost.fetch;
    const fetch = async (url, init) => (url.includes('stripe.com') && init.method === 'GET' ? jsonRes({ data: [hook] }) : orig(url, init));
    await main([], ENV, base({ fetch }).deps);
    expect(lost.calls.some((c) => c.m === 'DELETE' && c.url.endsWith('/we_old'))).toBe(true);
    expect(lost.secrets().STRIPE_WEBHOOK_SECRET).toBe('whsec_REALSECRET');
  });
});

describe('constants', () => {
  it('lists exactly the event types the webhook mapper handles', () => {
    const src = readFileSync(join(ROOT, 'supabase/functions/_shared/stripe.ts'), 'utf8');
    const handled = [...src.matchAll(/case '([a-z_.]+)':/g)].map((m) => m[1]).filter((t) => t.includes('.'));
    expect([...WEBHOOK_EVENTS].sort()).toEqual([...new Set(handled)].sort());
  });
  it('key check matches the function-side rule', () => {
    expect(isTestKey('sk_test_a')).toBe(true);
    expect(isTestKey('sk_live_a')).toBe(false);
  });
  it('every deployed function exists', () => {
    const dirs = readdirSync(join(ROOT, 'supabase/functions'));
    for (const f of FUNCTIONS) expect(dirs).toContain(f);
  });
});
