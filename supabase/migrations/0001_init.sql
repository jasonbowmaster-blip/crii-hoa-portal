-- HOA owner portal: initial schema, row-level security, views and functions.
-- Column names match web/src/data/types.ts (snake_case). Money is integer cents (bigint).
-- Security model: every table has RLS on; access is keyed on auth.uid(), never on email text.
-- Writes by owners go ONLY through SECURITY DEFINER functions with a fixed search_path.
-- Storage bucket policies (private document bucket, signed links) are set up separately.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.lots (
  id             uuid primary key default gen_random_uuid(),
  lot_number     integer not null unique check (lot_number > 0),
  street_address text not null,
  status         text not null default 'active' check (status in ('active','on_hold','in_collections'))
);

create table public.owners (
  id                       uuid primary key default gen_random_uuid(),
  full_name                text not null,
  first_name               text not null,
  email                    text,
  phone                    text,
  mailing_address          text not null,
  email_notice_consent     boolean not null default false,  -- Va. Code 55.1-1815
  email_notice_consent_at  timestamptz,
  board_notice_request     boolean not null default false,  -- 55.1-1816
  user_id                  uuid references auth.users(id) on delete set null,
  last_sign_in_at          timestamptz,
  check (email_notice_consent or email_notice_consent_at is null)
);
create index owners_user_id_idx on public.owners (user_id);
create index owners_email_lower_idx on public.owners (lower(btrim(email)));

create table public.lot_owners (
  lot_id    uuid not null references public.lots(id) on delete cascade,
  owner_id  uuid not null references public.owners(id) on delete cascade,
  starts_on date not null,
  ends_on   date,
  primary key (lot_id, owner_id, starts_on),
  check (ends_on is null or ends_on >= starts_on)
);
create index lot_owners_owner_idx on public.lot_owners (owner_id);

create table public.board_members (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  owner_id     uuid references public.owners(id) on delete set null,
  role         text not null check (role in ('president','vice_president','treasurer','secretary','director','arb_chair')),
  is_admin     boolean not null default false,
  term_ends_on date,
  active       boolean not null default true
);

create table public.invoices (
  id                   uuid primary key default gen_random_uuid(),
  lot_id               uuid not null references public.lots(id) on delete restrict,
  number               text not null unique,
  description          text not null,
  amount_cents         bigint not null check (amount_cents >= 0),
  issued_on            date,
  due_on               date not null,
  status               text not null default 'draft' check (status in ('draft','open','processing','paid','void')),
  stripe_invoice_id    text unique,          -- webhook idempotency: one row per Stripe invoice
  hosted_invoice_url   text,
  paid_outside_stripe  boolean not null default false,
  paid_on              date
);
create index invoices_lot_idx on public.invoices (lot_id);

create table public.ledger_entries (
  id            uuid primary key default gen_random_uuid(),
  lot_id        uuid not null references public.lots(id) on delete restrict,
  posted_on     date not null,
  kind          text not null check (kind in ('opening_balance','charge','payment','credit','refund')),
  description   text not null,
  detail        text,
  amount_cents  bigint not null,
  status        text not null default 'cleared' check (status in ('processing','cleared','returned')),
  method        text check (method in ('ach','card','check','other')),
  invoice_id    uuid references public.invoices(id) on delete set null,
  external_ref  text,                         -- Stripe event/payment id, or 'check:<number>'
  -- sign rules: payments and credits reduce what is owed; charges and refunds increase it
  check (kind not in ('payment','credit') or amount_cents <= 0),
  check (kind not in ('charge','refund') or amount_cents >= 0),
  -- A retried webhook with the same external_ref is rejected (or upserted onto), never double-counted.
  -- NULL external_ref (manual rows) is allowed many times.
  unique (external_ref)
);
create index ledger_entries_lot_idx on public.ledger_entries (lot_id, posted_on);

create table public.checks (
  id                    uuid primary key default gen_random_uuid(),
  lot_id                uuid not null references public.lots(id) on delete restrict,
  check_number          text not null,
  amount_cents          bigint not null check (amount_cents > 0),
  received_on           date not null,
  logged_by             uuid not null references auth.users(id),
  deposit_confirmed_by  uuid references auth.users(id),
  state                 text not null default 'received' check (state in ('received','deposited','returned')),
  unique (lot_id, check_number),
  -- two-person rule, enforced again at the table level
  check (deposit_confirmed_by is null or deposit_confirmed_by <> logged_by),
  check ((state = 'received') = (deposit_confirmed_by is null))
);

