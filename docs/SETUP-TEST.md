# Test setup: the HOA's own Supabase project and Stripe TEST account

Goal: stand the portal up on the sample data and watch a test payment reach an owner's balance.
Everything here is **test mode**. No real money, no real owner data, nothing is emailed to owners.

## What you need first

1. A free Supabase account owned by the HOA, and a **personal access token** (Account > Access Tokens).
2. A Stripe account owned by the HOA with **test mode** on, and a test secret key (`sk_test_...`, or a restricted `rk_test_...` key that can write Customers, Invoices, Invoice Items, Webhook Endpoints and Payment Intents).
3. Node 22 and this repository (`npm ci`).

## Run the script

```bash
export HOA_SUPABASE_ACCESS_TOKEN=sbp_...      # never commit this
export HOA_STRIPE_TEST_KEY=sk_test_...        # a live key is refused
node scripts/setup-test-project.mjs --dry-run # shows every request, sends nothing
node scripts/setup-test-project.mjs           # does it
```

Options: `--org <slug>` (needed only if the token sees several organizations), `--portal-origin <url>` (the address the
portal is served from, default `http://localhost:5173`; comma-separate several), `--name`, `--skip-deploy`.

It creates (or finds) the project `hoa-portal-test` in `us-east-1` and only on a **free** organization (it stops without
creating anything if the organization is on a paid plan), waits until it is healthy, applies the migrations and
`seed/sample.sql` once each (recorded in `public.setup_state`), stores the project address and service key in the
project's own Vault for the schedules, sets the function secrets, deploys the six edge functions, creates the Stripe test
webhook endpoint (and stores its signing secret), and writes `web/.env.local` with the **public** key only. Re-running is safe.
The database password is shown once at the end: put it in the HOA password manager.

If a function deploy fails (the script prints the exact command), run it by hand from the repository root:
`SUPABASE_ACCESS_TOKEN=... npx supabase@latest functions deploy <name> --remote=<ref> --use-api --yes`
(add `--no-verify-jwt` for `stripe-webhook` only). Older CLI versions spell `--remote=<ref>` as `--project-ref <ref>`.

Then `npm run dev` and open the address it prints.

## Dashboard steps the script cannot do

Supabase dashboard, project `hoa-portal-test`:

1. **Authentication > URL Configuration.** Site URL: the portal address (for local testing `http://localhost:5173`). Add the same
   address, and later the real portal address, under Redirect URLs. (The app uses a hash router, so the plain address is enough.)
2. **Authentication > Providers > Email.** Leave enabled. Magic links need no password. Turn **Confirm email** on.
3. **Authentication > Email Templates.** Change "Magic Link" to plain wording with the HOA name and no vendor names.
   Note: the built-in Supabase mailer is limited to a few messages an hour and only to team members' addresses.
   For testing, sign in with an address belonging to the HOA's Supabase team, or set up custom SMTP (Authentication > SMTP Settings) first.
4. **Authentication > Providers > Google.** Needs a Google OAuth client created in the HOA's own Google Cloud account
   (APIs & Services > Credentials > OAuth client ID, type Web). Authorized redirect URI: the callback shown on the Supabase Google provider page
   (`https://<ref>.supabase.co/auth/v1/callback`). Paste the client ID and secret into the provider page. Skip this for the first test; magic links are enough.
5. **Database > Extensions.** Confirm `pg_cron`, `pg_net` and `supabase_vault` are on (the script tries to enable them). If you turned them on later, re-run the script so the schedules are installed.
6. **Sample owners need sign-in addresses.** The sample owners use `example.com` addresses that do not receive mail. To sign in as one, in the
   SQL editor change that owner's `email` (and the matching `auth.users` row is created on first sign-in): for example
   `update public.owners set email = 'you+lot42@your-domain' where id = '10000000-0000-4000-8000-000000000042';`
   then sign in with that address. The first sign-in links the account to the owner by e-mail. Board members are rows 1 to 9 in `board_members`; point one of them at your own address the same way.
