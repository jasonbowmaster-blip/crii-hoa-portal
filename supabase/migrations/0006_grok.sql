-- 0006_grok.sql: review round 6.
--  1. A board member cannot approve or reject a claim made with their own sign-in.
--  2. Rejecting a claim gives the claim code back (used_at cleared); approving keeps it used. claim_requests.code_id
--     links the request to the code it used; redeem_claim_code records it.
--  3. send_message: 10 per hour and 30 per day per owner sign-in.
--  5. invoice.voided reverses the unpaid charge with one credit row keyed void:<event id> (apply_stripe_event).
-- redeem_claim_code, resolve_claim_request, send_message and apply_stripe_event are redefined below (create or replace,
-- same signatures); the mutation checks that targeted their older text in 0003/0005 now target this file.

alter table public.claim_requests add column code_id uuid references public.claim_codes(id) on delete set null;

create or replace function public.redeem_claim_code(p_code text) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_confirmed timestamptz;
  v_hash text;
  v_code public.claim_codes;
  v_recent integer;
  v_attempt bigint;
  v_req uuid;
  v_fail constant json := json_build_object('ok', false, 'message', 'That code did not work. Check it and try again, or contact the board.');
  v_busy constant json := json_build_object('ok', false, 'message', 'Too many tries right now. Please wait an hour or contact the board.');
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  -- one redemption at a time keeps the counts below exact; the volume is a few letters a week
  perform pg_advisory_xact_lock(hashtextextended('claim-codes', 0));

  v_hash := encode(sha256(convert_to(upper(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g')), 'UTF8')), 'hex');

  select count(*) into v_recent from public.claim_attempts
   where user_id = v_uid and attempted_at > now() - interval '1 hour';
  if v_recent >= 5 then
    return json_build_object('ok', false, 'message', 'Too many tries. Please wait an hour or contact the board.');
  end if;
  select count(*) into v_recent from public.claim_attempts
   where code_hash = v_hash and attempted_at > now() - interval '1 hour';
  if v_recent >= 3 then return v_busy; end if;
  select count(*) into v_recent from public.claim_attempts
   where attempted_at > now() - interval '1 hour';
  if v_recent >= 100 then return v_busy; end if;
  insert into public.claim_attempts (user_id, code_hash) values (v_uid, v_hash) returning id into v_attempt;

  select email, email_confirmed_at into v_email, v_confirmed from auth.users where id = v_uid;
  if v_email is null or v_confirmed is null then return v_fail; end if;

  select * into v_code from public.claim_codes where code_hash = v_hash for update;
  if not found or v_code.used_at is not null or v_code.expires_at <= now() then
    return v_fail;
  end if;

  update public.claim_codes set used_at = now(), attempts = attempts + 1 where id = v_code.id;
  update public.claim_attempts set succeeded = true where id = v_attempt;

  insert into public.claim_requests (lot_id, email, user_id, code_id) values (v_code.lot_id, v_email, v_uid, v_code.id)
  on conflict (lot_id, user_id) where status = 'pending' do update set email = excluded.email
  returning id into v_req;

  insert into public.board_tasks (kind, lot_id, title, summary, ref_id)
  values ('claim_attach', v_code.lot_id, 'Confirm new sign-in for a lot',
          'A claim code was used with ' || v_email || '. Verify ownership of this lot against the county land records, then approve or reject. Approve only if you are sure.', v_req);

  return json_build_object('ok', true, 'message', 'Thank you. The board will confirm your account shortly.');
end $$;

create or replace function public.resolve_claim_request(p_id uuid, p_approve boolean, p_owner_id uuid default null)
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
  -- A board member never decides a claim made with their own sign-in (approve OR reject): another board member must.
  if v_req.user_id is not null and v_req.user_id = auth.uid() then
    raise exception 'you cannot decide a claim made with your own sign-in; another board member must' using errcode = '42501';
  end if;

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
  -- Rejecting gives the claim code back, so the owner can try again; approving keeps it used.
  -- The attempts table is untouched, so the per-account, per-code and global limits still count the earlier try.
  if not p_approve and v_req.code_id is not null then
    update public.claim_codes set used_at = null where id = v_req.code_id;
  end if;
  update public.board_tasks set status = 'done', resolved_by = auth.uid(), resolved_at = now()
   where kind = 'claim_attach' and ref_id = p_id and status = 'open';
  return v_req;
end $$;

create or replace function public.send_message(p_topic text, p_body text, p_lot_id uuid default null) returns public.messages
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_lot uuid;
  v_row public.messages;
  v_due timestamptz;
  v_recent integer;
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

  -- At most 10 messages per sign-in per hour and 30 per day. One send at a time per sign-in keeps the count exact.
  perform pg_advisory_xact_lock(hashtextextended('send-message:' || auth.uid()::text, 0));
  select count(*) into v_recent from public.messages m
   where m.channel = 'portal' and m.created_at > now() - interval '1 hour'
     and m.owner_id in (select o.id from public.owners o where o.user_id = auth.uid());
  if v_recent >= 10 then
    raise exception 'You''ve sent a lot of messages today. Please call or email the board.' using errcode = '54000';
  end if;
  select count(*) into v_recent from public.messages m
   where m.channel = 'portal' and m.created_at > now() - interval '1 day'
     and m.owner_id in (select o.id from public.owners o where o.user_id = auth.uid());
  if v_recent >= 30 then
    raise exception 'You''ve sent a lot of messages today. Please call or email the board.' using errcode = '54000';
  end if;

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
  v_unpaid bigint;
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

  -- An invoice voided before it was paid is no longer owed: one credit row, keyed by this event, undoes the unpaid part
  -- of its charge (charge plus every cleared payment/credit/refund on it; returned and processing rows do not count).
  -- Already paid: nothing is reversed, the event is only recorded. A replay hits the same external_ref and adds nothing.
  if coalesce((p_changes ->> 'reverse_invoice_charge')::boolean, false) and v_inv.id is not null
     and v_inv.status not in ('paid', 'void') then
    select coalesce(sum(e.amount_cents), 0) into v_unpaid from public.ledger_entries e
     where e.invoice_id = v_inv.id and e.status = 'cleared' and e.kind in ('charge','payment','credit','refund');
    if v_unpaid > 0 then
      insert into public.ledger_entries (lot_id, posted_on, kind, description, detail, amount_cents, status, invoice_id, external_ref)
      values (v_lot, current_date, 'credit', 'Invoice voided', 'Invoice ' || v_inv.number || ' was voided', -v_unpaid, 'cleared', v_inv.id,
              'void:' || p_event_id)
      on conflict (external_ref) do nothing;
    end if;
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