create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  lot_id           uuid references public.lots(id) on delete set null,
  owner_id         uuid references public.owners(id) on delete set null,
  topic            text not null check (topic in ('question','maintenance','arb','billing','records','complaint','other')),
  subject          text not null,
  body             text not null,
  status           text not null default 'new' check (status in ('new','acknowledged','draft_waiting','escalated','answered','closed')),
  created_at       timestamptz not null default now(),
  answered_at      timestamptz,
  due_at           timestamptz,
  gmail_thread_id  text,
  assigned_to      uuid references auth.users(id) on delete set null,
  channel          text not null default 'portal' check (channel in ('portal','email','phone','mail'))
);
create index messages_owner_idx on public.messages (owner_id);
create index messages_lot_idx on public.messages (lot_id);

create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  folder        text not null check (folder in ('governing','rules_arb','minutes','board_packets','budgets','forms')),
  title         text not null,
  storage_path  text not null,
  audience      text not null check (audience in ('public','owners','board')),
  posted_on     date not null default current_date,
  is_draft      boolean not null default false
);

create table public.events (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  kind          text not null check (kind in ('board_meeting','annual_meeting','tree_work','dues_date','other')),
  starts_at     timestamptz not null,
  location      text,
  video_url     text,
  notes         text,
  is_public     boolean not null default false,
  notice_sent_on date[] not null default '{}'
);

create table public.announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text not null,
  posted_at  timestamptz not null default now(),
  audience   text not null check (audience in ('public','owners','board'))
);

create table public.board_tasks (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('check_confirm','payment_returned','claim_attach','template_reply','draft_approval','records_request','returned_mail','roster_change')),
  lot_id       uuid references public.lots(id) on delete set null,
  title        text not null,
  summary      text not null default '',
  status       text not null default 'open' check (status in ('open','done','dismissed')),
  created_at   timestamptz not null default now(),
  due_at       timestamptz,
  ref_id       uuid,                      -- message / check / claim id
  resolved_by  uuid references auth.users(id),
  resolved_at  timestamptz,
  note         text
);
create index board_tasks_open_idx on public.board_tasks (status, created_at);

create table public.reply_templates (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  body         text not null,
  version      integer not null default 1 check (version > 0),
  approved_on  date                         -- null = unapproved, cannot be sent
);

-- Claim codes: only a sha256 hash is stored. Created by the service role (letter run); no owner or board policy.
create table public.claim_codes (
  id          uuid primary key default gen_random_uuid(),
  lot_id      uuid not null references public.lots(id) on delete cascade,
  code_hash   text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  attempts    integer not null default 0
);

-- One row per redeem try, used for the "5 tries an hour per user" limit. No policy: functions only.
create table public.claim_attempts (
  id            bigint generated always as identity primary key,
  user_id       uuid not null,
  attempted_at  timestamptz not null default now(),
  succeeded     boolean not null default false
);
create index claim_attempts_user_idx on public.claim_attempts (user_id, attempted_at);

create table public.claim_requests (
  id          uuid primary key default gen_random_uuid(),
  lot_id      uuid not null references public.lots(id) on delete cascade,
  email       text not null,
  user_id     uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  status      text not null default 'pending' check (status in ('pending','approved','rejected'))
);
create unique index claim_requests_one_pending on public.claim_requests (lot_id, user_id) where status = 'pending';

create table public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  table_name  text not null,
  row_id      text,
  action      text not null,
  old_data    jsonb,
  new_data    jsonb
);

create table public.mail_log (
  id               uuid primary key default gen_random_uuid(),
  lot_id           uuid references public.lots(id) on delete set null,
  kind             text not null,
  lob_letter_id    text unique,
  sent_on          date,
  delivered_on     date,
  tracking_number  text
);

-- Board-maintained holidays for the 10-business-day records clock.
create table public.holidays (
  day   date primary key,
  name  text not null
);

-- ---------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER, fixed search_path)
-- ---------------------------------------------------------------------------

create function public.is_board() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.board_members b where b.user_id = auth.uid() and b.active)
$$;

create function public.is_board_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.board_members b where b.user_id = auth.uid() and b.active and b.is_admin)
$$;

