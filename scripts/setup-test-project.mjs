#!/usr/bin/env node
// One command that stands the portal up in the HOA's own FREE Supabase project with a Stripe TEST account:
//   HOA_SUPABASE_ACCESS_TOKEN=sbp_... HOA_STRIPE_TEST_KEY=sk_test_... node scripts/setup-test-project.mjs
//   add --dry-run first to see every request it would make (no network, nothing written).
// Options: --org <slug> (required if the token sees several orgs)   --portal-origin <url> (default http://localhost:5173)
//          --name <project name> (default hoa-portal-test)           --skip-deploy (do not deploy edge functions)
// Safe to re-run: finished steps are skipped. Node 22, no dependencies. Secrets are only read from the environment,
// never written to a file (web/.env.local gets the PUBLIC key only) and never printed.
//
// ENDPOINT STATUS. Management API paths and bodies below were checked on 2026-11-13 against the public OpenAPI
// description at https://api.supabase.com/api/v1-json (field names, enums, required fields). Nothing has been
// run against a real account yet, so response details are untested: see the "UNVERIFIED" notes.
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = 'https://api.supabase.com/v1';
const STRIPE_API = 'https://api.stripe.com';
export const DEFAULT_NAME = 'hoa-portal-test';
export const REGION = 'us-east-1';
export const FUNCTIONS = ['stripe-webhook', 'bill-run', 'bill-send', 'message-to-inbox', 'nightly-export', 'stripe-outbox'];
// stripe-webhook cannot carry a JWT (Stripe signs instead); the others keep gateway JWT checks.
const NO_VERIFY_JWT = new Set(['stripe-webhook']);
// Every event type supabase/functions/_shared/stripe.ts (mapStripeEvent) handles. A unit test keeps this list in step.
export const WEBHOOK_EVENTS = [
  'invoice.paid', 'invoice.payment_failed', 'invoice.voided',
  'payment_intent.succeeded', 'payment_intent.processing', 'payment_intent.payment_failed',
  'refund.created', 'refund.updated', 'charge.refund.updated', 'charge.refunded',
  'charge.dispute.created', 'charge.dispute.closed',
];
const PLACEHOLDER_WEBHOOK_SECRET = 'whsec_placeholder_replaced_by_setup';
const SAFE_VALUE = /^[A-Za-z0-9._:\/@+=-]+$/;   // what may be put inside a SQL string by this script

export const isTestKey = (k) => typeof k === 'string' && (k.startsWith('sk_test_') || k.startsWith('rk_test_'));

class SetupError extends Error {}

export function parseArgs(argv) {
  const o = { dryRun: false, org: null, name: DEFAULT_NAME, portalOrigin: 'http://localhost:5173', skipDeploy: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--skip-deploy') o.skipDeploy = true;
    else if (a === '--org') o.org = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--portal-origin') o.portalOrigin = argv[++i];
    else throw new SetupError(`Unknown option ${a}`);
  }
  return o;
}

const here = dirname(fileURLToPath(import.meta.url));

