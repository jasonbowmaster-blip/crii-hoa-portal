-- 0004_gaps: closes four known gaps. Never edits 0001-0003; replaces functions with create or replace.
--  1. resolve_task: 'dismiss' can no longer close check_confirm or claim_attach tasks.
--  2. A returned check: ledger row -> returned, the invoice it settled reopens, a payment_returned
--     task opens. New board rpc mark_check_returned for a check that bounces AFTER it was deposited.
--  3. apply_stripe_event: a won dispute (charge.dispute.closed) clears the payment again.
--  4. apply_bill_run: lists the invoices whose lot has bank payments still processing.

-- ---------------------------------------------------------------------------
-- 2. Effects of a returned check (internal; callers have already checked board and state).
-- ---------------------------------------------------------------------------
create function public.apply_check_return(p_check_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_check public.checks; v_inv uuid; v_n int;
begin
  select * into v_check from public.checks where id = p_check_id;
  if not found or v_check.state <> 'returned' then raise exception 'check is not marked returned' using errcode = '55000'; end if;

  -- the payment row (if the deposit was recorded) goes to returned, so the balance goes back up
  update public.ledger_entries
     set status = 'returned', detail = 'Check ' || v_check.check_number || ', returned by the bank'
   where external_ref = 'check:' || p_check_id
  returning invoice_id into v_inv;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    -- returned before it was ever on the deposit: keep a record that counts for nothing
    insert into public.ledger_entries (lot_id, posted_on, kind, description, detail, amount_cents, status, method, external_ref)
    values (v_check.lot_id, current_date, 'payment', 'Payment by check',
            'Check ' || v_check.check_number || ', not on the deposit', -v_check.amount_cents, 'returned', 'check', 'check:' || p_check_id);
  end if;

  -- the invoice this check settled opens again (never a void one, never one settled another way)
  if v_inv is not null then
    update public.invoices
       set status = 'open', paid_on = null, paid_outside_stripe = false
     where id = v_inv and status = 'paid' and paid_outside_stripe;
    delete from public.stripe_outbox where invoice_id = v_inv and status = 'pending';   -- not yet told to Stripe
  end if;

  insert into public.board_tasks (kind, lot_id, title, summary, ref_id)
  values ('payment_returned', v_check.lot_id, 'Check ' || v_check.check_number || ' was returned',
          'The check for ' || to_char(v_check.amount_cents / 100.0, 'FM999999990.00') || ' dollars did not clear. The lot shows unpaid again. Contact the owner.'
            || coalesce(' Note: ' || nullif(btrim(p_note), ''), ''), p_check_id);
end $$;
revoke all on function public.apply_check_return(uuid, text) from public, anon, authenticated;
grant execute on function public.apply_check_return(uuid, text) to service_role;

-- confirm_check_deposit: unchanged except that 'returned' now runs apply_check_return.
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
    values (v_row.lot_id, current_date, 'payment', 'Payment by check',
            'Check ' || v_row.check_number || ', deposit confirmed', -v_row.amount_cents, 'cleared', 'check',
            v_inv.id, 'check:' || v_row.id);

    if v_inv.id is not null then
      update public.invoices set status = 'paid', paid_outside_stripe = true, paid_on = current_date where id = v_inv.id;
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

-- Board: a deposited check that the bank sent back. (A check that was never confirmed goes through
-- confirm_check_deposit(..., 'returned') so the two-person rule still applies to it.)
create function public.mark_check_returned(p_check_id uuid, p_note text default null)
returns public.checks language plpgsql security definer set search_path = '' as $$
declare v_row public.checks;
begin
  if not public.is_board() then raise exception 'board only' using errcode = '42501'; end if;
  select * into v_row from public.checks where id = p_check_id for update;
  if not found then raise exception 'check not found' using errcode = 'P0002'; end if;
  if v_row.state = 'returned' then raise exception 'check already returned' using errcode = '55000'; end if;
  if v_row.state <> 'deposited' then
    raise exception 'check has not been deposited yet; confirm it as not on the deposit instead' using errcode = '55000';
  end if;
  update public.checks set state = 'returned' where id = p_check_id returning * into v_row;
  perform public.apply_check_return(p_check_id, p_note);
  return v_row;
end $$;
revoke all on function public.mark_check_returned(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_check_returned(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. resolve_task: approve/reject/dismiss. check_confirm and claim_attach close ONLY by
--    confirming/approving (or an explicit reject), never by dismissal, so the two-person
--    check rule and the claim approval cannot be skipped.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_task(p_task_id uuid, p_action text, p_note text default null)
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
    perform public.resolve_claim_request(v_task.ref_id, p_action = 'approve');
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

-- ---------------------------------------------------------------------------
-- 3. apply_stripe_event: ledger items may carry reinstate:true (built from charge.dispute.closed,
--    status won). See the marked block in the ledger loop and the guard before step 3.
-- ---------------------------------------------------------------------------
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
  if v_lot is null then return jsonb_build_object('applied', false, 'duplicate', false, 'reason', 'lot_not_found'); end if;

  insert into public.processed_events (id, type, lot_id) values (p_event_id, v_type, v_lot) on conflict (id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('applied', false, 'duplicate', true); end if;

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

-- ---------------------------------------------------------------------------
-- 4. apply_bill_run: drafts may carry processing_cents (bank payments still processing for that lot).
--    It does not change any amount (processing payments are not subtracted, exactly as in lot_balances);
--    it only lists the invoice numbers in `with_processing`, so the board sees who may be billed for money
--    that is already on its way.
-- ---------------------------------------------------------------------------
create or replace function public.apply_bill_run(p_posted_on date, p_drafts jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_d jsonb; v_n int; v_inv public.invoices;
  v_created int := 0; v_existing int := 0; v_charges int := 0;
  v_differing text[] := '{}';
  v_total bigint;
  v_processing text[] := '{}';
begin
  for v_d in select * from jsonb_array_elements(p_drafts) loop
    v_total := (v_d ->> 'total_cents')::bigint;
    if coalesce((v_d ->> 'processing_cents')::bigint, 0) > 0 then v_processing := v_processing || (v_d ->> 'number'); end if;
    if v_total < 0 then raise exception 'invoice total cannot be negative (lot %)', v_d ->> 'lot_id' using errcode = '22023'; end if;
    insert into public.invoices (lot_id, number, description, amount_cents, issued_on, due_on, status, paid_on)
    values ((v_d ->> 'lot_id')::uuid, v_d ->> 'number', v_d ->> 'description', v_total, p_posted_on, (v_d ->> 'due_on')::date,
            case when v_total = 0 then 'paid' else 'draft' end, case when v_total = 0 then p_posted_on end)
    on conflict (number) do nothing;
    get diagnostics v_n = row_count;
    select * into v_inv from public.invoices where number = v_d ->> 'number';
    if v_n = 1 then v_created := v_created + 1;
    else
      v_existing := v_existing + 1;
      if v_inv.amount_cents <> v_total then v_differing := v_differing || (v_d ->> 'number'); end if;
    end if;

    insert into public.ledger_entries (lot_id, posted_on, kind, description, amount_cents, status, invoice_id, external_ref)
    values (v_inv.lot_id, p_posted_on, 'charge', v_d ->> 'description', (v_d ->> 'assessment_cents')::bigint, 'cleared', v_inv.id,
            'inv:' || (v_d ->> 'number'))
    on conflict (external_ref) do nothing;
    get diagnostics v_n = row_count;
    v_charges := v_charges + v_n;
  end loop;
  return jsonb_build_object('created', v_created, 'already_existing', v_existing, 'charges_posted', v_charges, 'differing', to_jsonb(v_differing), 'with_processing', to_jsonb(v_processing));
end $$;

revoke all on function public.apply_bill_run(date, jsonb) from public, anon, authenticated;
grant execute on function public.apply_bill_run(date, jsonb) to service_role;
revoke all on function public.apply_stripe_event(text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_stripe_event(text, jsonb) to service_role;