-- Lots the signed-in user currently owns (via the lot_owners row that has not ended).
create function public.my_lot_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select lo.lot_id
  from public.lot_owners lo
  join public.owners o on o.id = lo.owner_id
  where o.user_id = auth.uid()
    and lo.starts_on <= current_date
    and (lo.ends_on is null or lo.ends_on >= current_date)
$$;

-- Owner record ids of the signed-in user.
create function public.my_owner_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select o.id from public.owners o where o.user_id = auth.uid()
$$;

-- Any signed-in current owner ("owners" audience).
create function public.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.my_lot_ids())
$$;

-- Same weekend/holiday rules as addBusinessDays() in web/src/lib/ledger.ts.
create function public.add_business_days(start_at timestamptz, days integer) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare
  d timestamptz := start_at;
  added integer := 0;
begin
  while added < days loop
    d := d + interval '1 day';
    if extract(isodow from (d at time zone 'UTC')) < 6
       and not exists (select 1 from public.holidays h where h.day = (d at time zone 'UTC')::date) then
      added := added + 1;
    end if;
  end loop;
  return d;
end $$;

-- ---------------------------------------------------------------------------
-- Audit trigger: records board writes (rows changed by an active board member)
-- ---------------------------------------------------------------------------

create function public.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  j_old jsonb;
  j_new jsonb;
  j jsonb;
begin
  if not public.is_board() then
    return null;
  end if;
  if tg_op <> 'INSERT' then j_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then j_new := to_jsonb(new); end if;
  j := coalesce(j_new, j_old);
  insert into public.audit_log (actor_id, table_name, row_id, action, old_data, new_data)
  values (auth.uid(), tg_table_name,
          coalesce(j->>'id', j->>'user_id', (j->>'lot_id') || '/' || (j->>'owner_id')),
          tg_op, j_old, j_new);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['lots','owners','lot_owners','board_members','invoices','ledger_entries','checks',
                           'messages','documents','events','announcements','board_tasks','reply_templates',
                           'claim_requests','holidays']
  loop
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$I
                    for each row execute function public.audit_row()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['lots','owners','lot_owners','board_members','invoices','ledger_entries','checks',
                           'messages','documents','events','announcements','board_tasks','reply_templates',
                           'claim_codes','claim_attempts','claim_requests','audit_log','mail_log','holidays']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Owner-visible, lot-scoped tables
create policy lots_select on public.lots for select
  using (public.is_board() or id in (select public.my_lot_ids()));
create policy invoices_select on public.invoices for select
  using (public.is_board() or lot_id in (select public.my_lot_ids()));
create policy ledger_entries_select on public.ledger_entries for select
  using (public.is_board() or lot_id in (select public.my_lot_ids()));

-- Owners: own record only (board: all)
create policy owners_select on public.owners for select
  using (public.is_board() or user_id = auth.uid());
create policy lot_owners_select on public.lot_owners for select
  using (public.is_board() or owner_id in (select public.my_owner_ids()));

-- Messages: owners read their own; they can only create through send_message()
create policy messages_select on public.messages for select
  using (public.is_board() or owner_id in (select public.my_owner_ids()));
create policy messages_board_update on public.messages for update
  using (public.is_board()) with check (public.is_board());

-- Documents / announcements / events by audience. Drafts are board-only.
create policy documents_select on public.documents for select
  using (
    public.is_board()
    or (not is_draft and (audience = 'public' or (audience = 'owners' and public.is_owner())))
  );
create policy announcements_select on public.announcements for select
  using (
    public.is_board()
    or audience = 'public'
    or (audience = 'owners' and public.is_owner())
  );
create policy events_select on public.events for select
  using (public.is_board() or is_public or public.is_owner());

-- Board-only tables
create policy board_members_select on public.board_members for select using (public.is_board());
create policy checks_select on public.checks for select using (public.is_board());
create policy board_tasks_select on public.board_tasks for select using (public.is_board());
create policy reply_templates_select on public.reply_templates for select using (public.is_board());
create policy mail_log_select on public.mail_log for select using (public.is_board());
create policy audit_log_select on public.audit_log for select using (public.is_board_admin());
create policy claim_requests_select on public.claim_requests for select
  using (public.is_board() or user_id = auth.uid());
create policy holidays_select on public.holidays for select using (auth.uid() is not null);
-- claim_codes, claim_attempts: RLS on, no policies, no grants => unreachable except through functions / service role.

