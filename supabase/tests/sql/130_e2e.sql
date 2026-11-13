-- 0007_e2e: stripe_customers, the two record_* functions, and the schedule installer.
begin;

-- ---------------------------------------------------------------------------
-- record_stripe_customer
-- ---------------------------------------------------------------------------
select tests.as_anon();
select tests.fails($$select public.record_stripe_customer('00000000-0000-4000-8000-000000000042', 'cus_x')$$, 'permission denied', 'anon cannot save a Stripe customer');
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.fails($$select public.record_stripe_customer('00000000-0000-4000-8000-000000000042', 'cus_x')$$, 'permission denied', 'a board member cannot call the service function');
select tests.fails($$select 1 from public.stripe_customers$$, 'permission denied', 'a board member cannot read stripe_customers');
reset role;

set local role service_role;
select public.record_stripe_customer('00000000-0000-4000-8000-000000000042', 'cus_42');
select public.record_stripe_customer('00000000-0000-4000-8000-000000000042', 'cus_42');
select tests.eq((select count(*) from public.stripe_customers where lot_id = '00000000-0000-4000-8000-000000000042'), 1::bigint, 'saving the same customer twice keeps one row');
select tests.fails($$select public.record_stripe_customer('00000000-0000-4000-8000-000000000042', 'cus_other')$$, 'different Stripe customer', 'a second, different customer for a lot is refused');
select tests.fails($$select public.record_stripe_customer('00000000-0000-4000-8000-000000000043', 'sk_live_nope')$$, 'not a Stripe customer', 'a malformed customer id is refused');
reset role;

-- ---------------------------------------------------------------------------
-- record_stripe_invoice
-- ---------------------------------------------------------------------------
-- lot 42 is "open" in the sample; make a draft to see the draft -> open move
update public.invoices set status = 'draft' where number = '2027-042';
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.fails($$select public.record_stripe_invoice('20000000-0000-4000-8000-000000000042', 'in_42', 'https://invoice.stripe.com/i/test_42')$$,
                   'permission denied', 'a board member cannot call record_stripe_invoice');
reset role;
set local role service_role;
select public.record_stripe_invoice('20000000-0000-4000-8000-000000000042', 'in_42', 'https://invoice.stripe.com/i/test_42');
select public.record_stripe_invoice('20000000-0000-4000-8000-000000000042', 'in_42', 'https://invoice.stripe.com/i/test_42');
select tests.eq((select status || '/' || stripe_invoice_id || '/' || hosted_invoice_url from public.invoices where number = '2027-042'),
                'open/in_42/https://invoice.stripe.com/i/test_42', 'the draft became open and carries the Stripe id and link (twice is fine)');
select tests.fails($$select public.record_stripe_invoice('20000000-0000-4000-8000-000000000042', 'in_other', 'https://invoice.stripe.com/i/x')$$,
                   'already linked', 'an invoice cannot be re-pointed to another Stripe invoice');
select tests.fails($$select public.record_stripe_invoice('20000000-0000-4000-8000-000000000043', 'in_43', 'http://insecure')$$, 'https', 'a non-https link is refused');
select tests.fails($$select public.record_stripe_invoice('20000000-0000-4000-8000-000000000043', 'xx_43', 'https://a.b/c')$$, 'not a Stripe invoice', 'a malformed invoice id is refused');
select tests.fails($$select public.record_stripe_invoice(gen_random_uuid(), 'in_99', 'https://a.b/c')$$, 'not found', 'an unknown invoice is refused');
select public.record_stripe_invoice('20000000-0000-4000-8000-000000000045', 'in_45', 'https://invoice.stripe.com/i/test_45');
select tests.eq((select status from public.invoices where number = '2027-045'), 'paid', 'a paid invoice stays paid when linked');
reset role;

reset role;

