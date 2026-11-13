-- 0002_money: Stripe lifecycle, checks that settle invoices, and the bill-run writer.
--
-- Model: ONE ledger row per payment, keyed by external_ref = the PaymentIntent id.
-- processing -> cleared -> returned only ever moves forward, so event order and
-- duplicate delivery cannot change the answer. Refunds are one row per Refund id.
-- The lot is found through our own invoices table, never from Stripe metadata alone.

-- Our invoice remembers its PaymentIntent, so charge/dispute events can find the lot.
alter table public.invoices add column stripe_payment_intent_id text unique;

-- Every Stripe event id we have applied. The unique id is the replay guard.
create table public.processed_events (
  id            text primary key,
  type          text not null,
  lot_id        uuid references public.lots(id) on delete set null,
  processed_at  timestamptz not null default now()
);

-- Jobs for the function layer: "tell Stripe this invoice was paid out of band".
create table public.stripe_outbox (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind in ('mark_paid_out_of_band')),
  invoice_id         uuid references public.invoices(id) on delete cascade,
  stripe_invoice_id  text not null,
  status             text not null default 'pending' check (status in ('pending','done','failed')),
  created_at         timestamptz not null default now(),
  done_at            timestamptz,
  unique (kind, stripe_invoice_id)
);

alter table public.processed_events enable row level security;
alter table public.stripe_outbox enable row level security;
revoke all on public.processed_events, public.stripe_outbox from public, anon, authenticated;
grant all on public.processed_events, public.stripe_outbox to service_role;

-- Forward-only order for ledger payment rows.
create function public.ledger_status_rank(p text) returns int language sql immutable set search_path = '' as $$
  select case p when 'processing' then 0 when 'cleared' then 1 when 'returned' then 2 end $$;

-- Forward-only order for invoice status (void is terminal, handled in the rpc).
create function public.invoice_status_rank(p text) returns int language sql immutable set search_path = '' as $$
  select case p when 'draft' then 0 when 'open' then 1 when 'processing' then 2 when 'paid' then 3 when 'void' then 4 end $$;

-- ---------------------------------------------------------------------------
-- apply_stripe_event: the one writer for Stripe events. Called by the webhook with
-- the service role. p_changes is built by supabase/functions/_shared/stripe.ts:
--   event_type, stripe_invoice_id, payment_intent, lot_hint, invoice_status, invoice_force,
--   ledger [{external_ref, posted_on, kind, description, detail, amount_cents, status, method}],
--   tasks [{kind, title, summary}]
-- Returns {applied, duplicate, reason, lot_id}. When the lot cannot be found yet it
-- records nothing (applied false), so Stripe's retry can succeed once the data exists.
-- ---------------------------------------------------------------------------
create function public.apply_stripe_event(p_event_id text, p_changes jsonb)
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
-- Checks: a deposited check settles the matching open invoice outside Stripe.
-- Match: the oldest open invoice of the lot that the check covers (amount <= check),
-- preferring an exact amount. The Stripe side is told later through stripe_outbox.
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
  end if;
  update public.board_tasks set status = 'done', resolved_by = auth.uid(), resolved_at = now()
   where kind = 'check_confirm' and ref_id = p_check_id and status = 'open';
  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- apply_bill_run: saves the invoices AND posts each lot's yearly charge, idempotently.
-- p_drafts: [{lot_id, number, description, due_on, assessment_cents, total_cents}]
--  - total_cents is what the owner is asked to pay (assessment plus carried balance, never below 0).
--    A lot whose credit covers the dues gets a zero invoice, saved as already paid.
--  - the ledger charge is the assessment alone; the carried balance is already in the ledger.
-- Re-running creates nothing twice. Existing invoices are never overwritten; those whose
-- amount differs from the new draft are listed in `differing` so the board can look.
-- ---------------------------------------------------------------------------
create function public.apply_bill_run(p_posted_on date, p_drafts jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_d jsonb; v_n int; v_inv public.invoices;
  v_created int := 0; v_existing int := 0; v_charges int := 0;
  v_differing text[] := '{}';
  v_total bigint;
begin
  for v_d in select * from jsonb_array_elements(p_drafts) loop
    v_total := (v_d ->> 'total_cents')::bigint;
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
  return jsonb_build_object('created', v_created, 'already_existing', v_existing, 'charges_posted', v_charges, 'differing', to_jsonb(v_differing));
end $$;

revoke all on function public.apply_bill_run(date, jsonb) from public, anon, authenticated;
grant execute on function public.apply_bill_run(date, jsonb) to service_role;