-- Board writes. Roster and board membership need an admin; content needs any active board member.
do $$
declare t text;
begin
  foreach t in array array['lots','owners','lot_owners','board_members','holidays'] loop
    execute format('create policy %1$s_admin_insert on public.%1$I for insert with check (public.is_board_admin())', t);
    execute format('create policy %1$s_admin_update on public.%1$I for update using (public.is_board_admin()) with check (public.is_board_admin())', t);
    execute format('create policy %1$s_admin_delete on public.%1$I for delete using (public.is_board_admin())', t);
  end loop;
  foreach t in array array['documents','events','announcements','reply_templates'] loop
    execute format('create policy %1$s_board_insert on public.%1$I for insert with check (public.is_board())', t);
    execute format('create policy %1$s_board_update on public.%1$I for update using (public.is_board()) with check (public.is_board())', t);
    execute format('create policy %1$s_board_delete on public.%1$I for delete using (public.is_board())', t);
  end loop;
end $$;
create policy board_tasks_board_insert on public.board_tasks for insert with check (public.is_board());
create policy board_tasks_board_update on public.board_tasks for update
  using (public.is_board()) with check (public.is_board());

-- ---------------------------------------------------------------------------
-- Balances (mirrors summarizeBalance in web/src/lib/ledger.ts; keep them in step)
--  - returned entries count for nothing
--  - processing payments are NOT subtracted yet; they are reported separately
-- security_invoker: the caller's RLS applies, so owners see only their own lot.
-- ---------------------------------------------------------------------------

create view public.lot_balances with (security_invoker = true) as
select
  s.lot_id,
  s.balance_cents,
  s.processing_cents,
  case
    when s.balance_cents < 0 then 'credit'
    when s.balance_cents = 0 then case when s.processing_cents > 0 then 'processing' else 'paid' end
    when s.processing_cents >= s.balance_cents then 'processing'
    else 'unpaid'
  end as state
from (
  select
    l.id as lot_id,
    coalesce(sum(e.amount_cents) filter (
      where e.status <> 'returned' and not (e.status = 'processing' and e.amount_cents < 0)), 0)::bigint as balance_cents,
    coalesce(sum(-e.amount_cents) filter (
      where e.status = 'processing' and e.amount_cents < 0), 0)::bigint as processing_cents
  from public.lots l
  left join public.ledger_entries e on e.lot_id = l.id
  group by l.id
) s;

-- ---------------------------------------------------------------------------
-- Sign-in linking: attach an auth user to the owner row whose roster email matches,
-- ONLY when the auth email is verified. Never steals a row already linked to someone else.
-- ---------------------------------------------------------------------------

create function public.link_owner_for(p_user uuid, p_email text, p_confirmed timestamptz, p_signed_in timestamptz)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if p_user is null or p_email is null or p_confirmed is null then
    return 0;
  end if;
  update public.owners
     set user_id = p_user,
         last_sign_in_at = coalesce(p_signed_in, now())
   where lower(btrim(email)) = lower(btrim(p_email))
     and (user_id is null or user_id = p_user);
  get diagnostics n = row_count;
  return n;
end $$;

create function public.link_owner_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.link_owner_for(new.id, new.email, new.email_confirmed_at, new.last_sign_in_at);
  return new;
end $$;

create trigger link_owner_on_sign_in
  after insert or update of email, email_confirmed_at, last_sign_in_at on auth.users
  for each row execute function public.link_owner_trigger();

-- Same linking as an RPC, for clients that sign in before the trigger has a chance to run.
create function public.link_owner_on_sign_in() returns integer
language plpgsql security definer set search_path = '' as $$
declare u record;
begin
  select id, email, email_confirmed_at, last_sign_in_at into u from auth.users where id = auth.uid();
  if not found then return 0; end if;
  return public.link_owner_for(u.id, u.email, u.email_confirmed_at, u.last_sign_in_at);
end $$;

-- ---------------------------------------------------------------------------
-- Owner RPCs
-- ---------------------------------------------------------------------------

-- lot and owner come from auth.uid(); the caller cannot choose them.
create function public.send_message(p_topic text, p_body text) returns public.messages
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

  select o.id, lo.lot_id into v_owner, v_lot
  from public.owners o
  join public.lot_owners lo on lo.owner_id = o.id
  where o.user_id = auth.uid()
    and lo.starts_on <= current_date and (lo.ends_on is null or lo.ends_on >= current_date)
  order by lo.starts_on, lo.lot_id
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

