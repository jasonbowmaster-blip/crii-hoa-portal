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
    "claim rate limit removed|0006_grok.sql|s/if v_recent >= 5 then/if false then/"
    "claim per-code limit removed|0006_grok.sql|s/if v_recent >= 3 then/if false then/"
    "claim global hourly cap removed|0006_grok.sql|s/if v_recent >= 100 then/if false then/"
    "lot_balances subtracts processing payments|0001_init.sql|s/ and not \(e\.status = 'processing' and e\.amount_cents < 0\)//"
    "board_tasks direct update re-granted|0003_access.sql|s/revoke insert, update on public\.board_tasks from authenticated;//"
    "default privileges left open to anon|0003_access.sql|s/revoke all on (tables|sequences|functions) from anon, authenticated/grant all on \$1 to anon, authenticated/g"
    "storage read ignores document audience|0003_access.sql|s/or exists \(select 1 from public\.documents d where d\.storage_path = storage\.objects\.name\)/or true/"
    "consent history not written|0003_access.sql|s/if v_old\.email_notice_consent is distinct from/if false and v_old.email_notice_consent is distinct from/"
    "owner and board writes not audited|0005_review.sql|s/if auth\.uid\(\) is not null then\n    v_role := 'user';/if false then\n    v_role := 'user';/"
    "roster link does not notify the board|0003_access.sql|s/where o\.id = any \(v_new\)/where false/"
    "settle-update broken (settled payment never leaves processing)|0006_grok.sql|s/where public\.ledger_status_rank\(excluded\.status\) > public\.ledger_status_rank\(public\.ledger_entries\.status\)/where false/"
    "status can move backwards|0006_grok.sql|s/where public\.ledger_status_rank\(excluded\.status\) > public\.ledger_status_rank\(public\.ledger_entries\.status\)//"
    "duplicate event ids not recorded|0006_grok.sql|s/if exists \(select 1 from public\.processed_events where id = p_event_id\) then/if false then/; s/on conflict \(id\) do nothing;\n  get diagnostics v_n = row_count;\n  if v_n = 0 then/on conflict (id) do nothing;\n  v_n := 1;\n  if v_n = 0 then/"
    "check deposit leaves the invoice open|0005_review.sql|s/update public\.invoices set status = 'paid', paid_outside_stripe = true, paid_on = v_row\.received_on where id = v_inv\.id;//"
    "same-user check guard removed in the live function|0005_review.sql|s/if v_row.logged_by = auth.uid\(\) then/if false then/"
    "dismiss closes check_confirm and claim_attach tasks|0005_review.sql|s/if p_action = 'dismiss' and v_task\.kind in \('check_confirm','claim_attach'\) then/if false then/"
    "returned check leaves its payment row cleared|0004_gaps.sql|s/set status = 'returned', detail = 'Check ' \|\| v_check\.check_number \|\| ', returned by the bank'/set status = 'cleared', detail = 'Check ' || v_check.check_number || ', returned by the bank'/"
    "returned check does not reopen the invoice|0004_gaps.sql|s/set status = 'open', paid_on = null, paid_outside_stripe = false/set status = status/"
    "returned check opens no board task|0004_gaps.sql|s/values \('payment_returned', v_check\.lot_id/values ('roster_change', v_check.lot_id/"
    "mark_check_returned open to non-board users|0004_gaps.sql|s/(create function public\.mark_check_returned.*?)if not public\.is_board\(\) then/\$1if false then/s"
    "mark_check_returned executable by anon|0004_gaps.sql|s/grant execute on function public\.mark_check_returned\(uuid, text\) to authenticated, service_role;/grant execute on function public.mark_check_returned(uuid, text) to public;/"
    "won dispute does not clear the payment|0006_grok.sql|s/set status = 'cleared', description = v_item ->> 'description'/set status = 'returned', description = v_item ->> 'description'/"
    "won dispute marks the invoice paid even with nothing to reinstate|0006_grok.sql|s/if v_reinst_asked and v_reinst_done = 0 then v_status := null; end if;//"
    "dispute reinstate also revives ACH-returned payments|0006_grok.sql|s/ and description = 'Payment disputed';/;/"
    "bill run does not list lots with processing payments|0005_review.sql|s/if coalesce\(\(v_d ->> 'processing_cents'\)::bigint, 0\) > 0 then/if false then/"
    "former owner keeps access after ends_on|0005_review.sql|s/(function public\.my_owner_ids.*?)and \(lo\.ends_on is null or lo\.ends_on >= current_date\)\)/\$1)/s"
    "ends_on treated as exclusive (last day loses access)|0005_review.sql|s/(function public\.my_owner_ids.*?lo\.ends_on) >= current_date/\$1 > current_date/s"
    "owner with a future start date already has access|0005_review.sql|s/(function public\.my_owner_ids.*?)and lo\.starts_on <= current_date/\$1/s"
    "board packet can be shared with owners|0005_review.sql|s/check \(folder <> 'board_packets' or audience = 'board'\)/check (true)/"
    "one storage object can back several document rows|0005_review.sql|s/create unique index documents_storage_path_unique on public\.documents \(storage_path\) where storage_path <> ''/select 1/"
    "check confirmer trigger removed|0005_review.sql|s/create trigger checks_confirmer_is_caller after insert or update on public\.checks\s+for each row execute function public\.checks_confirmer_is_caller\(\);//"
    "authenticated re-granted UPDATE on checks|0005_review.sql|s/create trigger checks_confirmer_is_caller/grant update on public.checks to authenticated;\ncreate trigger checks_confirmer_is_caller/"
    "add_business_days is SECURITY DEFINER again|0005_review.sql|s/language plpgsql stable security invoker set search_path = '' as/language plpgsql stable security definer set search_path = '' as/"
    "add_business_days unbounded|0005_review.sql|s/if days is null or days < 0 or days > 400 then/if false then/"
    "add_business_days executable by everyone|0005_review.sql|s/grant execute on function public\.add_business_days\(timestamptz, integer\) to service_role;/grant execute on function public.add_business_days(timestamptz, integer) to public;/"
    "check payment dated at confirmation|0005_review.sql|s/values \(v_row\.lot_id, v_row\.received_on, 'payment'/values (v_row.lot_id, current_date, 'payment'/"
    "check invoice paid_on at confirmation|0005_review.sql|s/paid_on = v_row\.received_on where id = v_inv\.id/paid_on = current_date where id = v_inv.id/"
    "send_message ignores the chosen lot|0006_grok.sql|s/if p_lot_id is not null then\n    if not exists/if false then\n    if not exists/"
    "send_message does not check the lot is mine|0006_grok.sql|s/if not exists \(select 1 from public\.my_lot_ids\(\) as l\(id\) where l\.id = p_lot_id\) then/if false then/"
    "credit-only lot still gets an invoice|0005_review.sql|s/if v_credit > 0 then\n      if v_total/if false then\n      if v_total/"
    "unknown Stripe event is not quarantined|0006_grok.sql|s/v_q := public\.quarantine_stripe_event\(p_event_id, v_type, 'lot_not_found', p_changes\);/v_q := jsonb_build_object('attempts', 0);/"
    "quarantine row not closed by a later success|0006_grok.sql|s/update public\.stripe_quarantine set resolved_at = now\(\), note = coalesce\(note, 'applied on a later delivery'\)\n   where event_id = p_event_id and resolved_at is null;//"
    "quarantine closable by non-board users|0005_review.sql|s/(create function public\.resolve_stripe_quarantine.*?)if not public\.is_board\(\) then/\$1if false then/s"
    "quarantine readable by every signed-in user|0005_review.sql|s/create policy stripe_quarantine_select on public\.stripe_quarantine for select using \(public\.is_board\(\)\);/create policy stripe_quarantine_select on public.stripe_quarantine for select using (true);/"
    "claim approval creates a duplicate owner|0006_grok.sql|s/elsif cardinality\(v_cands\) = 1 then\n      v_owner := v_cands\[1\];/elsif false then\n      v_owner := v_cands[1];/"
    "claim approval guesses among several owners|0006_grok.sql|s/elsif cardinality\(v_cands\) > 1 then\n      raise exception 'this lot has several owners; choose which one this sign-in belongs to' using errcode = '22023';/elsif false then\n      null;/"
    "claim approval accepts an owner of another lot|0006_grok.sql|s/if not \(p_owner_id = any \(v_cands\)\) then/if false then/"
    "claim approval re-points an owner linked to another sign-in|0006_grok.sql|s/if v_linked is not null and v_linked <> v_req\.user_id then/if false then/"
    "service-role writes not audited|0005_review.sql|s/elsif coalesce\(auth\.jwt\(\) ->> 'role', ''\) = 'service_role' then/elsif false then/"
    "writes with no JWT are audited too|0005_review.sql|s/else\n    return null;\n  end if;\n  if tg_op <> 'INSERT'/else\n    v_role := 'none';\n  end if;\n  if tg_op <> 'INSERT'/"
    "board can decide a claim made with their own sign-in|0006_grok.sql|s/if v_req\.user_id is not null and v_req\.user_id = auth\.uid\(\) then/if false then/"
    "rejecting a claim keeps the code used|0006_grok.sql|s/update public\.claim_codes set used_at = null where id = v_req\.code_id;/null;/"
    "approving a claim also releases the code|0006_grok.sql|s/if not p_approve and v_req\.code_id is not null then/if v_req.code_id is not null then/"
    "claim request does not remember its code|0006_grok.sql|s/values \(v_code\.lot_id, v_email, v_uid, v_code\.id\)/values (v_code.lot_id, v_email, v_uid, null)/"
    "send_message hourly limit removed|0006_grok.sql|s/if v_recent >= 10 then/if false then/"
    "send_message daily limit removed|0006_grok.sql|s/if v_recent >= 30 then/if false then/"
    "send_message limit counts other owners' messages|0006_grok.sql|s/and m\.owner_id in \(select o\.id from public\.owners o where o\.user_id = auth\.uid\(\)\);/;/g"
    "voided invoice is not reversed|0006_grok.sql|s/if v_unpaid > 0 then/if false then/"
    "paid invoice is reversed when voided|0006_grok.sql|s/and v_inv\.status not in \('paid', 'void'\) then/then/"
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
      echo "caught: $name  <- $(grep -m1 -E 'ASSERTION|ERROR' "$WORK/mut$i.out" | sed -E 's/^psql:[^ ]*: ERROR:  //' | cut -c1-120)"
    fi
  done
fi

[ $fail = 0 ] && echo "ALL OK" || echo "FAILED"
exit $fail
