begin;
-- treasurer (3) logs, secretary (4) confirms
select tests.as_user('b0000000-0000-4000-8000-000000000003');
create temp table c1 on commit drop as select * from public.log_check('00000000-0000-4000-8000-000000000042', '2001', 17500, date '2027-03-11');
select tests.ok((select state = 'received' and logged_by = 'b0000000-0000-4000-8000-000000000003' from c1), 'log_check records logger and state');
select tests.eq(tests.count($$select 1 from public.board_tasks where kind='check_confirm' and ref_id = (select id from c1)$$), 1::bigint, 'log_check opens a confirm task');
select tests.fails($$select public.log_check('00000000-0000-4000-8000-000000000042', '2001', 17500, date '2027-03-11')$$, 'duplicate|unique', 'same check cannot be logged twice');

select tests.fails($$select public.confirm_check_deposit((select id from c1), 'deposited')$$, 'different board member', 'same user cannot confirm own check');
select tests.fails($$select public.resolve_task((select id from public.board_tasks where ref_id = (select id from c1)), 'approve')$$, 'different board member', 'same user cannot confirm through resolve_task either');
select tests.fails($$update public.checks set state = 'deposited', deposit_confirmed_by = logged_by$$, 'permission denied', 'no direct update of checks');
reset role;
select tests.fails($$update public.checks set state = 'deposited', deposit_confirmed_by = logged_by where id = (select id from c1)$$, 'violates check constraint', 'table constraint also blocks same-user confirmation');
select tests.eq((select state from public.checks where id = (select id from c1)), 'received', 'check still received after refusals');
select tests.eq((select count(*) from public.ledger_entries where external_ref like 'check:%'), 0::bigint, 'no ledger payment from refused confirmation');

-- a different member confirms: deposited
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.fails($$select public.confirm_check_deposit((select id from c1), 'bogus')$$, 'outcome', 'bad outcome refused');
create temp table c2 on commit drop as select * from public.confirm_check_deposit((select id from c1), 'deposited');
select tests.ok((select state = 'deposited' and deposit_confirmed_by = 'b0000000-0000-4000-8000-000000000004' from c2), 'second person confirms deposit');
select tests.fails($$select public.confirm_check_deposit((select id from c1), 'returned')$$, 'already', 'cannot confirm twice');
reset role;
select tests.ok((select amount_cents = -17500 and status = 'cleared' and kind = 'payment' and method = 'check' from public.ledger_entries where external_ref = 'check:' || (select id from c1)), 'deposit adds a cleared check payment');
select tests.eq((select count(*) from public.board_tasks where status = 'open' and ref_id = (select id from c1)), 0::bigint, 'confirm closes the task and opens nothing');
select tests.eq((select count(*) from public.board_tasks where created_at >= now() and status = 'open' and kind <> 'check_confirm'), 0::bigint, 'no new tasks opened by deposit');
select tests.eq((select balance_cents from public.lot_balances where lot_id = '00000000-0000-4000-8000-000000000042'), 0::bigint, 'lot 42 balance is zero after check');
select tests.ok(exists (select 1 from public.audit_log where table_name = 'checks' and actor_id = 'b0000000-0000-4000-8000-000000000004'), 'check confirmation is audited');

-- returned: marks state only
select tests.as_user('b0000000-0000-4000-8000-000000000003');
create temp table c3 on commit drop as select * from public.log_check('00000000-0000-4000-8000-000000000043', '2002', 5000, date '2027-03-12');
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.eq((select status from public.resolve_task((select id from public.board_tasks where ref_id = (select id from c3)), 'reject', 'bounced')), 'done', 'reject on a check task is a recorded decision');
select tests.eq((select state from public.checks where id = (select id from c3)), 'returned', 'reject marks the check returned');
reset role;
select tests.ok((select count(*) = 1 and bool_and(status = 'returned' and amount_cents = -5000) from public.ledger_entries where external_ref = 'check:' || (select id from c3)), 'returned check leaves one returned ledger row');
select tests.eq((select balance_cents from public.lot_balances where lot_id = '00000000-0000-4000-8000-000000000043'), 17500::bigint, 'returned check does not change the balance');
select tests.eq((select count(*) from public.board_tasks where kind = 'payment_returned' and ref_id = (select id from c3) and status = 'open'), 1::bigint, 'returned check opens a payment_returned task');

-- non-board cannot call
insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000ff','stranger@example.net', now());
select tests.as_user('a0000000-0000-4000-8000-0000000000ff');
select tests.fails($$select public.log_check('00000000-0000-4000-8000-000000000042','3',100,'2027-01-01')$$, 'board only', 'non-board cannot log checks');
select tests.fails($$select public.confirm_check_deposit((select id from c1),'deposited')$$, 'board only', 'non-board cannot confirm checks');
select tests.fails($$select public.resolve_task(gen_random_uuid(),'approve')$$, 'board only', 'non-board cannot resolve tasks');
rollback;