7. **Stripe dashboard (test mode).** Settings > Payment methods: make sure **ACH Direct Debit** and **Cards** are on. Settings > Billing > Invoices: leave automatic emails off (the portal does not ask Stripe to email invoices anyway).

## Create the Stripe invoices

The bill run saves drafts; the send step creates the Stripe invoices. Sample invoices for 2027 already exist. As a board member
(signed in; the function checks you are on the board), call `bill-send`. A first try on one lot:

```
POST https://<ref>.supabase.co/functions/v1/bill-send      Authorization: Bearer <board member's session token>
{ "year": 2027, "numbers": ["2027-042"], "dry_run": true }    // shows what would be sent
{ "year": 2027, "numbers": ["2027-042"] }                      // does it
```

(There is no screen for this yet; use the browser console on the board view with `supabase.functions.invoke('bill-send', { body })`.)
Each invoice is created and finalized in Stripe (not emailed) and the portal's bill gets a payment link. Running it again creates no duplicates.

## Test plan

Use lot 42's owner (or any lot with an open invoice that is not marked paid or processing in the seed; lots numbered as a multiple of 5 are already "paid", and lots with `n % 7 = 1` already show a "processing" bank payment).
After each step reload **My bill** and compare with the numbers in brackets.

1. **Sign in** as the sample owner by magic link. Home shows the balance. For lot 42 the 2027 charge is $175.00 and nothing is paid: balance **$175.00**.
2. **Open the bill** and press pay. You land on the Stripe page for that invoice.
3. **Bank payment succeeds (slow).** Choose US bank account. Use the Stripe test bank: routing **110000000**, account **000123456789**
   (Stripe's own test numbers). In test mode the payment shows **processing** first: the bill shows "Bank payment clearing" and the balance is **still $175.00**,
   with $175.00 shown as processing. After a few minutes (Stripe's test ACH settles after a short delay) the Stripe webhook arrives and the row turns **cleared**: balance **$0.00**, invoice **paid**.
   Watch Stripe Dashboard > Developers > Webhooks for 200 responses; any failure shows in `stripe_quarantine` (board view).
4. **Card payment.** Use a different lot with an open invoice. Pay by card `4242 4242 4242 4242`, any future expiry, any CVC and ZIP. It clears at once: balance **$0.00**.
5. **Returned bank payment.** On another lot choose US bank account and use one of the failing test accounts listed on Stripe's
   "Testing" page under ACH Direct Debit (look for the ones described as a payment that succeeds and is then returned or disputed, and the "account closed" / "no account" ones).
   I could not confirm the exact numbers from here; `000111111113` (account closed) and `000111111116` (no account) are the ones I remember, so check Stripe's page.
   Expected: the row shows processing, then **returned**; the balance goes back to the full amount, the invoice reopens, and the board gets a "payment returned" task.
   A payment that fails before it starts (payment_failed) must leave the balance unchanged.
6. **Paid outside Stripe.** As two different board members: log a check on a lot with a Stripe-linked invoice, then have the other member confirm the deposit.
   The balance drops, the invoice shows paid, and within ten minutes `stripe_outbox` shows the job `done` and Stripe marks the invoice paid out of band
   (or call `stripe-outbox` by hand with the service key).
7. **Nightly backup.** Call `nightly-export` once by hand (service key as bearer) and check the dated folder in Storage > backups; the schedule does it daily at 08:15 UTC (3:15 AM Eastern standard time, 4:15 AM daylight time).
8. **Messages.** Send a message as an owner. `message-to-inbox` runs from a database trigger; with the stub sender it only logs (Edge Functions > Logs).

At every step the balance in the portal must equal the ledger: charges minus cleared payments, ignoring processing ones.

## What was not verified against a live service

Nothing here has run against a real Supabase or Stripe account. See the notes at the top of `scripts/setup-test-project.mjs`.
