-- 0005_review: fixes from the four-reviewer pass over commit 70348fa that were still open after 0002-0004.
-- Never edits 0001-0004; replaces functions with create or replace (or drop + create when the signature changes).
--  1. my_owner_ids() respects lot_owners starts_on/ends_on, like my_lot_ids().
--  2. board_packets documents must be audience 'board'; one document row per storage object.
--  3. checks.deposit_confirmed_by can only be set by the signed-in confirmer (trigger, on top of "no direct writes").
--  4. add_business_days: security invoker, bounded, no execute for anyone but the owner role / service role.
--  5. A deposited check posts to the ledger on the day the HOA received it.
--  6. send_message takes an optional lot for owners of several lots.
--  7. apply_bill_run: no invoice for a credit larger than the dues (the credit stays in the ledger).
--  8. Stripe events that cannot be tied to a lot are kept in stripe_quarantine for the board.
--  11. Claim approval attaches the new sign-in to the existing roster owner.
--  13. audit_row records the actor kind (user or service) and still covers owner and service-role writes.
-- Everything here is transaction-safe.

-- ---------------------------------------------------------------------------
-- 1. Former owners. ends_on is the LAST day of access: a row is current while
--    starts_on <= today <= ends_on (or ends_on is null). The day after ends_on the seller is out.
--    Same rule as my_lot_ids(); everything built on my_owner_ids() (messages, lot_owners rows,
--    consent history) follows it. A person's own owners row stays readable to them (it is their own
--    contact data and the notice settings), but nothing tied to the lot does.
-- ---------------------------------------------------------------------------
create or replace function public.my_owner_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select o.id
  from public.owners o
  where o.user_id = auth.uid()
    and exists (
      select 1 from public.lot_owners lo
      where lo.owner_id = o.id
        and lo.starts_on <= current_date
        and (lo.ends_on is null or lo.ends_on >= current_date))
$$;

-- ---------------------------------------------------------------------------
-- 2. Board packets are board-only, whoever uploads them. A storage object belongs to one document row,
--    so the document row's audience decides who can read the file (see documents_bucket_read in 0003).
-- ---------------------------------------------------------------------------
alter table public.documents
  add constraint documents_board_packets_board_only check (folder <> 'board_packets' or audience = 'board');
create unique index documents_storage_path_unique on public.documents (storage_path) where storage_path <> '';

-- ---------------------------------------------------------------------------
-- 3. Two-person rule. Authenticated has no INSERT/UPDATE/DELETE on checks and no write policy; the only writers are
--    log_check and confirm_check_deposit (definer functions). This trigger closes the last gap: whoever writes the
--    row (including the service role or a definer function bug), deposit_confirmed_by can only be the signed-in user.
--    It is an AFTER trigger so the table's own check constraints report first.
-- ---------------------------------------------------------------------------
create function public.checks_confirmer_is_caller() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.deposit_confirmed_by is not null
     and (tg_op = 'INSERT' or old.deposit_confirmed_by is distinct from new.deposit_confirmed_by)
     and new.deposit_confirmed_by is distinct from auth.uid() then
    raise exception 'deposit_confirmed_by can only be the signed-in board member who confirms (confirm_check_deposit)' using errcode = '42501';
  end if;
  return null;
end $$;
create trigger checks_confirmer_is_caller after insert or update on public.checks
  for each row execute function public.checks_confirmer_is_caller();

-- ---------------------------------------------------------------------------
-- 4. add_business_days: not a definer function (it only reads holidays, and its callers are definer functions that
--    already run as the owner role), bounded so a huge day count cannot hold a connection, and not executable by
--    anon, authenticated or PUBLIC.
-- ---------------------------------------------------------------------------
create or replace function public.add_business_days(start_at timestamptz, days integer) returns timestamptz
language plpgsql stable security invoker set search_path = '' as $$
declare
  d timestamptz := start_at;
  added integer := 0;
begin
  if days is null or days < 0 or days > 400 then
    raise exception 'days must be between 0 and 400' using errcode = '22023';
  end if;
  while added < days loop
    d := d + interval '1 day';
    if extract(isodow from (d at time zone 'UTC')) < 6
       and not exists (select 1 from public.holidays h where h.day = (d at time zone 'UTC')::date) then
      added := added + 1;
    end if;
  end loop;
  return d;
