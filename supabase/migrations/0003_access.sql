-- Access-control hardening (reviewer findings H1/M1/M2/M3/M4/M6 and the storage gap).
-- Applied after 0001 (and any 0002). Does not edit 0001; replaces functions with CREATE OR REPLACE.
-- Statements below are all transaction-safe.

-- ---------------------------------------------------------------------------
-- 1. Default privileges: future tables, sequences and functions are NOT open to
--    anon/authenticated (Supabase grants them by default). New objects get explicit grants only.
-- ---------------------------------------------------------------------------
do $$
declare r text;
begin
  foreach r in array array['postgres', 'supabase_admin'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      begin
        execute format('alter default privileges for role %I in schema public revoke all on tables from anon, authenticated', r);
        execute format('alter default privileges for role %I in schema public revoke all on sequences from anon, authenticated', r);
        execute format('alter default privileges for role %I in schema public revoke all on functions from anon, authenticated', r);
        execute format('alter default privileges for role %I revoke execute on functions from public', r);
      exception when insufficient_privilege then
        raise notice 'could not change default privileges for role %, run this as that role', r;
      end;
    end if;
  end loop;
end $$;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges revoke execute on functions from public;

-- Existing functions: nobody gets execute through PUBLIC. add_business_days is only used inside send_message
-- (a SECURITY DEFINER function), so signed-in users do not need it (it loops without a bound on `days`).
revoke execute on all functions in schema public from public, anon;
-- the helpers below are used inside the policies that anon is subject to (public documents, events, announcements)
grant execute on function public.is_board(), public.is_board_admin(), public.my_lot_ids(),
  public.my_owner_ids(), public.is_owner() to anon;
revoke execute on function public.add_business_days(timestamptz, integer) from authenticated;

-- ---------------------------------------------------------------------------
-- 2. Board tasks: no direct writes. Every change goes through resolve_task() / the check and claim
--    functions, so a check_confirm or claim_attach task can never be closed without its decision.
-- ---------------------------------------------------------------------------
revoke insert, update on public.board_tasks from authenticated;

-- ---------------------------------------------------------------------------
-- 3. Audit every write by a signed-in user (owners too) and by the service role.
--    Seed and migration runs (no JWT) stay quiet. actor_id is null for the service role.
-- ---------------------------------------------------------------------------
create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  j_old jsonb;
  j_new jsonb;
  j jsonb;
begin
  if auth.uid() is null and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
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

-- ---------------------------------------------------------------------------
-- 4. Notice consent history: append-only, so opting out does not erase when the owner opted in.
--    (owners.email_notice_consent_at must still be null when consent is off; the history keeps the dates.)
-- ---------------------------------------------------------------------------
create table public.notice_consents (
  id                    bigint generated always as identity primary key,
  owner_id              uuid not null,           -- no foreign key on purpose: history outlives a roster edit
  owner_email           text,
  changed_at            timestamptz not null default now(),
  changed_by            uuid,
  email_notice_consent  boolean not null,
  board_notice_request  boolean not null
);
create index notice_consents_owner_idx on public.notice_consents (owner_id, changed_at);
alter table public.notice_consents enable row level security;
create policy notice_consents_select on public.notice_consents for select
  using (public.is_board() or owner_id in (select public.my_owner_ids()));
grant select on public.notice_consents to authenticated;
grant all on public.notice_consents to service_role;
grant usage, select on sequence public.notice_consents_id_seq to service_role;

create function public.notice_consents_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'notice consent history is append-only' using errcode = '42501';
end $$;
create trigger notice_consents_no_change before update or delete on public.notice_consents
  for each row execute function public.notice_consents_append_only();
create trigger notice_consents_no_truncate before truncate on public.notice_consents
  for each statement execute function public.notice_consents_append_only();

create or replace function public.update_notice_prefs(p_email_notice_consent boolean, p_board_notice_request boolean)
returns public.owners language plpgsql security definer set search_path = '' as $$
declare
  v_old public.owners;
  v_row public.owners;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_email_notice_consent is null or p_board_notice_request is null then
    raise exception 'both choices are required' using errcode = '22023';
  end if;
  -- one owner record per call: the first one linked to this sign-in
  select * into v_old from public.owners o where o.user_id = auth.uid() order by o.id limit 1 for update;
  if not found then raise exception 'no owner record for this account' using errcode = '42501'; end if;

  update public.owners o
     set email_notice_consent = p_email_notice_consent,
         email_notice_consent_at = case
           when not p_email_notice_consent then null
           when o.email_notice_consent then o.email_notice_consent_at
           else now() end,
         board_notice_request = p_board_notice_request
   where o.id = v_old.id
  returning * into v_row;

  if v_old.email_notice_consent is distinct from p_email_notice_consent
     or v_old.board_notice_request is distinct from p_board_notice_request then
    insert into public.notice_consents (owner_id, owner_email, changed_by, email_notice_consent, board_notice_request)
    values (v_row.id, v_row.email, auth.uid(), p_email_notice_consent, p_board_notice_request);
  end if;
  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Linking by roster email notifies the board (plan: whenever a sign-in attaches to a lot).
--    One task per owner record that was newly linked; repeat sign-ins create nothing.
-- ---------------------------------------------------------------------------
create or replace function public.link_owner_for(p_user uuid, p_email text, p_confirmed timestamptz, p_signed_in timestamptz)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  n integer;
  v_new uuid[];
begin
  if p_user is null or p_email is null or p_confirmed is null then
    return 0;
  end if;
  select coalesce(array_agg(o.id), '{}') into v_new from public.owners o
   where lower(btrim(o.email)) = lower(btrim(p_email)) and o.user_id is null;
  update public.owners
     set user_id = p_user,
         last_sign_in_at = coalesce(p_signed_in, now())
   where lower(btrim(email)) = lower(btrim(p_email))
     and (user_id is null or user_id = p_user);
  get diagnostics n = row_count;

  insert into public.board_tasks (kind, lot_id, title, summary, ref_id)
  select 'roster_change', lo.lot_id, 'New sign-in linked to a lot',
         p_email || ' signed in and was linked to ' || o.full_name
           || coalesce(' (Lot ' || l.lot_number || ')', '')
           || ' because the email matches the roster. If you do not expect this, check the roster email.',
         o.id
    from public.owners o
    left join public.lot_owners lo on lo.owner_id = o.id and lo.ends_on is null
    left join public.lots l on l.id = lo.lot_id
   where o.id = any (v_new);
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Claim codes: limits per account (5/hour, as before), per code string (3/hour, so new accounts
--    cannot multiply guesses at one code) and globally (100/hour). Approval wording asks the board
--    to verify ownership against county land records; the claimant's email is by definition not on file.
-- ---------------------------------------------------------------------------
alter table public.claim_attempts add column code_hash text;
create index claim_attempts_hash_idx on public.claim_attempts (code_hash, attempted_at);
create index claim_attempts_time_idx on public.claim_attempts (attempted_at);

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

  insert into public.claim_requests (lot_id, email, user_id) values (v_code.lot_id, v_email, v_uid)
  on conflict (lot_id, user_id) where status = 'pending' do update set email = excluded.email
  returning id into v_req;

  insert into public.board_tasks (kind, lot_id, title, summary, ref_id)
  values ('claim_attach', v_code.lot_id, 'Confirm new sign-in for a lot',
          'A claim code was used with ' || v_email || '. Verify ownership of this lot against the county land records, then approve or reject. Approve only if you are sure.', v_req);

  return json_build_object('ok', true, 'message', 'Thank you. The board will confirm your account shortly.');
end $$;

-- ---------------------------------------------------------------------------
-- 7. Documents: owners see draft documents (Virginia: draft minutes are available to owners).
--    The page labels them "Draft". Only audience = 'board' hides a document from owners.
-- ---------------------------------------------------------------------------
drop policy documents_select on public.documents;
create policy documents_select on public.documents for select
  using (
    public.is_board()
    or audience = 'public'
    or (audience = 'owners' and public.is_owner())
  );

-- ---------------------------------------------------------------------------
-- 8. Storage policies for the private 'documents' bucket (skipped where there is no storage schema).
--    Reading reuses the documents table's own row-level security, so audience rules live in one place.
--    The 'backups' bucket has no policy: only the service role reaches it.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.objects') is not null then
    drop policy if exists documents_bucket_read on storage.objects;
    drop policy if exists documents_bucket_board_insert on storage.objects;
    drop policy if exists documents_bucket_board_update on storage.objects;
    drop policy if exists documents_bucket_board_delete on storage.objects;
    create policy documents_bucket_read on storage.objects for select to anon, authenticated
      using (bucket_id = 'documents' and (
        public.is_board()
        or exists (select 1 from public.documents d where d.storage_path = storage.objects.name)));
    create policy documents_bucket_board_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'documents' and public.is_board());
    create policy documents_bucket_board_update on storage.objects for update to authenticated
      using (bucket_id = 'documents' and public.is_board())
      with check (bucket_id = 'documents' and public.is_board());
    create policy documents_bucket_board_delete on storage.objects for delete to authenticated
      using (bucket_id = 'documents' and public.is_board());
  end if;
end $$;
