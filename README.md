# HOA owner portal

The HOA's own portal: owners sign in with Google or an emailed link (already set up from the
roster), see and pay their bill, find documents and meetings, and message the board. The board
gets one view for tasks, the inbox, lots, checks and the bill run. Payments, books and mail are
handled by specialist services behind the portal (Stripe, the books, Lob), which the board can
swap without owners noticing.

Status: **private prototype with sample data.** Nothing is deployed, no accounts exist, and no
real owner data is in this repository.

## Try it

```bash
npm install
npm run dev:demo        # http://localhost:5173 , sample data, nothing is sent
```

The bar at the top switches between the owner view and the board view.

## Check it

```bash
npm test                # unit and screen tests (Vitest)
npm run test:db         # builds a throwaway Postgres 16, applies the schema and seed,
                        # runs the row-level security tests, then mutation-checks the guards
npm run build           # type-check and build
npm run check:secrets   # fails if any secret key appears in the web app
```

## Layout

| Path | What it is |
| --- | --- |
| `web/src/data/types.ts`, `api.ts` | The contract every screen uses |
| `web/src/data/demo/` | In-browser sample backend for previews and tests |
| `web/src/data/supabase/` | The real backend adapter |
| `web/src/screens/owner/`, `board/` | Screens |
| `web/src/lib/` | Balance rules, business days, clock |
| `supabase/migrations/` | Schema and row-level security |
| `supabase/seed/` | Sample data (fake names, example.com emails) |
| `supabase/tests/` | Database security tests |
| `supabase/functions/` | Server functions: Stripe webhook, bill run, inbox, nightly export |
| `docs/` | Reviewed implementation plan, phone mock-ups, build brief |

## Rules that keep it safe

- Owners see only their own lot: enforced in the database, not just the screens.
- Card and bank details never touch this code; the portal stores links and status only.
- Secret keys live only in server-function settings, never in the web app.
- A check needs two people: one logs it, a different one confirms the deposit.
- Nothing is sent to owners from this prototype.
