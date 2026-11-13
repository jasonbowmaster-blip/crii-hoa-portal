-- 0007_e2e: what the first end-to-end test needs on top of 0001-0006.
--   1. stripe_customers: one Stripe customer per lot (service role only; owners never read it).
--   2. record_stripe_customer / record_stripe_invoice: the bill-send function saves its results through these.
--   3. e2e_install_schedules(): nightly backup, Stripe outbox drain and message-to-inbox trigger. It installs
--      them only where pg_cron and pg_net (and Vault) exist, and skips cleanly where they do not (the local test
--      harness). Called once at the bottom of this file; the setup script calls it again after enabling the
--      extensions, so a project where they were enabled later still gets the schedules.

-- ---------------------------------------------------------------------------
-- 1. One Stripe customer per lot
-- ---------------------------------------------------------------------------
create table public.stripe_customers (
  id                  uuid primary key default gen_random_uuid(),
  lot_id              uuid not null unique references public.lots(id) on delete cascade,
  stripe_customer_id  text not null unique,
  created_at          timestamptz not null default now()
);
alter table public.stripe_customers enable row level security;
revoke all on public.stripe_customers from public, anon, authenticated;
grant all on public.stripe_customers to service_role;
create trigger audit_stripe_customers after insert or update or delete on public.stripe_customers
  for each row execute function public.audit_row();

-- ---------------------------------------------------------------------------
-- 2. Saving what Stripe returned
-- ---------------------------------------------------------------------------
-- Idempotent: the same customer for the same lot is a no-op; a DIFFERENT customer for a lot that has one is refused.
create function public.record_stripe_customer(p_lot_id uuid, p_stripe_customer_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_existing text;
begin
  if p_stripe_customer_id is null or p_stripe_customer_id !~ '^cus_' then
    raise exception 'not a Stripe customer id' using errcode = '22023';
  end if;
  select stripe_customer_id into v_existing from public.stripe_customers where lot_id = p_lot_id;
  if v_existing is not null and v_existing <> p_stripe_customer_id then
    raise exception 'this lot already has a different Stripe customer' using errcode = '23505';
  end if;
  insert into public.stripe_customers (lot_id, stripe_customer_id) values (p_lot_id, p_stripe_customer_id)
  on conflict (lot_id) do nothing;
end $$;
revoke all on function public.record_stripe_customer(uuid, text) from public, anon, authenticated;
grant execute on function public.record_stripe_customer(uuid, text) to service_role;

-- Links a saved invoice to its Stripe invoice and payment link; a draft becomes open (owners can see and pay it).
-- Idempotent for the same ids; refuses to re-point an invoice that is already linked to a different Stripe invoice.
create function public.record_stripe_invoice(p_invoice_id uuid, p_stripe_invoice_id text, p_hosted_invoice_url text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_inv public.invoices;
begin
  if p_stripe_invoice_id is null or p_stripe_invoice_id !~ '^in_' then
    raise exception 'not a Stripe invoice id' using errcode = '22023';
  end if;
  if p_hosted_invoice_url is null or p_hosted_invoice_url !~ '^https://' then
    raise exception 'the payment link must be an https address' using errcode = '22023';
  end if;
  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if v_inv.id is null then raise exception 'invoice not found' using errcode = 'P0002'; end if;
  if v_inv.stripe_invoice_id is not null and v_inv.stripe_invoice_id <> p_stripe_invoice_id then
    raise exception 'this invoice is already linked to a different Stripe invoice' using errcode = '23505';
  end if;
  update public.invoices
     set stripe_invoice_id = p_stripe_invoice_id,
         hosted_invoice_url = p_hosted_invoice_url,
         status = case when status = 'draft' then 'open' else status end
   where id = p_invoice_id;
end $$;
revoke all on function public.record_stripe_invoice(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_stripe_invoice(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Schedules (pg_cron + pg_net), reading the project address and service key from Vault.
--    Create the two Vault secrets once, in the SQL editor or with the setup script:
--      select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--      select vault.create_secret('<the legacy service_role JWT>', 'service_role_key');
--    (use the same value the functions see as SUPABASE_SERVICE_ROLE_KEY). Nothing is hard-coded here.
--    pg_cron runs in UTC, which has no daylight saving: 15 8 * * * is 3:15 AM Eastern Standard Time
--    and 4:15 AM Eastern Daylight Time (March to November). Both are quiet hours and clear of the 2:00 AM clock change.
--    p_check_extensions => false exists only so the test harness can exercise the SQL with stand-in cron/net/vault.
-- ---------------------------------------------------------------------------
create function public.e2e_install_schedules(p_check_extensions boolean default true)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_call text;
begin
  if p_check_extensions and (
       not exists (select 1 from pg_extension where extname = 'pg_cron')
    or not exists (select 1 from pg_extension where extname = 'pg_net')
    or to_regclass('vault.decrypted_secrets') is null) then
    return 'skipped: pg_cron, pg_net or Vault is not available here';
  end if;

  -- One reusable call. %s is the function name. The Vault values are read when the job runs, never stored in the job.
  v_call := $call$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/%s',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{}'::jsonb)
  $call$;

  perform cron.schedule('hoa-nightly-export', '15 8 * * *', format(v_call, 'nightly-export'));
  perform cron.schedule('hoa-stripe-outbox', '*/10 * * * *', format(v_call, 'stripe-outbox'));

  -- message-to-inbox needs the message id, so it is a trigger, not a timer. A failure here must never stop a
  -- message from being saved, so the function swallows errors.
  execute $fn$
    create or replace function public.messages_notify_inbox() returns trigger
    language plpgsql security definer set search_path = '' as $f$
    begin
      begin
        perform net.http_post(
          url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/message-to-inbox',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
          body := jsonb_build_object('message_id', new.id));
      exception when others then
        raise warning 'message-to-inbox not queued: %', sqlerrm;
      end;
      return null;
    end $f$
  $fn$;
  execute 'revoke all on function public.messages_notify_inbox() from public, anon, authenticated';
  execute 'drop trigger if exists messages_notify_inbox on public.messages';
  execute 'create trigger messages_notify_inbox after insert on public.messages for each row execute function public.messages_notify_inbox()';
  return 'installed';
end $$;
revoke all on function public.e2e_install_schedules(boolean) from public, anon, authenticated;
grant execute on function public.e2e_install_schedules(boolean) to service_role;

do $$ begin raise notice 'schedules: %', public.e2e_install_schedules(); end $$;
