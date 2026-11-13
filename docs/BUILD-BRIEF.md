# Build brief (for every worker lane)

You are building one lane of a private prototype of an HOA-owned owner portal for a
150-home Virginia HOA. Target: a working private prototype for the board's Nov 19, 2026
meeting. **Sample data only. No real names, emails or addresses. No network calls to
real services. Do not deploy, create accounts or send anything.**

Read first:
- `docs/implementation-plan-rev37.md`: the reviewed plan (flows 1-5, Data and integrations,
  Security). Launch scope = sign-in, home, My bill with lot ledger, Documents, Message,
  board view, nightly backup. ARB, Lob webhooks, Gmail sync, iCal come later.
- `docs/mockups/*.dc.html`: the 12 phone mock-ups (look and wording to match).
- `web/src/data/types.ts` and `web/src/data/api.ts`: **the shared contract. Do not change
  them.** If you truly need a change, stop and report it in your final message instead.
- `web/src/theme.css`: shared CSS classes and tokens. Use these classes; add lane-local CSS
  only in your own files (a `*.css` next to your screens) if needed.
- `web/src/lib/ledger.ts`: balance rules, money formatting, business-day helpers. Reuse them.

Stack: Vite 8 + React 19 + TypeScript (strict) + react-router 7 (HashRouter), Vitest 5 with
jsdom and @testing-library/react. Supabase (Postgres 16, row-level security, Edge Functions
in Deno/TypeScript). Node 22. `npm test` runs Vitest; `npx tsc -p web/tsconfig.json` type-checks.

Rules:
- Stay inside the paths your lane owns. Other lanes are writing other folders right now.
  Never run `git add -A`, `git stash`, `git checkout -- .` or any git write; the
  orchestrator commits.
- Money is integer cents. Never handle card or bank numbers.
- Owner-facing text never names a vendor (Stripe, Lob, Supabase...). Say "bank payment",
  "card", "the board", "board@[our domain]".
- Placeholders stay in brackets: [HOA name], [our domain], [HOA phone]; read them from
  `web/src/config.ts`.
- Plain, friendly wording, full sentences, no emoji. Accessible: real buttons/links/labels,
  44px touch targets, aria-live for results, works at 360px wide, light and dark themes.
- Write tests for your lane and make them pass. Keep code simple and readable: a future
  volunteer maintainer must understand it.
- Your final message: what you built (file list), how you tested it (exact commands and
  results), anything left undone, and any contract change you needed.
