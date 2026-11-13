begin;
-- 0004_gaps: dismiss guard, returned checks, won disputes, bill run processing list.
create function pg_temp.bal(p_lot int) returns text language sql as $$
  select balance_cents || '/' || processing_cents || '/' || state from public.lot_balances
   where lot_id = ('00000000-0000-4000-8000-' || lpad(p_lot::text, 12, '0'))::uuid $$;
create function pg_temp.inv(p_number text) returns text language sql as $$
  select status from public.invoices where number = p_number $$;
create function pg_temp.pay(p_ref text, p_amount bigint, p_status text, p_desc text, p_method text default 'card', p_reinstate boolean default false)
returns jsonb language sql as $$
  select jsonb_build_object('external_ref', p_ref, 'posted_on', '2027-03-20', 'kind', 'payment', 'description', p_desc,
                            'amount_cents', p_amount, 'status', p_status, 'method', p_method)
         || case when p_reinstate then jsonb_build_object('reinstate', true) else '{}'::jsonb end $$;
create function pg_temp.ev(p_id text, p_type text, p_pi text, p_status text, p_force boolean, p_ledger jsonb, p_lot text default null, p_sid text default 'in_42')
returns jsonb language sql as $$
  select public.apply_stripe_event(p_id, jsonb_build_object('event_type', p_type, 'payment_intent', p_pi, 'invoice_status', p_status,
    'invoice_force', p_force, 'lot_hint', p_lot, 'stripe_invoice_id', p_sid, 'ledger', p_ledger)) $$;
grant execute on all functions in schema pg_temp to public;

-- ---------------------------------------------------------------------------
-- 1. dismiss cannot close check_confirm or claim_attach
-- ---------------------------------------------------------------------------
select tests.as_user('b0000000-0000-4000-8000-000000000003');
create temp table dk on commit drop as select * from public.log_check('00000000-0000-4000-8000-000000000042', '9001', 17500, date '2027-03-11');
select tests.fails($$select public.resolve_task((select id from public.board_tasks where ref_id = (select id from dk)), 'dismiss')$$,
  'cannot be dismissed', 'dismiss refused on a check_confirm task (logger)');
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.fails($$select public.resolve_task((select id from public.board_tasks where ref_id = (select id from dk)), 'dismiss', 'skip')$$,
  'cannot be dismissed', 'dismiss refused on a check_confirm task (second person)');
reset role;
select tests.ok((select t.status = 'open' and c.state = 'received' from public.board_tasks t, public.checks c where t.ref_id = c.id and c.id = (select id from dk)),
  'refused dismiss leaves the check received and the task open');

insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000e1', 'new.owner@example.net', now());
select tests.as_user('a0000000-0000-4000-8000-0000000000e1');
select public.redeem_claim_code('sample-code-0042');
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.fails($$select public.resolve_task((select id from public.board_tasks where kind = 'claim_attach' and status = 'open'), 'dismiss')$$,
  'cannot be dismissed', 'dismiss refused on a claim_attach task');
reset role;
select tests.ok((select count(*) = 1 from public.claim_requests where status = 'pending' and user_id = 'a0000000-0000-4000-8000-0000000000e1'), 'refused dismiss leaves the claim pending');
select tests.eq((select count(*) from public.lot_owners where owner_id in (select id from public.owners where user_id = 'a0000000-0000-4000-8000-0000000000e1')), 0::bigint, 'refused dismiss attaches nothing');

select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.eq((select status from public.resolve_task((select id from public.board_tasks where kind = 'template_reply' and status = 'open'), 'dismiss')), 'dismissed', 'dismiss still works on other kinds');
select tests.eq((select status from public.resolve_task((select id from public.board_tasks where kind = 'claim_attach' and status = 'open'), 'reject')), 'done', 'reject on a claim is still a recorded decision');
reset role;