create function public.update_notice_prefs(p_email_notice_consent boolean, p_board_notice_request boolean)
returns public.owners language plpgsql security definer set search_path = '' as $$
declare v_row public.owners;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_email_notice_consent is null or p_board_notice_request is null then
    raise exception 'both choices are required' using errcode = '22023';
  end if;
  update public.owners o
     set email_notice_consent = p_email_notice_consent,
         email_notice_consent_at = case
           when not p_email_notice_consent then null
           when o.email_notice_consent then o.email_notice_consent_at
           else now() end,
         board_notice_request = p_board_notice_request
   where o.user_id = auth.uid()
  returning * into v_row;
  if not found then raise exception 'no owner record for this account' using errcode = '42501'; end if;
  return v_row;
end $$;

-- Claim code redemption. Never attaches directly: it makes a pending claim_request and a board task.
-- Returns jsonb {ok, message} instead of raising, so failed tries are still counted.
create function public.redeem_claim_code(p_code text) returns json
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
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  select count(*) into v_recent from public.claim_attempts
   where user_id = v_uid and attempted_at > now() - interval '1 hour';
  if v_recent >= 5 then
    return json_build_object('ok', false, 'message', 'Too many tries. Please wait an hour or contact the board.');
  end if;
  insert into public.claim_attempts (user_id) values (v_uid) returning id into v_attempt;

  select email, email_confirmed_at into v_email, v_confirmed from auth.users where id = v_uid;
  if v_email is null or v_confirmed is null then return v_fail; end if;

  v_hash := encode(sha256(convert_to(upper(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g')), 'UTF8')), 'hex');
  select * into v_code from public.claim_codes where code_hash = v_hash for update;
  if not found or v_code.used_at is not null or v_code.expires_at <= now() then
    return v_fail;
  end if;

  update public.claim_codes set used_at = now(), attempts = attempts + 1 where id = v_code.id;
  update public.claim_attempts set succeeded = true where id = v_attempt;

  insert into public.claim_requests (lot_id, email, user_id) values (v_code.lot_id, v_email, v_uid)
  on conflict (lot_id, user_id) where status = 'pending' do update set email = excluded.email
  returning id into v_req;

  insert into public.board_tasks (kind, lot_id, title, summary, ref_id)
  values ('claim_attach', v_code.lot_id, 'Confirm new sign-in for a lot',
          'A claim code was used with ' || v_email || '. Check it matches the owner on file, then approve or reject.', v_req);

  return json_build_object('ok', true, 'message', 'Thank you. The board will confirm your account shortly.');
end $$;

-- ---------------------------------------------------------------------------
-- Board RPCs
-- ---------------------------------------------------------------------------

create function public.log_check(p_lot_id uuid, p_check_number text, p_amount_cents bigint, p_received_on date)
returns public.checks language plpgsql security definer set search_path = '' as $$
declare v_row public.checks;
begin
  if not public.is_board() then raise exception 'board only' using errcode = '42501'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'amount must be positive' using errcode = '22023'; end if;
  if p_check_number is null or btrim(p_check_number) = '' then raise exception 'check number required' using errcode = '22023'; end if;
  insert into public.checks (lot_id, check_number, amount_cents, received_on, logged_by)
  values (p_lot_id, btrim(p_check_number), p_amount_cents, p_received_on, auth.uid())
  returning * into v_row;
  insert into public.board_tasks (kind, lot_id, title, summary, ref_id)
  values ('check_confirm', p_lot_id, 'Confirm check deposit',
          'Check ' || v_row.check_number || ' was logged. A second board member confirms it is on the deposit.', v_row.id);
  return v_row;
end $$;

create function public.confirm_check_deposit(p_check_id uuid, p_outcome text)
returns public.checks language plpgsql security definer set search_path = '' as $$
declare v_row public.checks;
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
    insert into public.ledger_entries (lot_id, posted_on, kind, description, detail, amount_cents, status, method, external_ref)
    values (v_row.lot_id, current_date, 'payment', 'Payment by check',
            'Check ' || v_row.check_number || ', deposit confirmed', -v_row.amount_cents, 'cleared', 'check',
            'check:' || v_row.id);
  end if;
  update public.board_tasks set status = 'done', resolved_by = auth.uid(), resolved_at = now()
   where kind = 'check_confirm' and ref_id = p_check_id and status = 'open';
  return v_row;
end $$;

-- Generic task resolution used by the board screens (approve / reject / dismiss).
--  check_confirm: approve = deposit confirmed (same rules as confirm_check_deposit), reject = check returned
--  claim_attach:  approve = attach the new sign-in to the lot, reject = refuse it
--  other kinds:   approve = done, reject/dismiss = dismissed
create function public.resolve_task(p_task_id uuid, p_action text, p_note text default null)
returns public.board_tasks language plpgsql security definer set search_path = '' as $$
declare v_task public.board_tasks;
begin
  if not public.is_board() then raise exception 'board only' using errcode = '42501'; end if;
  if p_action not in ('approve','reject','dismiss') then raise exception 'unknown action' using errcode = '22023'; end if;
  select * into v_task from public.board_tasks where id = p_task_id for update;
  if not found then raise exception 'task not found' using errcode = 'P0002'; end if;
  if v_task.status <> 'open' then raise exception 'task already %', v_task.status using errcode = '55000'; end if;

  if v_task.kind = 'check_confirm' and p_action <> 'dismiss' then
    perform public.confirm_check_deposit(v_task.ref_id, case p_action when 'approve' then 'deposited' else 'returned' end);
  elsif v_task.kind = 'claim_attach' and p_action <> 'dismiss' then
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

-- Board approves or rejects a pending claim. Approval creates a new owner record (board edits the name later).
create function public.resolve_claim_request(p_id uuid, p_approve boolean)
returns public.claim_requests language plpgsql security definer set search_path = '' as $$
declare
  v_req public.claim_requests;
  v_owner uuid;
  v_addr text;
begin
  if not public.is_board() then raise exception 'board only' using errcode = '42501'; end if;
  select * into v_req from public.claim_requests where id = p_id for update;
  if not found then raise exception 'claim not found' using errcode = 'P0002'; end if;
  if v_req.status <> 'pending' then raise exception 'claim already %', v_req.status using errcode = '55000'; end if;

  if p_approve then
    select street_address into v_addr from public.lots where id = v_req.lot_id;
    insert into public.owners (full_name, first_name, email, mailing_address, user_id, last_sign_in_at)
    values (v_req.email, '', v_req.email, v_addr, v_req.user_id, now())
    returning id into v_owner;
    insert into public.lot_owners (lot_id, owner_id, starts_on) values (v_req.lot_id, v_owner, current_date);
  end if;
  update public.claim_requests set status = case when p_approve then 'approved' else 'rejected' end
   where id = p_id returning * into v_req;
  update public.board_tasks set status = 'done', resolved_by = auth.uid(), resolved_at = now()
   where kind = 'claim_attach' and ref_id = p_id and status = 'open';
  return v_req;
end $$;

-- ---------------------------------------------------------------------------
-- Privileges. Start from nothing, grant only what RLS then narrows.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant usage on schema public to anon, authenticated, service_role;

-- anon: public documents, announcements and events only (RLS limits to audience public)
grant select on public.documents, public.announcements, public.events to anon;

grant select on public.lots, public.owners, public.lot_owners, public.board_members, public.invoices,
  public.ledger_entries, public.checks, public.messages, public.documents, public.events,
  public.announcements, public.board_tasks, public.reply_templates, public.claim_requests,
  public.audit_log, public.mail_log, public.holidays, public.lot_balances to authenticated;

grant insert, update, delete on public.lots, public.owners, public.lot_owners, public.board_members,
  public.holidays, public.documents, public.events, public.announcements, public.reply_templates to authenticated;
grant insert, update on public.board_tasks to authenticated;
grant update on public.messages to authenticated;   -- board only, by policy; owners have no update policy

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- helpers used inside policies must be callable by every role that evaluates them
grant execute on function public.is_board(), public.is_board_admin(), public.my_lot_ids(),
  public.my_owner_ids(), public.is_owner() to anon, authenticated, service_role;
grant execute on function public.send_message(text, text), public.update_notice_prefs(boolean, boolean),
  public.redeem_claim_code(text), public.link_owner_on_sign_in(), public.log_check(uuid, text, bigint, date),
  public.confirm_check_deposit(uuid, text), public.resolve_task(uuid, text, text), public.resolve_claim_request(uuid, boolean),
  public.add_business_days(timestamptz, integer) to authenticated, service_role;
grant execute on function public.link_owner_for(uuid, text, timestamptz, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Storage buckets (private). No-op where the storage schema does not exist (local test harness).
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('documents', 'documents', false), ('backups', 'backups', false)
    on conflict (id) do update set public = false;
  end if;
end $$;
