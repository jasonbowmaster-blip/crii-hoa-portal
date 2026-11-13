# Edge Functions

Deno functions. The logic lives in `_shared/` as plain TypeScript with Vitest tests
(`npx vitest run supabase`); the `index.ts` files are thin handlers. Nothing here is
deployed yet and no function sends real email or talks to a live payment account. `scripts/setup-test-project.mjs` deploys them to a test project; see `docs/SETUP-TEST.md`.

| Function | What it does | Secrets (Deno.env) |
|---|---|---|
| `stripe-webhook` | Verifies the Stripe signature, then posts payments, processing bank payments, returns, refunds and disputes to the ledger, with a board task for returns. Idempotent. | `STRIPE_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `bill-run` | Board only (checked with the caller's JWT via `is_board()`). `dry_run:true` returns the preview; otherwise saves invoice drafts. Refuses `sk_live_` keys unless `ALLOW_LIVE=true`. | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY` (only for the live-key guard), `ALLOW_LIVE` |
| `bill-send` | Board only. Creates and finalizes a Stripe invoice for each saved invoice that has none (test keys only; a live key is refused). Never asks Stripe to email it. Saves `stripe_invoice_id` and the payment link. Safe to re-run. Body: `{year, numbers?, dry_run?}`. | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `PORTAL_ORIGIN` |
| `stripe-outbox` | Schedule (every 10 minutes, service key as bearer). Marks invoices paid out of band in Stripe (test keys only) for confirmed check deposits. | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY` |
| `message-to-inbox` | Builds the `[Lot 42][Billing] ...` email for the HOA inbox. Uses a stub sender that only logs. | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `HOA_INBOX_ADDRESS` |
| `nightly-export` | Writes every table as CSV and JSON to the private `backups` storage bucket under a dated folder. | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |

Database needs (for the migrations lane): a unique constraint on `ledger_entries.external_ref`,
on `invoices.number`, an `is_board()` function, and a private `backups` storage bucket.

## Deploy later (test mode first)

```
supabase secrets set STRIPE_WEBHOOK_SECRET=... STRIPE_SECRET_KEY=sk_test_... HOA_INBOX_ADDRESS=...
supabase functions deploy stripe-webhook --no-verify-jwt   # Stripe cannot send a JWT; the signature is the check
supabase functions deploy bill-run
supabase functions deploy message-to-inbox
supabase functions deploy nightly-export
```

Point the Stripe test-mode webhook at `https://<project>.functions.supabase.co/stripe-webhook`.
Never put a secret in `web/`; `npm run check:secrets` fails the build if one appears.