-- ---------------------------------------------------------------------------
-- 2. returned checks
-- ---------------------------------------------------------------------------
update public.invoices set stripe_invoice_id = 'in_46' where number = '2027-046';
select tests.as_user('b0000000-0000-4000-8000-000000000003');
create temp table rk on commit drop as select * from public.log_check('00000000-0000-4000-8000-000000000046', '9100', 17500, date '2027-03-11');
select tests.fails($$select public.mark_check_returned((select id from rk))$$, 'not been deposited', 'a check that was never deposited cannot be marked returned this way');
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select public.confirm_check_deposit((select id from rk), 'deposited');
reset role;
select tests.eq(pg_temp.bal(46), '0/0/paid', 'deposited check clears the balance');
select tests.eq(pg_temp.inv('2027-046'), 'paid', 'and settles the invoice');
select tests.eq((select count(*) from public.stripe_outbox where stripe_invoice_id = 'in_46' and status = 'pending'), 1::bigint, 'outbox job queued');

-- the bank sends it back
select tests.as_anon();
select tests.fails($$select public.mark_check_returned((select id from rk))$$, 'permission denied', 'anon cannot mark a check returned');
reset role;
insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000ff','stranger@example.net', now());
select tests.as_user('a0000000-0000-4000-8000-0000000000ff');
select tests.fails($$select public.mark_check_returned((select id from rk))$$, 'board only', 'non-board cannot mark a check returned');
select tests.as_user('b0000000-0000-4000-8000-000000000003');
select tests.eq((select state from public.mark_check_returned((select id from rk), 'NSF')), 'returned', 'board marks a deposited check returned');
select tests.fails($$select public.mark_check_returned((select id from rk))$$, 'already returned', 'cannot mark it returned twice');
reset role;
select tests.eq((select status from public.ledger_entries where external_ref = 'check:' || (select id from rk)), 'returned', 'the payment ledger row is returned');
select tests.eq((select count(*) from public.ledger_entries where external_ref = 'check:' || (select id from rk)), 1::bigint, 'still one row for the check');
select tests.eq(pg_temp.bal(46), '17500/0/unpaid', 'balance goes back up');
select tests.ok((select status = 'open' and paid_on is null and not paid_outside_stripe from public.invoices where number = '2027-046'), 'the settled invoice reopens');
select tests.eq((select count(*) from public.stripe_outbox where stripe_invoice_id = 'in_46' and status = 'pending'), 0::bigint, 'the unsent "paid" job for Stripe is withdrawn');
select tests.eq((select count(*) from public.board_tasks where kind = 'payment_returned' and ref_id = (select id from rk) and status = 'open'), 1::bigint, 'a payment_returned task opens');
select tests.like_msg((select summary from public.board_tasks where kind = 'payment_returned' and ref_id = (select id from rk)), 'NSF', 'the task carries the board note');
select tests.ok(exists (select 1 from public.audit_log where table_name = 'checks' and row_id = (select id from rk)::text and actor_id = 'b0000000-0000-4000-8000-000000000003' and action = 'UPDATE'), 'marking a check returned is audited');