-- ---------------------------------------------------------------------------
-- schedules: skipped where pg_cron / pg_net are missing (this harness)
-- ---------------------------------------------------------------------------
select tests.ok(public.e2e_install_schedules() like 'skipped%', 'schedules skip cleanly without pg_cron, pg_net and Vault');
select tests.eq((select count(*) from pg_trigger where tgname = 'messages_notify_inbox'), 0::bigint, 'no inbox trigger is installed when the extensions are missing');

-- ---------------------------------------------------------------------------
-- schedules with stand-in cron / net / vault (extension check bypassed for the test only)
-- ---------------------------------------------------------------------------
create schema cron; create schema net; create schema vault;
create table cron.jobs (name text primary key, schedule text, command text);
create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as
  $$ insert into cron.jobs values (p_name, p_schedule, p_command) on conflict (name) do update set schedule = excluded.schedule, command = excluded.command returning 1::bigint $$;
create table net.calls (url text, headers jsonb, body jsonb);
create function net.http_post(url text, headers jsonb, body jsonb) returns bigint language plpgsql as
  $$ begin if url is null then raise exception 'no url'; end if; insert into net.calls values (url, headers, body); return 1; end $$;
create table vault.secrets_t (name text, decrypted_secret text);
create view vault.decrypted_secrets as select * from vault.secrets_t;
insert into vault.secrets_t values ('project_url', 'https://example-ref.supabase.co'), ('service_role_key', 'stand-in-service-key');

select tests.eq(public.e2e_install_schedules(false), 'installed', 'schedules install when told the extensions are there');
select public.e2e_install_schedules(false);
select tests.eq((select count(*) from cron.jobs), 2::bigint, 'two timed jobs, and running the installer again adds none');
select tests.eq((select schedule from cron.jobs where name = 'hoa-nightly-export'), '15 8 * * *', 'nightly export at 08:15 UTC (3:15 AM EST, 4:15 AM EDT)');
select tests.eq((select schedule from cron.jobs where name = 'hoa-stripe-outbox'), '*/10 * * * *', 'outbox drain every 10 minutes');
select tests.ok((select command from cron.jobs where name = 'hoa-nightly-export') like '%/functions/v1/nightly-export%', 'the export job calls nightly-export');
select tests.ok((select command from cron.jobs where name = 'hoa-stripe-outbox') like '%/functions/v1/stripe-outbox%', 'the outbox job calls stripe-outbox');
select tests.ok((select bool_and(command like '%vault.decrypted_secrets%' and command not like '%stand-in-service-key%' and command not like '%example-ref%') from cron.jobs),
                'jobs read the Vault at run time and hold no address or key');

-- the job text really runs and sends the Vault values
do $$ declare c text; begin
  select command into c from cron.jobs where name = 'hoa-nightly-export'; execute c; end $$;
select tests.eq((select url from net.calls order by url limit 1), 'https://example-ref.supabase.co/functions/v1/nightly-export', 'job posts to the project function address');
select tests.eq((select headers ->> 'Authorization' from net.calls limit 1), 'Bearer stand-in-service-key', 'job sends the service key from Vault');
delete from net.calls;

-- a new message queues message-to-inbox with its id
insert into public.messages (id, lot_id, owner_id, topic, subject, body)
values ('77777777-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000042', '10000000-0000-4000-8000-000000000042', 'question', 'Hello', 'Hi board');
select tests.eq((select body ->> 'message_id' from net.calls where url like '%message-to-inbox'), '77777777-0000-4000-8000-000000000001', 'a new message queues message-to-inbox with its id');

-- and a broken setup never blocks saving a message
delete from vault.secrets_t;
select tests.ok((select count(*) from public.messages where id = '77777777-0000-4000-8000-000000000001') = 1, 'message saved');
insert into public.messages (id, lot_id, owner_id, topic, subject, body)
values ('77777777-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000042', '10000000-0000-4000-8000-000000000042', 'question', 'Again', 'Hi again');
select tests.eq((select count(*) from public.messages where id = '77777777-0000-4000-8000-000000000002'), 1::bigint, 'a message is still saved when the inbox call cannot be queued');

rollback;