end $$;
revoke all on function public.add_business_days(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.add_business_days(timestamptz, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Check deposits: posted_on (and the invoice's paid_on) is the day the HOA received the check, not the day a
--    second person confirmed it. Otherwise a check received before the due date but confirmed after it looks late.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_check_deposit(p_check_id uuid, p_outcome text)
returns public.checks language plpgsql security definer set search_path = '' as $$
declare v_row public.checks; v_inv public.invoices;
begin
  if not public.is_board() then raise exception 'board only' using errcode = '42501'; end if;
  if p_outcome not in ('deposited','returned') then raise exception 'outcome must be deposited or returned' using errcode = '22023'; end if;
  select * into v_row from public.checks where id = p_check_id for update;
  if not found then raise exception 'check not found' using errcode = 'P0002'; end if;
  if v_row.state <> 'received' then raise exception 'check already %', v_row.state using errcode = '55000'; end if;
  if v_row.logged_by = auth.uid() then
    raise exception 'a different board member must confirm this check' using errcode = '42501';
  end if;

  update public.checks set state = p_outcome, deposit_confirmed_by = auth.uid()
   where id = p_check_id returning * into v_row;

  if p_outcome = 'deposited' then
    select * into v_inv from public.invoices
     where lot_id = v_row.lot_id and status = 'open' and amount_cents <= v_row.amount_cents
     order by (amount_cents = v_row.amount_cents) desc, due_on, number
     limit 1 for update;

    insert into public.ledger_entries (lot_id, posted_on, kind, description, detail, amount_cents, status, method, invoice_id, external_ref)
    values (v_row.lot_id, v_row.received_on, 'payment', 'Payment by check',
            'Check ' || v_row.check_number || ', deposit confirmed', -v_row.amount_cents, 'cleared', 'check',
            v_inv.id, 'check:' || v_row.id);

    if v_inv.id is not null then
      update public.invoices set status = 'paid', paid_outside_stripe = true, paid_on = v_row.received_on where id = v_inv.id;
      if v_inv.stripe_invoice_id is not null then
        insert into public.stripe_outbox (kind, invoice_id, stripe_invoice_id)
        values ('mark_paid_out_of_band', v_inv.id, v_inv.stripe_invoice_id) on conflict do nothing;
      end if;
    end if;
  else
    perform public.apply_check_return(p_check_id, null);
  end if;
  update public.board_tasks set status = 'done', resolved_by = auth.uid(), resolved_at = now()
   where kind = 'check_confirm' and ref_id = p_check_id and status = 'open';
  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 6. send_message for owners of several lots: optional p_lot_id, which must be one of my_lot_ids().
--    Left out, it is the first lot (earliest start, then lot id), as before.
-- ---------------------------------------------------------------------------
drop function public.send_message(text, text);
create function public.send_message(p_topic text, p_body text, p_lot_id uuid default null) returns public.messages
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_lot uuid;
  v_row public.messages;
  v_due timestamptz;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_topic is null or p_topic not in ('question','maintenance','arb','billing','records','complaint','other') then
    raise exception 'unknown topic' using errcode = '22023';
  end if;
  if p_body is null or btrim(p_body) = '' or length(p_body) > 5000 then
    raise exception 'message must be 1 to 5000 characters' using errcode = '22023';
  end if;

  if p_lot_id is not null then
    if not exists (select 1 from public.my_lot_ids() as l(id) where l.id = p_lot_id) then
      raise exception 'you are not a current owner of that lot' using errcode = '42501';
    end if;
    v_lot := p_lot_id;
  else
    select lo.lot_id into v_lot
    from public.owners o
    join public.lot_owners lo on lo.owner_id = o.id
    where o.user_id = auth.uid()
      and lo.starts_on <= current_date and (lo.ends_on is null or lo.ends_on >= current_date)
    order by lo.starts_on, lo.lot_id
    limit 1;
  end if;
  -- the owner record of this sign-in that currently owns that lot
  select o.id into v_owner
  from public.owners o
  join public.lot_owners lo on lo.owner_id = o.id
  where o.user_id = auth.uid() and lo.lot_id = v_lot
    and lo.starts_on <= current_date and (lo.ends_on is null or lo.ends_on >= current_date)
  order by lo.starts_on, o.id
  limit 1;
  if v_owner is null then raise exception 'no owner record for this account' using errcode = '42501'; end if;

  if p_topic = 'records' then v_due := public.add_business_days(now(), 10); end if;

  insert into public.messages (lot_id, owner_id, topic, subject, body, status, due_at, channel)
  values (v_lot, v_owner, p_topic, left(regexp_replace(btrim(p_body), '\s+', ' ', 'g'), 80), p_body, 'new', v_due, 'portal')
  returning * into v_row;

  if p_topic = 'records' then
    insert into public.board_tasks (kind, lot_id, title, summary, due_at, ref_id)
    values ('records_request', v_lot, 'Records request', v_row.subject, v_due, v_row.id);
  end if;
  return v_row;
end $$;
revoke all on function public.send_message(text, text, uuid) from public, anon;
grant execute on function public.send_message(text, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. apply_bill_run. Drafts now carry credit_left_cents (credit still left after this year's dues, 0 when none).
--    A lot whose carried credit is LARGER than the dues gets no invoice at all: the assessment is still posted as a
--    charge, so the credit in the ledger is simply used up, and the lot is listed in `credit_only`.
--    (A credit exactly equal to the dues still gets the zero invoice saved as paid, as in 0002.)
--    Re-running is idempotent; the carried amounts the edge function computes leave out this year's own
--    charge, payments and refunds (see summarizeYearRows in _shared/bill-run.ts).
-- ---------------------------------------------------------------------------
create or replace function public.apply_bill_run(p_posted_on date, p_drafts jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_d jsonb; v_n int; v_inv public.invoices;
  v_created int := 0; v_existing int := 0; v_charges int := 0;
  v_differing text[] := '{}';
  v_total bigint;
  v_credit bigint;
  v_lot uuid;
  v_processing text[] := '{}';
  v_credit_only text[] := '{}';
begin
  for v_d in select * from jsonb_array_elements(p_drafts) loop
    v_total := (v_d ->> 'total_cents')::bigint;
    v_credit := coalesce((v_d ->> 'credit_left_cents')::bigint, 0);
    v_lot := (v_d ->> 'lot_id')::uuid;
    v_inv := null;
    if coalesce((v_d ->> 'processing_cents')::bigint, 0) > 0 then v_processing := v_processing || (v_d ->> 'number'); end if;
    if v_total < 0 then raise exception 'invoice total cannot be negative (lot %)', v_d ->> 'lot_id' using errcode = '22023'; end if;
    if v_credit < 0 then raise exception 'credit cannot be negative (lot %)', v_d ->> 'lot_id' using errcode = '22023'; end if;

    if v_credit > 0 then
      if v_total <> 0 then raise exception 'a credit-only draft must total 0 (lot %)', v_d ->> 'lot_id' using errcode = '22023'; end if;
      v_credit_only := v_credit_only || (v_d ->> 'number');
      select * into v_inv from public.invoices where number = v_d ->> 'number';   -- an earlier run may have made one
      if v_inv.id is not null then v_existing := v_existing + 1; end if;
    else
      insert into public.invoices (lot_id, number, description, amount_cents, issued_on, due_on, status, paid_on)
      values (v_lot, v_d ->> 'number', v_d ->> 'description', v_total, p_posted_on, (v_d ->> 'due_on')::date,
              case when v_total = 0 then 'paid' else 'draft' end, case when v_total = 0 then p_posted_on end)
      on conflict (number) do nothing;
      get diagnostics v_n = row_count;
      select * into v_inv from public.invoices where number = v_d ->> 'number';
      if v_n = 1 then v_created := v_created + 1;
      else
        v_existing := v_existing + 1;
        if v_inv.amount_cents <> v_total then v_differing := v_differing || (v_d ->> 'number'); end if;
      end if;
    end if;

    insert into public.ledger_entries (lot_id, posted_on, kind, description, amount_cents, status, invoice_id, external_ref)
    values (v_lot, p_posted_on, 'charge', v_d ->> 'description', (v_d ->> 'assessment_cents')::bigint, 'cleared', v_inv.id,
            'inv:' || (v_d ->> 'number'))
    on conflict (external_ref) do nothing;
    get diagnostics v_n = row_count;
    v_charges := v_charges + v_n;
  end loop;
  return jsonb_build_object('created', v_created, 'already_existing', v_existing, 'charges_posted', v_charges,
                            'differing', to_jsonb(v_differing), 'with_processing', to_jsonb(v_processing),
                            'credit_only', to_jsonb(v_credit_only));
end $$;
revoke all on function public.apply_bill_run(date, jsonb) from public, anon, authenticated;
grant execute on function public.apply_bill_run(date, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Stripe events that cannot be tied to a lot are kept, not dropped. The webhook asks Stripe to retry a few
--    times (the invoice link can arrive late); after that the event stays here for the board and gets a 200.
--    The payload is the mapped change set (ids, amounts, dates), never the raw Stripe object.
-- ---------------------------------------------------------------------------
create table public.stripe_quarantine (
  id             uuid primary key default gen_random_uuid(),
  event_id       text not null unique,
  event_type     text not null,
  reason         text not null,
  payload        jsonb not null default '{}'::jsonb,
  attempts       integer not null default 1,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  resolved_at    timestamptz,
  resolved_by    uuid,
  note           text
);
alter table public.stripe_quarantine enable row level security;
create policy stripe_quarantine_select on public.stripe_quarantine for select using (public.is_board());
revoke all on public.stripe_quarantine from public, anon, authenticated;
grant select on public.stripe_quarantine to authenticated;
grant all on public.stripe_quarantine to service_role;

create function public.quarantine_stripe_event(p_event_id text, p_type text, p_reason text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_attempts int;
begin
  if p_event_id is null or p_event_id = '' then raise exception 'event id required' using errcode = '22023'; end if;
  insert into public.stripe_quarantine as q (event_id, event_type, reason, payload)
  values (p_event_id, coalesce(p_type, 'unknown'), coalesce(p_reason, 'unknown'), coalesce(p_payload, '{}'::jsonb))
  on conflict (event_id) do update
    set attempts = q.attempts + 1, last_seen_at = now(), reason = excluded.reason, payload = excluded.payload
  returning q.attempts into v_attempts;
  return jsonb_build_object('quarantined', true, 'attempts', v_attempts);
end $$;
revoke all on function public.quarantine_stripe_event(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.quarantine_stripe_event(text, text, text, jsonb) to service_role;

-- A board member closes a reviewed row (after fixing the data by hand, or deciding it is not ours).
create function public.resolve_stripe_quarantine(p_id uuid, p_note text default null)
returns public.stripe_quarantine language plpgsql security definer set search_path = '' as $$
declare v_row public.stripe_quarantine;
begin
  if not public.is_board() then raise exception 'board only' using errcode = '42501'; end if;
  update public.stripe_quarantine set resolved_at = coalesce(resolved_at, now()), resolved_by = coalesce(resolved_by, auth.uid()), note = p_note
   where id = p_id returning * into v_row;
  if not found then raise exception 'quarantine row not found' using errcode = 'P0002'; end if;
  return v_row;
end $$;
revoke all on function public.resolve_stripe_quarantine(uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_stripe_quarantine(uuid, text) to authenticated, service_role;

-- apply_stripe_event: unchanged from 0004 except (a) lot_not_found goes to the quarantine and (b) a later successful
-- delivery of the same event closes its quarantine row.
create or replace function public.apply_stripe_event(p_event_id text, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_type   text := coalesce(p_changes ->> 'event_type', 'unknown');
  v_sid    text := nullif(p_changes ->> 'stripe_invoice_id', '');
  v_pi     text := nullif(p_changes ->> 'payment_intent', '');
  v_hint   text := nullif(p_changes ->> 'lot_hint', '');
  v_status text := nullif(p_changes ->> 'invoice_status', '');
  v_force  boolean := coalesce((p_changes ->> 'invoice_force')::boolean, false);
  v_inv    public.invoices;
  v_lot    uuid;
  v_item   jsonb;
  v_skip   boolean := false;
  v_n      int;
  v_pi_returned boolean := false;
  v_reinst_asked boolean := false;
  v_reinst_done  int := 0;
  v_q      jsonb;
begin
  if p_event_id is null or p_event_id = '' then raise exception 'event id required' using errcode = '22023'; end if;
  if exists (select 1 from public.processed_events where id = p_event_id) then
    return jsonb_build_object('applied', false, 'duplicate', true);
  end if;

  -- 1. find our invoice: by Stripe invoice id, by PaymentIntent, or through the payment row
  if v_sid is not null then select * into v_inv from public.invoices where stripe_invoice_id = v_sid; end if;
  if v_inv.id is null and v_pi is not null then
    select * into v_inv from public.invoices where stripe_payment_intent_id = v_pi;
  end if;
  if v_inv.id is null and v_pi is not null then
    select i.* into v_inv from public.ledger_entries e join public.invoices i on i.id = e.invoice_id where e.external_ref = v_pi;
  end if;
  v_lot := v_inv.lot_id;
  if v_lot is null and v_pi is not null then select lot_id into v_lot from public.ledger_entries where external_ref = v_pi; end if;
  if v_lot is null and v_hint ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select id into v_lot from public.lots where id = v_hint::uuid;
  end if;
  if v_lot is null then
    -- Not dropped: kept for the board (and Stripe is asked to retry a few times, in case the invoice link is just late).
    v_q := public.quarantine_stripe_event(p_event_id, v_type, 'lot_not_found', p_changes);
    return jsonb_build_object('applied', false, 'duplicate', false, 'reason', 'lot_not_found',
                              'quarantined', true, 'attempts', (v_q ->> 'attempts')::int);
  end if;

  insert into public.processed_events (id, type, lot_id) values (p_event_id, v_type, v_lot) on conflict (id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('applied', false, 'duplicate', true); end if;
  update public.stripe_quarantine set resolved_at = now(), note = coalesce(note, 'applied on a later delivery')
   where event_id = p_event_id and resolved_at is null;

  if v_inv.id is not null and v_pi is not null and v_inv.stripe_payment_intent_id is null then
    update public.invoices set stripe_payment_intent_id = v_pi where id = v_inv.id and stripe_payment_intent_id is null;
  end if;

  -- 2. money: an invoice we already marked paid outside Stripe must not post a second payment
  if v_type = 'invoice.paid' and coalesce(v_inv.paid_outside_stripe, false) then v_skip := true; end if;

  if not v_skip then
    for v_item in select * from jsonb_array_elements(coalesce(p_changes -> 'ledger', '[]'::jsonb)) loop
      if coalesce((v_item ->> 'reinstate')::boolean, false) then
        -- A won dispute is the ONE backward move: only a payment row that a dispute returned goes back to cleared.
        v_reinst_asked := true;
        update public.ledger_entries
           set status = 'cleared', description = v_item ->> 'description'
         where external_ref = v_item ->> 'external_ref' and lot_id = v_lot and kind = 'payment'
           and status = 'returned' and description = 'Payment disputed';
        get diagnostics v_n = row_count;
        v_reinst_done := v_reinst_done + v_n;
        continue;
      end if;
      insert into public.ledger_entries (lot_id, posted_on, kind, description, detail, amount_cents, status, method, invoice_id, external_ref)
      values (v_lot, (v_item ->> 'posted_on')::date, v_item ->> 'kind', v_item ->> 'description', v_item ->> 'detail',
              (v_item ->> 'amount_cents')::bigint, v_item ->> 'status', v_item ->> 'method', v_inv.id, v_item ->> 'external_ref')
      on conflict (external_ref) do update set
        status      = excluded.status,
        description = excluded.description,
        detail      = coalesce(excluded.detail, public.ledger_entries.detail),
        method      = coalesce(public.ledger_entries.method, excluded.method),
        invoice_id  = coalesce(public.ledger_entries.invoice_id, excluded.invoice_id)
      where public.ledger_status_rank(excluded.status) > public.ledger_status_rank(public.ledger_entries.status);
    end loop;
  end if;

  -- A won-dispute event that found nothing to reinstate must not mark the invoice paid.
  if v_reinst_asked and v_reinst_done = 0 then v_status := null; end if;

  -- 3. invoice status: forward only, except a return or dispute (force) which reopens it
  if v_inv.id is not null and v_status is not null then
    select exists (select 1 from public.ledger_entries where external_ref = v_pi and kind = 'payment' and status = 'returned')
      into v_pi_returned;
    select * into v_inv from public.invoices where id = v_inv.id for update;
    if v_inv.status = 'void' and v_status <> 'void' then
      null;                                                     -- never revive a void invoice
    elsif v_force or v_status = 'void'
       or (public.invoice_status_rank(v_status) > public.invoice_status_rank(v_inv.status) and not v_pi_returned) then
      update public.invoices
         set status = v_status,
             paid_on = case when v_status = 'paid' then coalesce(paid_on, current_date) else null end
       where id = v_inv.id;
    end if;
  end if;

  -- 4. board tasks (once per event, because the event id is recorded above)
  for v_item in select * from jsonb_array_elements(coalesce(p_changes -> 'tasks', '[]'::jsonb)) loop
    insert into public.board_tasks (kind, lot_id, title, summary, status)
    values (v_item ->> 'kind', v_lot, v_item ->> 'title', coalesce(v_item ->> 'summary', ''), 'open');
  end loop;

  return jsonb_build_object('applied', true, 'duplicate', false, 'lot_id', v_lot);
end $$;
revoke all on function public.apply_stripe_event(text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_stripe_event(text, jsonb) to service_role;


-- ---------------------------------------------------------------------------
-- 11. Claim approval attaches the new sign-in to the EXISTING roster owner of the lot (one current owner: that one;
--     several: the board names which with p_owner_id). Only a lot with no roster owner at all gets a new owner row.
--     owners.user_id is deliberately NOT unique: a shared household email links one sign-in to several owner records
--     (see link_owner_for in 0003), and the app supports that. An owner row has one sign-in, so a row already linked
--     to a different sign-in is refused rather than silently re-pointed.
-- ---------------------------------------------------------------------------
drop function public.resolve_claim_request(uuid, boolean);
create function public.resolve_claim_request(p_id uuid, p_approve boolean, p_owner_id uuid default null)
returns public.claim_requests language plpgsql security definer set search_path = '' as $$
declare
  v_req public.claim_requests;
  v_owner uuid;
  v_addr text;
  v_cands uuid[];
  v_linked uuid;
begin
  if not public.is_board() then raise exception 'board only' using errcode = '42501'; end if;
  select * into v_req from public.claim_requests where id = p_id for update;
  if not found then raise exception 'claim not found' using errcode = 'P0002'; end if;
  if v_req.status <> 'pending' then raise exception 'claim already %', v_req.status using errcode = '55000'; end if;

  if p_approve then
    if v_req.user_id is null then raise exception 'the claimant account no longer exists' using errcode = '55000'; end if;
    select coalesce(array_agg(distinct lo.owner_id), '{}') into v_cands
      from public.lot_owners lo
     where lo.lot_id = v_req.lot_id and lo.starts_on <= current_date and (lo.ends_on is null or lo.ends_on >= current_date);
    if p_owner_id is not null then
      if not (p_owner_id = any (v_cands)) then
        raise exception 'that owner is not a current owner of this lot' using errcode = '22023';
      end if;
      v_owner := p_owner_id;
    elsif cardinality(v_cands) = 1 then
      v_owner := v_cands[1];
    elsif cardinality(v_cands) > 1 then
      raise exception 'this lot has several owners; choose which one this sign-in belongs to' using errcode = '22023';
    end if;

    if v_owner is null then
      select street_address into v_addr from public.lots where id = v_req.lot_id;
      insert into public.owners (full_name, first_name, email, mailing_address, user_id, last_sign_in_at)
      values (v_req.email, '', v_req.email, v_addr, v_req.user_id, now())
      returning id into v_owner;
      insert into public.lot_owners (lot_id, owner_id, starts_on) values (v_req.lot_id, v_owner, current_date);
    else
      select user_id into v_linked from public.owners where id = v_owner for update;
      if v_linked is not null and v_linked <> v_req.user_id then
        raise exception 'that owner is already linked to another sign-in; clear the link on the roster first' using errcode = '55000';
      end if;
      update public.owners set user_id = v_req.user_id, last_sign_in_at = now() where id = v_owner;
    end if;
  end if;
  update public.claim_requests set status = case when p_approve then 'approved' else 'rejected' end
   where id = p_id returning * into v_req;
  update public.board_tasks set status = 'done', resolved_by = auth.uid(), resolved_at = now()
   where kind = 'claim_attach' and ref_id = p_id and status = 'open';
  return v_req;
end $$;
revoke all on function public.resolve_claim_request(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.resolve_claim_request(uuid, boolean, uuid) to authenticated, service_role;

-- resolve_task gains the same optional owner choice (the board screens call resolve_task for claim tasks).
drop function public.resolve_task(uuid, text, text);
create function public.resolve_task(p_task_id uuid, p_action text, p_note text default null, p_owner_id uuid default null)
returns public.board_tasks language plpgsql security definer set search_path = '' as $$
declare v_task public.board_tasks;
begin
  if not public.is_board() then raise exception 'board only' using errcode = '42501'; end if;
  if p_action not in ('approve','reject','dismiss') then raise exception 'unknown action' using errcode = '22023'; end if;
  select * into v_task from public.board_tasks where id = p_task_id for update;
  if not found then raise exception 'task not found' using errcode = 'P0002'; end if;
  if v_task.status <> 'open' then raise exception 'task already %', v_task.status using errcode = '55000'; end if;
  if p_action = 'dismiss' and v_task.kind in ('check_confirm','claim_attach') then
    raise exception 'a % task cannot be dismissed; approve or reject it', v_task.kind using errcode = '22023';
  end if;

  if v_task.kind = 'check_confirm' then
    perform public.confirm_check_deposit(v_task.ref_id, case p_action when 'approve' then 'deposited' else 'returned' end);
  elsif v_task.kind = 'claim_attach' then
    perform public.resolve_claim_request(v_task.ref_id, p_action = 'approve', p_owner_id);
  end if;

  update public.board_tasks
     set status = case
           when p_action = 'dismiss' then 'dismissed'
           when kind in ('check_confirm','claim_attach') then 'done'   -- reject is still a decision
           when p_action = 'approve' then 'done'
           else 'dismissed' end,
         resolved_by = coalesce(resolved_by, auth.uid()), resolved_at = coalesce(resolved_at, now()),
         note = p_note
   where id = p_task_id
  returning * into v_task;
  return v_task;
end $$;
revoke all on function public.resolve_task(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.resolve_task(uuid, text, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 13. Audit. 0003 already records owner writes and service-role (webhook, bill run) writes; this adds actor_role so a
--     row with no actor_id says WHO wrote it: 'user' (a signed-in person, board or owner) or 'service'
--     (the service role: webhook, bill run, scheduled jobs). Seed and migration runs with no JWT stay quiet.
-- ---------------------------------------------------------------------------
alter table public.audit_log add column actor_role text;

create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  j_old jsonb;
  j_new jsonb;
  j jsonb;
  v_role text;
begin
  if auth.uid() is not null then
    v_role := 'user';
  elsif coalesce(auth.jwt() ->> 'role', '') = 'service_role' then
    v_role := 'service';
  else
    return null;
  end if;
  if tg_op <> 'INSERT' then j_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then j_new := to_jsonb(new); end if;
  j := coalesce(j_new, j_old);
  insert into public.audit_log (actor_id, actor_role, table_name, row_id, action, old_data, new_data)
  values (auth.uid(), v_role, tg_table_name,
          coalesce(j->>'id', j->>'user_id', (j->>'lot_id') || '/' || (j->>'owner_id')),
          tg_op, j_old, j_new);
  return null;
end $$;

-- (reads) the quarantine table is the one new table; audit it like the other money tables.
create trigger audit_stripe_quarantine after insert or update or delete on public.stripe_quarantine
  for each row execute function public.audit_row();