-- ---------------------------------------------------------------------------
-- 3. charge.dispute.closed
-- ---------------------------------------------------------------------------
update public.invoices set stripe_invoice_id = 'in_42' where number = '2027-042';
update public.invoices set stripe_invoice_id = 'in_47' where number = '2027-047';
set local role service_role;
select pg_temp.ev('d_1', 'invoice.paid', 'pi_d', 'paid', false, jsonb_build_array(pg_temp.pay('pi_d', -17500, 'cleared', 'Payment received')), null);
reset role;
select tests.eq(pg_temp.bal(42), '0/0/paid', 'setup: lot 42 paid by card');
set local role service_role;
select pg_temp.ev('d_2', 'charge.dispute.created', 'pi_d', 'open', true, jsonb_build_array(pg_temp.pay('pi_d', -17500, 'returned', 'Payment disputed')), null);
reset role;
select tests.eq(pg_temp.bal(42), '17500/0/unpaid', 'dispute pulls the payment back');
set local role service_role;
-- lost: stays returned (an event with no changes is still recorded)
select pg_temp.ev('d_3', 'charge.dispute.closed', 'pi_d', null, false, '[]'::jsonb, null);
reset role;
select tests.eq(pg_temp.bal(42), '17500/0/unpaid', 'lost dispute stays returned');
select tests.eq(pg_temp.inv('2027-042'), 'open', 'lost dispute leaves the invoice open');
select tests.eq((select count(*) from public.processed_events where id = 'd_3'), 1::bigint, 'lost dispute event is recorded');
set local role service_role;
-- won: the payment is cleared again
select pg_temp.ev('d_4', 'charge.dispute.closed', 'pi_d', 'paid', true, jsonb_build_array(pg_temp.pay('pi_d', -17500, 'cleared', 'Payment received', 'card', true)), null);
reset role;
select tests.eq(pg_temp.bal(42), '0/0/paid', 'won dispute clears the payment again');
select tests.eq(pg_temp.inv('2027-042'), 'paid', 'won dispute settles the invoice again');
select tests.eq((select count(*) from public.ledger_entries where external_ref = 'pi_d'), 1::bigint, 'still one row for the payment');
select tests.eq((select description from public.ledger_entries where external_ref = 'pi_d'), 'Payment received', 'row reads as a normal payment again');
-- replay and a second closed event change nothing
set local role service_role;
select tests.eq((pg_temp.ev('d_4', 'charge.dispute.closed', 'pi_d', 'paid', true, jsonb_build_array(pg_temp.pay('pi_d', -17500, 'cleared', 'Payment received', 'card', true)), null)) ->> 'duplicate', 'true', 'replayed won event is a duplicate');
select pg_temp.ev('d_5', 'charge.dispute.closed', 'pi_d', 'paid', true, jsonb_build_array(pg_temp.pay('pi_d', -17500, 'cleared', 'Payment received', 'card', true)), null);
reset role;
select tests.eq(pg_temp.bal(42), '0/0/paid', 'a second won event with a new id changes nothing');
-- a won dispute that finds nothing disputed must not mark an unpaid invoice paid
set local role service_role;
select pg_temp.ev('d_6', 'charge.dispute.closed', 'pi_ghost', 'paid', true, jsonb_build_array(pg_temp.pay('pi_ghost', -17500, 'cleared', 'Payment received', 'card', true)), '00000000-0000-4000-8000-000000000047', 'in_47');
reset role;
select tests.eq(pg_temp.bal(47), '17500/0/unpaid', 'won dispute with no disputed payment posts nothing');
select tests.eq(pg_temp.inv('2027-047'), 'open', 'and does not mark the invoice paid');
-- a bank-returned payment is not brought back by a dispute event
set local role service_role;
select pg_temp.ev('d_7', 'charge.dispute.closed', 'pi_sample_003', 'paid', true, jsonb_build_array(pg_temp.pay('pi_sample_003', -17500, 'cleared', 'Payment received', 'card', true)), null, null);
reset role;
select tests.eq((select status from public.ledger_entries where external_ref = 'pi_sample_003'), 'returned', 'an ACH-returned payment stays returned');

-- ---------------------------------------------------------------------------
-- 4. apply_bill_run lists lots with bank payments still processing
-- ---------------------------------------------------------------------------
select tests.eq(pg_temp.bal(8), '17500/17500/processing', 'setup: lot 8 has a bank payment processing');
set local role service_role;
create temp table bp on commit drop as select public.apply_bill_run(date '2028-01-29', jsonb_build_array(
  jsonb_build_object('lot_id','00000000-0000-4000-8000-000000000008','number','2028-008','description','2028 annual assessment','due_on','2028-05-15','assessment_cents',18000,'total_cents',35500,'processing_cents',17500),
  jsonb_build_object('lot_id','00000000-0000-4000-8000-000000000009','number','2028-009','description','2028 annual assessment','due_on','2028-05-15','assessment_cents',18000,'total_cents',18000,'processing_cents',0))) as r;
reset role;
select tests.eq((select r->'with_processing' from bp), '["2028-008"]'::jsonb, 'bill run lists the invoice whose lot has processing payments');
select tests.eq((select amount_cents from public.invoices where number = '2028-008'), 35500::bigint, 'processing payments are not subtracted from the invoice (same rule as lot_balances)');
set local role service_role;
create temp table bp2 on commit drop as select public.apply_bill_run(date '2028-01-29', jsonb_build_array(
  jsonb_build_object('lot_id','00000000-0000-4000-8000-000000000008','number','2028-008','description','2028 annual assessment','due_on','2028-05-15','assessment_cents',18000,'total_cents',35500,'processing_cents',17500))) as r;
reset role;
select tests.ok((select (r->>'created')::int = 0 and (r->>'charges_posted')::int = 0 from bp2), 're-run stays idempotent');
rollback;
