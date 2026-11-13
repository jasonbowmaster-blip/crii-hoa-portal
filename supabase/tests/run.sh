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

# build_db <name> <migration file>: fresh database with stand-ins, migration, seed, helpers
build_db() {
  $PSQL -d postgres -c "create database $1" || return 1
  $PSQL -d "$1" -f "$HERE/stand_in.sql" -f "$2" -f "$SUPA/seed/sample.sql" -f "$HERE/helpers.sql" || return 1
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
build_db main "$SUPA/migrations/0001_init.sql" || { echo "migration/seed failed"; exit 1; }
echo "== tests =="
run_suite main || fail=1

# Idempotency of data volume sanity
n=$($PSQL -d main -Atc "select count(*) from public.lots") ; [ "$n" = 150 ] || { echo "FAIL seed has $n lots"; fail=1; }

if [ "${1:-}" != "--no-mutations" ]; then
  echo "== mutation checks (each must make the suite FAIL) =="
  # name | perl substitution applied to a scratch copy of the migration
  mutations=(
    "documents audience guard removed|s/\(not is_draft and \(audience = 'public' or \(audience = 'owners' and public.is_owner\(\)\)\)\)/true/"
    "invoices policy opened to all|s/create policy invoices_select on public.invoices for select\s+using \(public.is_board\(\) or lot_id in \(select public.my_lot_ids\(\)\)\)/create policy invoices_select on public.invoices for select using (true)/"
    "same-user check guard removed (function + constraint)|s/if v_row.logged_by = auth.uid\(\) then/if false then/; s/check \(deposit_confirmed_by is null or deposit_confirmed_by <> logged_by\),//"
    "ledger external_ref unique removed|s/unique \(external_ref\)//; s/check \(kind not in \('charge','refund'\) or amount_cents >= 0\),/check (kind not in ('charge','refund') or amount_cents >= 0)/"
    "former board member still counts as board|s/ and b\.active\)/)/"
    "claim rate limit removed|s/if v_recent >= 5 then/if false then/"
    "lot_balances subtracts processing payments|s/ and not \(e\.status = 'processing' and e\.amount_cents < 0\)//"
  )
  i=0
  for m in "${mutations[@]}"; do
    i=$((i+1)); name="${m%%|*}"; expr="${m#*|}"
    cp "$SUPA/migrations/0001_init.sql" "$WORK/mut$i.sql"
    perl -0pi -e "$expr" "$WORK/mut$i.sql"
    if cmp -s "$SUPA/migrations/0001_init.sql" "$WORK/mut$i.sql"; then
      echo "MUTATION NOT APPLIED: $name"; fail=1; continue
    fi
    if ! build_db "mut$i" "$WORK/mut$i.sql" >/dev/null 2>&1; then
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
