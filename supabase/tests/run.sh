#!/usr/bin/env bash
# Throwaway Postgres 16 harness: migrations + seed + SQL tests, then mutation checks.
# Usage: bash supabase/tests/run.sh [--no-mutations]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SUPA="$(dirname "$HERE")"
PGBIN=/usr/lib/postgresql/16/bin
PORT="${PGPORT_TEST:-54329}"
WORK="$(mktemp -d /tmp/hoa-pg.XXXXXX)"
DATA="$WORK/data"
RUNAS=()
if [ "$(id -u)" = 0 ]; then
  id postgres >/dev/null 2>&1 || useradd -r -m postgres
  chown postgres "$WORK"
  RUNAS=(su postgres -s /bin/bash -c)
fi
as_pg() { if [ ${#RUNAS[@]} -gt 0 ]; then "${RUNAS[@]}" "$*"; else bash -c "$*"; fi; }
cleanup() { as_pg "$PGBIN/pg_ctl -D $DATA stop -m immediate >/dev/null 2>&1"; rm -rf "$WORK"; }
trap cleanup EXIT
fail=0
PSQL="$PGBIN/psql -X -q -h $WORK -p $PORT -U postgres -v ON_ERROR_STOP=1"

as_pg "$PGBIN/initdb -D $DATA -U postgres --auth=trust >/dev/null" || { echo "initdb failed"; exit 1; }
as_pg "$PGBIN/pg_ctl -D $DATA -l $WORK/log -w -o \"-c listen_addresses='' -c unix_socket_directories=$WORK -p $PORT -c fsync=off\" start >/dev/null" \
  || { echo "server start failed"; cat "$WORK/log"; exit 1; }

# build_db <name> <migrations dir>: fresh database with stand-ins, every migration in order, seed, helpers
build_db() {
  local args=() m
  for m in "$2"/*.sql; do args+=(-f "$m"); done
  $PSQL -d postgres -c "create database $1" || return 1
  $PSQL -d "$1" -f "$HERE/stand_in.sql" "${args[@]}" -f "$SUPA/seed/sample.sql" -f "$HERE/helpers.sql" || return 1
}
# run_suite <db>: every tests/sql/*.sql; prints failures, returns non-zero on any
run_suite() {
  local rc=0 f out
  for f in "$HERE"/sql/*.sql; do
    out=$($PSQL -d "$1" -f "$f" 2>&1) && echo "PASS $(basename "$f") ($(grep -c 'ok - ' <<<"$out") assertions)" \
      || { echo "FAIL $(basename "$f")"; grep -E 'ASSERTION|ERROR|DETAIL|CONTEXT' <<<"$out" | head -8; rc=1; }
  done
  return $rc
}
# the harness reads notices: psql -q still prints NOTICE lines to stderr, captured above via 2>&1

echo "== build database =="
build_db main "$SUPA/migrations" || { echo "migration/seed failed"; exit 1; }
echo "== tests =="
run_suite main || fail=1

# Idempotency of data volume sanity
n=$($PSQL -d main -Atc "select count(*) from public.lots") ; [ "$n" = 150 ] || { echo "FAIL seed has $n lots"; fail=1; }

if [ "${1:-}" != "--no-mutations" ]; then
  echo "== mutation checks (each must make the suite FAIL) =="
  # name|migration file|perl substitution applied to a scratch copy of that migration
  mutations=(
    "documents audience guard removed|0003_access.sql|s/or audience = 'public'\s+or \(audience = 'owners' and public\.is_owner\(\)\)/or true/"
    "invoices policy opened to all|0001_init.sql|s/create policy invoices_select on public.invoices for select\s+using \(public.is_board\(\) or lot_id in \(select public.my_lot_ids\(\)\)\)/create policy invoices_select on public.invoices for select using (true)/"
    "same-user check guard removed (function + constraint)|0001_init.sql|s/if v_row.logged_by = auth.uid\(\) then/if false then/; s/check \(deposit_confirmed_by is null or deposit_confirmed_by <> logged_by\),//"
    "ledger external_ref unique removed|0001_init.sql|s/unique \(external_ref\)//; s/check \(kind not in \('charge','refund'\) or amount_cents >= 0\),/check (kind not in ('charge','refund') or amount_cents >= 0)/"
    "former board member still counts as board|0001_init.sql|s/ and b\.active\)/)/"
    "claim rate limit removed|0003_access.sql|s/if v_recent >= 5 then/if false then/"
    "claim per-code limit removed|0003_access.sql|s/if v_recent >= 3 then/if false then/"
    "claim global hourly cap removed|0003_access.sql|s/if v_recent >= 100 then/if false then/"
    "lot_balances subtracts processing payments|0001_init.sql|s/ and not \(e\.status = 'processing' and e\.amount_cents < 0\)//"
    "board_tasks direct update re-granted|0003_access.sql|s/revoke insert, update on public\.board_tasks from authenticated;//"
    "default privileges left open to anon|0003_access.sql|s/revoke all on (tables|sequences|functions) from anon, authenticated/grant all on \$1 to anon, authenticated/g"
    "storage read ignores document audience|0003_access.sql|s/or exists \(select 1 from public\.documents d where d\.storage_path = storage\.objects\.name\)/or true/"
    "consent history not written|0003_access.sql|s/if v_old\.email_notice_consent is distinct from/if false and v_old.email_notice_consent is distinct from/"
    "owner writes not audited|0003_access.sql|s/if auth\.uid\(\) is null and/if true or auth.uid() is null and/"
    "roster link does not notify the board|0003_access.sql|s/where o\.id = any \(v_new\)/where false/"
    "settle-update broken (settled payment never leaves processing)|0004_gaps.sql|s/where public\.ledger_status_rank\(excluded\.status\) > public\.ledger_status_rank\(public\.ledger_entries\.status\)/where false/"
    "status can move backwards|0004_gaps.sql|s/where public\.ledger_status_rank\(excluded\.status\) > public\.ledger_status_rank\(public\.ledger_entries\.status\)//"
    "duplicate event ids not recorded|0004_gaps.sql|s/if exists \(select 1 from public\.processed_events where id = p_event_id\) then/if false then/; s/on conflict \(id\) do nothing;\n  get diagnostics v_n = row_count;\n  if v_n = 0 then/on conflict (id) do nothing;\n  v_n := 1;\n  if v_n = 0 then/"
    "check deposit leaves the invoice open|0004_gaps.sql|s/update public\.invoices set status = 'paid', paid_outside_stripe = true, paid_on = current_date where id = v_inv\.id;//"
    "same-user check guard removed in the live function|0004_gaps.sql|s/if v_row.logged_by = auth.uid\(\) then/if false then/"
    "dismiss closes check_confirm and claim_attach tasks|0004_gaps.sql|s/if p_action = 'dismiss' and v_task\.kind in \('check_confirm','claim_attach'\) then/if false then/"
    "returned check leaves its payment row cleared|0004_gaps.sql|s/set status = 'returned', detail = 'Check ' \|\| v_check\.check_number \|\| ', returned by the bank'/set status = 'cleared', detail = 'Check ' || v_check.check_number || ', returned by the bank'/"
    "returned check does not reopen the invoice|0004_gaps.sql|s/set status = 'open', paid_on = null, paid_outside_stripe = false/set status = status/"
    "returned check opens no board task|0004_gaps.sql|s/values \('payment_returned', v_check\.lot_id/values ('roster_change', v_check.lot_id/"
    "mark_check_returned open to non-board users|0004_gaps.sql|s/(create function public\.mark_check_returned.*?)if not public\.is_board\(\) then/\$1if false then/s"
    "mark_check_returned executable by anon|0004_gaps.sql|s/grant execute on function public\.mark_check_returned\(uuid, text\) to authenticated, service_role;/grant execute on function public.mark_check_returned(uuid, text) to public;/"
    "won dispute does not clear the payment|0004_gaps.sql|s/set status = 'cleared', description = v_item ->> 'description'/set status = 'returned', description = v_item ->> 'description'/"
    "won dispute marks the invoice paid even with nothing to reinstate|0004_gaps.sql|s/if v_reinst_asked and v_reinst_done = 0 then v_status := null; end if;//"
    "dispute reinstate also revives ACH-returned payments|0004_gaps.sql|s/ and description = 'Payment disputed';/;/"
    "bill run does not list lots with processing payments|0004_gaps.sql|s/if coalesce\(\(v_d ->> 'processing_cents'\)::bigint, 0\) > 0 then/if false then/"
  )
  i=0
  for m in "${mutations[@]}"; do
    i=$((i+1)); name="${m%%|*}"; rest="${m#*|}"; target="${rest%%|*}"; expr="${rest#*|}"
    mkdir "$WORK/mut$i" && cp "$SUPA"/migrations/*.sql "$WORK/mut$i/"
    perl -0pi -e "$expr" "$WORK/mut$i/$target"
    if cmp -s "$SUPA/migrations/$target" "$WORK/mut$i/$target"; then
      echo "MUTATION NOT APPLIED: $name"; fail=1; continue
    fi
    if ! build_db "mut$i" "$WORK/mut$i" >/dev/null 2>&1; then
      echo "MUTATION BROKE THE BUILD (does not prove the guard): $name"; fail=1; continue
    fi
    if run_suite "mut$i" >"$WORK/mut$i.out" 2>&1; then
      echo "MUTATION SURVIVED (suite still passes): $name"; fail=1
    else
      echo "caught: $name  <- $(grep -m1 -E 'ASSERTION' "$WORK/mut$i.out" | cut -c1-110)"
    fi
  done
fi

[ $fail = 0 ] && echo "ALL OK" || echo "FAILED"
exit $fail
