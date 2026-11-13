begin;
-- lot_balances values for sample lots (see rules in seed/sample.sql)
create temp table expect (lot int, bal bigint, proc bigint, st text) on commit drop;
insert into expect values
  (42, 17500, 0, 'unpaid'),       -- unpaid
  (5, 0, 0, 'paid'),              -- paid and cleared
  (8, 17500, 17500, 'processing'),-- ACH still processing: not subtracted, shown separately
  (3, 17500, 0, 'unpaid'),        -- ACH returned: counts for nothing
  (65, -5000, 0, 'credit'),       -- paid, plus a 5000 carried credit
  (11, 42500, 0, 'unpaid'),       -- carried 25000 arrears
  (55, 25000, 0, 'unpaid');       -- paid this year, arrears remain
select tests.eq((select count(*) from expect e join public.lots l on l.lot_number = e.lot
                  join public.lot_balances b on b.lot_id = l.id
                  where b.balance_cents = e.bal and b.processing_cents = e.proc and b.state = e.st),
                (select count(*) from expect), 'lot_balances matches expected values for 7 sample lots');
select tests.eq((select count(*) from public.lot_balances), 150::bigint, 'one balance row per lot');
select tests.eq((select array_agg(column_name::text order by ordinal_position) from information_schema.columns
                  where table_schema='public' and table_name='lot_balances'),
                array['lot_id','balance_cents','processing_cents','state'], 'lot_balances columns');
select tests.eq((select count(*) from public.ledger_entries where lot_id = '00000000-0000-4000-8000-000000000008' and status = 'processing'), 1::bigint, 'lot 8 has one processing payment');

-- webhook-style duplicates are rejected, upsert-on-conflict is a no-op
set local role service_role;
insert into public.ledger_entries (lot_id, posted_on, kind, description, amount_cents, status, method, external_ref)
values ('00000000-0000-4000-8000-000000000042', '2027-03-20', 'payment', 'Payment by bank', -17500, 'processing', 'ach', 'pi_webhook_1');
select tests.fails($$insert into public.ledger_entries (lot_id, posted_on, kind, description, amount_cents, status, method, external_ref)
  values ('00000000-0000-4000-8000-000000000042', '2027-03-20', 'payment', 'Payment by bank', -17500, 'processing', 'ach', 'pi_webhook_1')$$,
  'duplicate key', 'duplicate webhook ledger insert rejected');
select tests.fails($$insert into public.ledger_entries (lot_id, posted_on, kind, description, amount_cents, status, method, external_ref)
  values ('00000000-0000-4000-8000-000000000043', '2027-03-20', 'payment', 'x', -1, 'processing', 'ach', 'pi_webhook_1')$$,
  'duplicate key', 'external_ref is unique across lots too');
insert into public.ledger_entries (lot_id, posted_on, kind, description, amount_cents, status, method, external_ref)
values ('00000000-0000-4000-8000-000000000042', '2027-03-20', 'payment', 'dup', -17500, 'processing', 'ach', 'pi_webhook_1')
on conflict (external_ref) do nothing;
select tests.eq((select count(*) from public.ledger_entries where external_ref = 'pi_webhook_1'), 1::bigint, 'upsert on external_ref keeps one row');
insert into public.ledger_entries (lot_id, posted_on, kind, description, amount_cents) values
  ('00000000-0000-4000-8000-000000000042', '2027-03-21', 'charge', 'manual a', 100),
  ('00000000-0000-4000-8000-000000000042', '2027-03-21', 'charge', 'manual b', 100);
select tests.ok(true, 'NULL external_ref rows may repeat');
select tests.fails($$insert into public.invoices (lot_id, number, description, amount_cents, due_on) values ('00000000-0000-4000-8000-000000000042','2027-042','dup',1,'2027-01-01')$$, 'duplicate key', 'invoice number is unique');
select tests.fails($$insert into public.invoices (lot_id, number, description, amount_cents, due_on, stripe_invoice_id) values ('00000000-0000-4000-8000-000000000043','Z-1','a',1,'2027-01-01','in_1'),('00000000-0000-4000-8000-000000000044','Z-2','a',1,'2027-01-01','in_1')$$, 'duplicate key', 'stripe_invoice_id is unique');
select tests.fails($$insert into public.ledger_entries (lot_id, posted_on, kind, description, amount_cents) values ('00000000-0000-4000-8000-000000000042','2027-03-21','payment','wrong sign',500)$$, 'check constraint', 'payment must not increase the balance');
-- processing payment shows in view as processing, balance unchanged: 17500 + 200 manual
reset role;
select tests.ok((select balance_cents = 17700 and processing_cents = 17500 and state = 'unpaid' from public.lot_balances where lot_id = '00000000-0000-4000-8000-000000000042'),
  'processing payment on lot 42 shown separately; 200 balance remaining keeps it unpaid');
-- clearing it
update public.ledger_entries set status = 'cleared' where external_ref = 'pi_webhook_1';
select tests.ok((select balance_cents = 200 and processing_cents = 0 from public.lot_balances where lot_id = '00000000-0000-4000-8000-000000000042'), 'cleared payment is subtracted');
rollback;