export async function main(argv, env, deps = {}) {
  const root = deps.root ?? resolve(here, '..');
  const doFetch = deps.fetch ?? fetch;
  const out = deps.log ?? ((s) => console.log(s));
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const run = deps.run ?? ((cmd, args, opts) => spawnSync(cmd, args, { stdio: 'inherit', ...opts }));
  const write = deps.writeFile ?? writeFileSync;
  const opts = parseArgs(argv);
  const dry = opts.dryRun;

  const token = env.HOA_SUPABASE_ACCESS_TOKEN;
  const stripeKey = env.HOA_STRIPE_TEST_KEY;
  // Everything printed goes through here, which blanks the secrets.
  const masked = [token, stripeKey].filter(Boolean);
  const log = (s) => out(masked.reduce((t, m) => t.split(m).join('***'), String(s)));

  // --- refuse before anything else -------------------------------------------------------------------------------
  if (stripeKey && !isTestKey(stripeKey)) {
    throw new SetupError('HOA_STRIPE_TEST_KEY is not a Stripe TEST key (it must start with sk_test_ or rk_test_). A live key was refused.');
  }
  if (!dry) {
    if (!token) throw new SetupError('Set HOA_SUPABASE_ACCESS_TOKEN (a Supabase personal access token).');
    if (!stripeKey) throw new SetupError('Set HOA_STRIPE_TEST_KEY (a Stripe sk_test_ or rk_test_ key).');
  } else {
    if (!token) log('note: HOA_SUPABASE_ACCESS_TOKEN is not set (fine for a dry run)');
    if (!stripeKey) log('note: HOA_STRIPE_TEST_KEY is not set (fine for a dry run)');
  }
  if (!/^https?:\/\/[^\s,]+(,https?:\/\/[^\s,]+)*$/.test(opts.portalOrigin) || !SAFE_VALUE.test(opts.portalOrigin.replace(/,/g, ''))) {
    throw new SetupError('--portal-origin must be one or more http(s) origins separated by commas.');
  }

  // --- request helpers -------------------------------------------------------------------------------------------
  const brief = (b) => (b === undefined ? '' : ' ' + JSON.stringify(b).replace(/\s+/g, ' ').slice(0, 160));
  async function request(label, url, init, dryValue) {
    if (dry) { log(`DRY  ${init.method} ${url}${label}`); return dryValue; }
    const res = await doFetch(url, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const msg = json?.message ?? json?.error?.message ?? text.slice(0, 200);
      throw new SetupError(`${init.method} ${url} failed (${res.status}): ${msg}`);
    }
    return json;
  }
  // `shown` is what the log may print for the body (secret values blanked); the real body is always `body`.
  const sb = (method, path, body, dryValue, shown = body) => request(brief(shown), `${API}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, dryValue);
  const stripe = (method, path, form, dryValue) => request(form ? ' ' + [...new URLSearchParams(form).keys()].join(',') : '', `${STRIPE_API}${path}`, {
    method, headers: { Authorization: `Bearer ${stripeKey ?? ''}`, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  }, dryValue);

  const summary = [];
  let failed = false;

  // --- 1. organization -------------------------------------------------------------------------------------------
  const orgs = await sb('GET', '/organizations', undefined, [{ slug: opts.org ?? '<only-org-slug>', name: '(dry run)' }]);
  let org;
  if (opts.org) {
    org = orgs.find((o) => o.slug === opts.org);
    if (!org) throw new SetupError(`No organization "${opts.org}". This token sees: ${orgs.map((o) => o.slug).join(', ') || 'none'}.`);
  } else if (orgs.length === 1) org = orgs[0];
  else throw new SetupError(`This token sees ${orgs.length} organizations (${orgs.map((o) => o.slug).join(', ')}). Pass --org <slug>.`);

  // --- 2. project: find or create (FREE plan only) ---------------------------------------------------------------
  const projects = await sb('GET', '/projects', undefined, []);
  let project = projects.find((p) => p.name === opts.name && (!p.organization_slug || p.organization_slug === org.slug));
  let dbPassword = null;
  if (project && ['INACTIVE', 'PAUSING', 'PAUSE_FAILED', 'REMOVED', 'GOING_DOWN'].includes(project.status)) {
    throw new SetupError(`Project "${opts.name}" is ${project.status}. Restore it in the Supabase dashboard (free projects pause after a week of no use), then re-run.`);
  }
  if (!project) {
    // The plan belongs to the organization, not the project. UNVERIFIED: whether a free org that already holds two
    // projects answers 4xx or silently bills; we stop first when the org is not free, and the API refuses the rest.
    const detail = await sb('GET', `/organizations/${org.slug}`, undefined, { plan: 'free' });
    if (detail.plan !== 'free') {
      throw new SetupError(`Organization "${org.slug}" is on the "${detail.plan}" plan. This script only creates projects on a FREE organization, so it stopped without creating anything.`);
    }
    dbPassword = randomBytes(24).toString('base64url');
    // The generated password is sent once and is never stored; it is printed once at the end.
    const body = { name: opts.name, organization_slug: org.slug, db_pass: dbPassword, region_selection: { type: 'specific', code: REGION } };
    project = await sb('POST', '/projects', body, { ref: '<new-project-ref>', status: 'COMING_UP' }, { ...body, db_pass: '***' });
    summary.push(`created project ${opts.name}`);
  } else summary.push(`found project ${opts.name}`);
  const ref = project.ref ?? project.id;
  const projectUrl = `https://${ref}.supabase.co`;

  // --- 3. wait until healthy -------------------------------------------------------------------------------------
  if (!dry) {
    const deadline = Date.now() + (deps.waitMs ?? 15 * 60_000);
    for (;;) {
      const p = await sb('GET', `/projects/${ref}`);
      if (p.status === 'ACTIVE_HEALTHY') {
        // UNVERIFIED response shape: an array of { name, status }.
        const h = await sb('GET', `/projects/${ref}/health?services=auth,db,rest,storage`);
        if (Array.isArray(h) && h.every((s) => s.status === 'ACTIVE_HEALTHY')) break;
      } else if (['INIT_FAILED', 'REMOVED'].includes(p.status)) throw new SetupError(`Project ${ref} is ${p.status}.`);
      if (Date.now() > deadline) throw new SetupError(`Project ${ref} did not become healthy in time (last status ${p.status}). Re-run later.`);
      log(`waiting for project ${ref} (${p.status})...`);
      await sleep(5000);
    }
  } else {
    log(`DRY  GET ${API}/projects/${ref} until status is ACTIVE_HEALTHY, then GET ${API}/projects/${ref}/health?services=auth,db,rest,storage`);
  }

  // --- 4. keys: public one for the web app; the service key only goes into the project's own Vault -----------------
  const keys = await sb('GET', `/projects/${ref}/api-keys?reveal=true`, undefined,
    [{ name: 'anon', type: 'legacy', api_key: '<anon-key>' }, { name: 'service_role', type: 'legacy', api_key: '<service-role-key>' }]);
  const publicKey = (keys.find((k) => k.type === 'publishable') ?? keys.find((k) => k.name === 'anon'))?.api_key;
  const serviceKey = keys.find((k) => k.name === 'service_role')?.api_key;
  if (!publicKey) throw new SetupError('The project has no publishable or anon key.');
  if (serviceKey) masked.push(serviceKey);
  masked.push(...(dbPassword ? [dbPassword] : []));

  // --- database helper -------------------------------------------------------------------------------------------
  const sql = (label, query) => request(` [${label}]`, `${API}/projects/${ref}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  }, []);

  // --- 5. bookkeeping table, then migrations and seed, each once ---------------------------------------------------
  await sql('bookkeeping table', `
    create table if not exists public.setup_state (key text primary key, value text, applied_at timestamptz not null default now());
    alter table public.setup_state enable row level security;
    revoke all on public.setup_state from public, anon, authenticated;`);
  const state = new Map(((await sql('read bookkeeping', 'select key, value from public.setup_state')) ?? []).map((r) => [r.key, r.value]));

  // Extensions first, so 0007 can install the schedules. Failure is a warning: the schedules are optional for a test.
  try {
    await sql('extensions', 'create extension if not exists pg_cron; create extension if not exists pg_net; create extension if not exists supabase_vault;');
  } catch (e) { log(`warning: could not enable pg_cron / pg_net / vault (${e.message}). Enable them in Database > Extensions, then re-run.`); }

  const files = [
    ...readdirSync(join(root, 'supabase/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort().map((f) => ({ key: `migration:${f}`, path: join(root, 'supabase/migrations', f), name: f })),
    { key: 'seed:sample.sql', path: join(root, 'supabase/seed/sample.sql'), name: 'seed/sample.sql' },
  ];
  const applied = [];
  const skipped = [];
  for (const f of files) {
    if (state.has(f.key)) { skipped.push(f.name); log(`skip ${f.name} (already applied)`); continue; }
    const body = readFileSync(f.path, 'utf8');
    const record = `insert into public.setup_state (key, value) values ('${f.key}', 'ok') on conflict (key) do nothing;`;
    // A file with its own BEGIN/COMMIT (the seed) runs as it is; the others are wrapped so file and record land together.
    const query = /^\s*begin\s*;/im.test(body) ? `${body}\n${record}` : `begin;\n${body}\n${record}\ncommit;`;
    log(`apply ${f.name}`);
    try { await sql(f.name, query); } catch (e) { throw new SetupError(`${f.name} failed: ${e.message}\nNothing after it was applied. Fix the cause and re-run; finished files are skipped.`); }
    applied.push(f.name);
  }

  // --- 6. Vault secrets for the schedules, then install the schedules (safe to repeat) -----------------------------
  if (serviceKey && (dry || (SAFE_VALUE.test(serviceKey) && SAFE_VALUE.test(projectUrl)))) {
    const upsert = (name, value) => `if exists (select 1 from vault.secrets where name = '${name}') then
        perform vault.update_secret((select id from vault.secrets where name = '${name}'), '${value}');
      else perform vault.create_secret('${value}', '${name}'); end if;`;
    try {
      await sql('vault secrets (values hidden)', `do $v$ begin ${upsert('project_url', projectUrl)} ${upsert('service_role_key', serviceKey)} end $v$;`);
      const r = await sql('install schedules', 'select public.e2e_install_schedules() as result');
      summary.push(`schedules: ${r?.[0]?.result ?? '(dry run)'}`);
    } catch (e) { log(`warning: schedules not installed (${e.message}).`); summary.push('schedules: NOT installed (see warning)'); }
  } else {
    log('warning: no usable legacy service_role key from the API; schedules not installed. See docs/SETUP-TEST.md.');
    summary.push('schedules: NOT installed (no service key)');
  }

  // --- 7. function secrets ---------------------------------------------------------------------------------------
  const secretList = [{ name: 'STRIPE_SECRET_KEY', value: stripeKey ?? '<HOA_STRIPE_TEST_KEY>' }, { name: 'PORTAL_ORIGIN', value: opts.portalOrigin }];
  const markerKey = 'webhook_secret_set';
  const webhookUrl = `${projectUrl}/functions/v1/stripe-webhook`;
  // The placeholder is only written while no real webhook secret has been stored, so a re-run never overwrites it.
  if (!state.has(markerKey)) secretList.push({ name: 'STRIPE_WEBHOOK_SECRET', value: PLACEHOLDER_WEBHOOK_SECRET });
  await sb('POST', `/projects/${ref}/secrets`, secretList, undefined, secretList.map((x) => ({ name: x.name, value: x.name === 'PORTAL_ORIGIN' ? x.value : '***' })));
  summary.push('function secrets set (STRIPE_SECRET_KEY, PORTAL_ORIGIN' + (state.has(markerKey) ? ')' : ', STRIPE_WEBHOOK_SECRET placeholder)'));

  // --- 8. deploy edge functions ------------------------------------------------------------------------------------
  if (opts.skipDeploy) summary.push('functions: deploy skipped (--skip-deploy)');
  else {
    // supabase CLI 3.x calls the flag --remote=<ref> (--project-ref is deprecated, removed in 4.x); 2.x only knows --project-ref.
    const v = dry ? { stdout: '3.0.0' } : run('npx', ['--yes', 'supabase@latest', '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], cwd: root });
    const major = Number(String(v.stdout ?? '').trim().split('.')[0]) || 2;
    const refFlag = major >= 3 ? `--remote=${ref}` : `--project-ref=${ref}`;
    const results = [];
    for (const fn of FUNCTIONS) {
      const args = ['--yes', 'supabase@latest', 'functions', 'deploy', fn, refFlag, '--use-api', '--yes', ...(NO_VERIFY_JWT.has(fn) ? ['--no-verify-jwt'] : [])];
      if (dry) { log(`DRY  (in ${root}) SUPABASE_ACCESS_TOKEN=*** npx ${args.join(' ')}`); results.push(`${fn}: (dry run)`); continue; }
      log(`deploy ${fn}`);
      const r = run('npx', args, { cwd: root, env: { ...process.env, ...env, SUPABASE_ACCESS_TOKEN: token }, stdio: 'inherit' });
      if (r.status === 0) results.push(`${fn}: deployed`);
      else {
        failed = true;
        results.push(`${fn}: FAILED`);
        log(`warning: deploying ${fn} failed. Do it by hand from the repo root:\n  SUPABASE_ACCESS_TOKEN=<token> npx supabase@latest functions deploy ${fn} --remote=${ref} --use-api --yes${NO_VERIFY_JWT.has(fn) ? ' --no-verify-jwt' : ''}`);
      }
    }
    summary.push(...results.map((r) => `function ${r}`));
  }

  // --- 9. Stripe test webhook endpoint -----------------------------------------------------------------------------
  // The signing secret is shown by Stripe only when the endpoint is created. So: if an endpoint exists but we never
  // stored its secret, it is deleted and made again; if we did store it, it is left alone.
  const existing = (await stripe('GET', '/v1/webhook_endpoints?limit=100', undefined, { data: [] }))?.data ?? [];
  const mine = existing.find((e) => e.url === webhookUrl);
  if (mine && state.get(markerKey) === mine.id) {
    summary.push(`stripe webhook: already set up (${mine.id})`);
  } else {
    if (mine) await stripe('DELETE', `/v1/webhook_endpoints/${mine.id}`, undefined, {});
    const form = new URLSearchParams([['url', webhookUrl], ['description', 'HOA portal test'], ...WEBHOOK_EVENTS.map((e, i) => [`enabled_events[${i}]`, e])]);
    const created = await stripe('POST', '/v1/webhook_endpoints', form, { id: 'we_dry', secret: 'whsec_dry' });
    if (created.secret) masked.push(created.secret);
    try {
      await sb('POST', `/projects/${ref}/secrets`, [{ name: 'STRIPE_WEBHOOK_SECRET', value: created.secret }], undefined, [{ name: 'STRIPE_WEBHOOK_SECRET', value: '***' }]);
      await sql('remember webhook', `insert into public.setup_state (key, value) values ('${markerKey}', '${created.id}') on conflict (key) do update set value = excluded.value;`);
    } catch (e) {
      // Do not leave an endpoint whose secret we lost: the next run recreates it.
      if (!dry) await stripe('DELETE', `/v1/webhook_endpoints/${created.id}`, undefined, {}).catch(() => {});
      throw e;
    }
    summary.push(`stripe webhook: created ${created.id} -> ${webhookUrl} (${WEBHOOK_EVENTS.length} events)`);
  }

  // --- 10. web/.env.local (public values only) ---------------------------------------------------------------------
  const envFile = join(root, 'web/.env.local');
  const envText = `VITE_DATA_MODE=supabase\nVITE_SUPABASE_URL=${projectUrl}\nVITE_SUPABASE_ANON_KEY=${publicKey}\n`;
  if (dry) log(`DRY  write ${envFile} (VITE_DATA_MODE, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY; public key only)`);
  else write(envFile, envText, { mode: 0o600 });
  summary.push(dry ? 'would write web/.env.local' : 'wrote web/.env.local');

  // --- summary ---------------------------------------------------------------------------------------------------
  log('');
  log(dry ? '== dry run: nothing was sent or written ==' : '== done ==');
  log(`project:    ${opts.name} (${ref}) in ${REGION}   ${projectUrl}`);
  log(`dashboard:  https://supabase.com/dashboard/project/${ref}`);
  log(`database:   applied ${applied.length}, already applied ${skipped.length}`);
  for (const s of summary) log(`  - ${s}`);
  if (dbPassword && !dry) log(`\nDatabase password (shown once, not saved anywhere; put it in the HOA password manager):\n  ${dbPassword}`);
  log('\nNext: the dashboard steps in docs/SETUP-TEST.md (sign-in provider, redirect URLs), then: npm run dev');
  return { ref, applied, skipped, failed, projectUrl };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then((r) => { if (r.failed) process.exit(2); }, (e) => {
    console.error(e instanceof SetupError ? `Stopped: ${e.message}` : e);
    process.exit(1);
  });
}
