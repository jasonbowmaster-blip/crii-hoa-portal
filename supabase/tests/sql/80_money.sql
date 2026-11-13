begin;
-- apply_stripe_event / apply_bill_run / check settlement, judged by the lot_balances view.
-- Lot 42 owes 17500 (invoice 2027-042). We link it to Stripe ids first, like the bill run would.
update public.invoices set stripe_invoice_id = 'in_42' where number = '2027-042';
update public.invoices set stripe_invoice_id = 'in_43' where number = '2027-002';

create function pg_temp.bal(p_lot int) returns text language sql as $$
  select balance_cents || '/' || processing_cents || '/' || state from public.lot_balances
   where lot_id = ('00000000-0000-4000-8000-' || lpad(p_lot::text, 12, '0'))::uuid $$;
create function pg_temp.inv(p_number text) returns text language sql as $$
  select status from public.invoices where number = p_number $$;
create function pg_temp.pay_rows(p_ref text) returns bigint language sql as $$
  select count(*) from public.ledger_entries where external_ref = p_ref $$;
-- one event applied through the rpc, as the webhook does
create function pg_temp.ev(p_id text, p_changes jsonb) returns jsonb language sql as $$
  select public.apply_stripe_event(p_id, p_changes) $$;
create function pg_temp.pay(p_ref text, p_amount bigint, p_status text, p_desc text default 'Payment') returns jsonb language sql as $$
  select jsonb_build_object('external_ref', p_ref, 'posted_on', '2027-03-20', 'kind', 'payment', 'description', p_desc,
                            'amount_cents', p_amount, 'status', p_status, 'method', 'ach') $$;
create function pg_temp.refund(p_ref text, p_amount bigint) returns jsonb language sql as $$
  select jsonb_build_object('external_ref', p_ref, 'posted_on', '2027-04-01', 'kind', 'refund', 'description', 'Refund',
                            'amount_cents', p_amount, 'status', 'cleared') $$;
grant execute on all functions in schema pg_temp to public;
set local role service_role;

select tests.eq(pg_temp.bal(42), '17500/0/unpaid', 'lot 42 starts owing');

-- ACH: processing -> succeeded: ONE row, ends cleared
select pg_temp.ev('evt_1', jsonb_build_object('event_type','payment_intent.processing','payment_intent','pi_a','stripe_invoice_id','in_42',
  'invoice_status','processing','ledger', jsonb_build_array(pg_temp.pay('pi_a', -17500, 'processing', 'Bank payment processing'))));
select tests.eq(pg_temp.bal(42), '17500/17500/processing', 'processing payment shown separately');
select tests.eq(pg_temp.inv('2027-042'), 'processing', 'invoice processing');
select pg_temp.ev('evt_2', jsonb_build_object('event_type','invoice.paid','payment_intent','pi_a','stripe_invoice_id','in_42',
  'invoice_status','paid','ledger', jsonb_build_array(pg_temp.pay('pi_a', -17500, 'cleared', 'Payment received'))));
select tests.eq(pg_temp.pay_rows('pi_a'), 1::bigint, 'settling updates the processing row, no second row');
select tests.eq(pg_temp.bal(42), '0/0/paid', 'ACH settled: balance zero and paid');
select tests.eq(pg_temp.inv('2027-042'), 'paid', 'invoice paid');
select tests.eq((select method from public.ledger_entries where external_ref = 'pi_a'), 'ach', 'row keeps its method');

-- duplicate delivery of the same event: no change
select tests.eq((pg_temp.ev('evt_2', jsonb_build_object('event_type','invoice.paid','payment_intent','pi_a','stripe_invoice_id','in_42',
  'invoice_status','paid','ledger', jsonb_build_array(pg_temp.pay('pi_a', -17500, 'cleared'))))) ->> 'duplicate', 'true', 'duplicate event id reported as duplicate');
select tests.eq((select count(*) from public.processed_events where id = 'evt_2'), 1::bigint, 'event id recorded once');
-- late processing event (out of order) must not move the row backwards
select pg_temp.ev('evt_3', jsonb_build_object('event_type','payment_intent.processing','payment_intent','pi_a','stripe_invoice_id','in_42',
  'invoice_status','processing','ledger', jsonb_build_array(pg_temp.pay('pi_a', -17500, 'processing'))));
select tests.eq(pg_temp.bal(42), '0/0/paid', 'late processing event does not regress a cleared payment');
select tests.eq(pg_temp.inv('2027-042'), 'paid', 'late processing event does not regress the invoice');

-- ACH dispute / return after settle flips the same row; found through payment_intent only
select pg_temp.ev('evt_4', jsonb_build_object('event_type','charge.dispute.created','payment_intent','pi_a','invoice_status','open','invoice_force',true,
  'ledger', jsonb_build_array(pg_temp.pay('pi_a', -17500, 'returned', 'Payment disputed')),
  'tasks', jsonb_build_array(jsonb_build_object('kind','payment_returned','title','Payment disputed','summary','x'))));
select tests.eq(pg_temp.pay_rows('pi_a'), 1::bigint, 'dispute updates the same row');
select tests.eq(pg_temp.bal(42), '17500/0/unpaid', 'dispute puts the money back on the balance');
select tests.eq(pg_temp.inv('2027-042'), 'open', 'dispute reopens the invoice');
select tests.eq((select count(*) from public.board_tasks where kind = 'payment_returned' and lot_id = '00000000-0000-4000-8000-000000000042' and status = 'open'),
  1::bigint, 'dispute opens a payment_returned task');
-- a late invoice.paid replay with a NEW event id must not mark it paid again
select pg_temp.ev('evt_5', jsonb_build_object('event_type','invoice.paid','payment_intent','pi_a','stripe_invoice_id','in_42',
  'invoice_status','paid','ledger', jsonb_build_array(pg_temp.pay('pi_a', -17500, 'cleared'))));
select tests.eq(pg_temp.bal(42), '17500/0/unpaid', 'late paid event cannot undo a dispute');
select tests.eq(pg_temp.inv('2027-042'), 'open', 'late paid event leaves the invoice open');

-- card: paid then disputed, lot found via invoice, dispute resolved via payment_intent alone
select pg_temp.ev('evt_6', jsonb_build_object('event_type','invoice.paid','payment_intent','pi_card','stripe_invoice_id','in_43',
  'invoice_status','paid','ledger', jsonb_build_array(pg_temp.pay('pi_card', -17500, 'cleared'))));
select tests.eq(pg_temp.bal(2), '0/0/paid', 'card payment paid');
select pg_temp.ev('evt_7', jsonb_build_object('event_type','charge.dispute.created','payment_intent','pi_card','invoice_status','open','invoice_force',true,
  'ledger', jsonb_build_array(pg_temp.pay('pi_card', -17500, 'returned')),
  'tasks', jsonb_build_array(jsonb_build_object('kind','payment_returned','title','Payment disputed','summary','x'))));
select tests.eq(pg_temp.bal(2), '17500/0/unpaid', 'card dispute flips the lot back to owing');
select tests.eq(pg_temp.inv('2027-002'), 'open', 'card dispute reopens the invoice');
select tests.eq((select count(*) from public.board_tasks where kind = 'payment_returned' and lot_id = '00000000-0000-4000-8000-000000000002'),
  1::bigint, 'card dispute opens one task');

-- ACH return (processing -> failed)
update public.invoices set stripe_invoice_id = 'in_44' where number = '2027-004';
select pg_temp.ev('evt_8', jsonb_build_object('event_type','payment_intent.processing','payment_intent','pi_r','stripe_invoice_id','in_44',
  'invoice_status','processing','ledger', jsonb_build_array(pg_temp.pay('pi_r', -17500, 'processing'))));
select pg_temp.ev('evt_9', jsonb_build_object('event_type','payment_intent.payment_failed','payment_intent','pi_r','stripe_invoice_id','in_44',
  'invoice_status','open','invoice_force',true, 'ledger', jsonb_build_array(pg_temp.pay('pi_r', -17500, 'returned', 'Bank payment returned'))));
select tests.eq(pg_temp.pay_rows('pi_r'), 1::bigint, 'return keeps one row');
select tests.eq(pg_temp.bal(4), '17500/0/unpaid', 'ACH return: owing again, nothing processing');

-- two partial refunds: each by refund id, own amount; replay of one refund event id is a no-op
select pg_temp.ev('evt_10', jsonb_build_object('event_type','refund.created','payment_intent','pi_card','ledger', jsonb_build_array(pg_temp.refund('re_1', 5000))));
select pg_temp.ev('evt_11', jsonb_build_object('event_type','refund.created','payment_intent','pi_card','ledger', jsonb_build_array(pg_temp.refund('re_2', 5000))));
select pg_temp.ev('evt_12', jsonb_build_object('event_type','charge.refunded','payment_intent','pi_card','ledger', jsonb_build_array(pg_temp.refund('re_1', 5000), pg_temp.refund('re_2', 5000))));
select tests.eq((select count(*) from public.ledger_entries where kind = 'refund' and external_ref like 're\_%'), 2::bigint, 'each refund posted once by refund id');
select tests.eq(pg_temp.bal(2), '27500/0/unpaid', 'two $50 refunds add exactly $100');

-- an event whose lot cannot be found is NOT recorded, so a retry can apply it later
select tests.eq((pg_temp.ev('evt_13', jsonb_build_object('event_type','charge.dispute.created','payment_intent','pi_nobody',
  'ledger', jsonb_build_array(pg_temp.pay('pi_nobody', -100, 'returned'))))) ->> 'reason', 'lot_not_found', 'unknown payment reported');
select tests.eq((select count(*) from public.processed_events where id = 'evt_13'), 0::bigint, 'unplaced event not recorded');
-- metadata lot hint is the last resort
select tests.eq((pg_temp.ev('evt_14', jsonb_build_object('event_type','payment_intent.processing','payment_intent','pi_hint',
  'lot_hint','00000000-0000-4000-8000-000000000045','ledger', jsonb_build_array(pg_temp.pay('pi_hint', -500, 'processing'))))) ->> 'applied', 'true', 'lot hint used only as fallback');

-- privileges: service_role only
reset role;
select tests.as_user('b0000000-0000-4000-8000-000000000003');
select tests.fails($$select public.apply_stripe_event('evt_x', '{}'::jsonb)$$, 'permission denied', 'board member cannot call apply_stripe_event');
select tests.fails($$select public.apply_bill_run(current_date, '[]'::jsonb)$$, 'permission denied', 'board member cannot call apply_bill_run');
select tests.fails($$select count(*) from public.processed_events$$, 'permission denied', 'owners and board cannot read processed_events');
reset role;
select tests.as_anon();
select tests.fails($$select public.apply_stripe_event('evt_x', '{}'::jsonb)$$, 'permission denied', 'anon cannot call apply_stripe_event');
reset role;

-- ---------------------------------------------------------------------------
-- Check deposit settles the matching open invoice outside Stripe
-- ---------------------------------------------------------------------------
select tests.as_user('b0000000-0000-4000-8000-000000000003');
create temp table ck on commit drop as select * from public.log_check('00000000-0000-4000-8000-000000000046', '3001', 17500, date '2027-03-11');
reset role;
update public.invoices set stripe_invoice_id = 'in_46' where number = '2027-046';
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select public.confirm_check_deposit((select id from ck), 'deposited');
reset role;
select tests.eq(pg_temp.inv('2027-046'), 'paid', 'deposited check marks the matching invoice paid');
select tests.ok((select paid_outside_stripe and paid_on is not null from public.invoices where number = '2027-046'), 'invoice flagged paid_outside_stripe with a date');
select tests.eq(pg_temp.bal(46), '0/0/paid', 'lot balance zero after the check');
select tests.eq((select count(*) from public.stripe_outbox where stripe_invoice_id = 'in_46' and kind = 'mark_paid_out_of_band' and status = 'pending'),
  1::bigint, 'a job is queued to tell Stripe');
select tests.eq((select invoice_id from public.ledger_entries where external_ref = 'check:' || (select id from ck)), (select id from public.invoices where number = '2027-046'), 'check payment row linked to the invoice');
-- the Stripe invoice.paid that follows must not pay twice
set local role service_role;
select pg_temp.ev('evt_15', jsonb_build_object('event_type','invoice.paid','payment_intent',null,'stripe_invoice_id','in_46',
  'invoice_status','paid','ledger', jsonb_build_array(pg_temp.pay('invoice:in_46', -17500, 'cleared'))));
reset role;
select tests.eq(pg_temp.bal(46), '0/0/paid', 'out-of-band invoice.paid does not post a second payment');

-- ---------------------------------------------------------------------------
-- Bill run: credits, idempotent re-run, yearly charge row
-- ---------------------------------------------------------------------------
-- lot 65 has a 5000 credit (see 60_ledger). Give lot 70 a big credit so it exceeds the dues.
insert into public.ledger_entries (lot_id, posted_on, kind, description, amount_cents, status)
values ('00000000-0000-4000-8000-000000000070', '2027-06-01', 'credit', 'Overpayment', -90000, 'cleared');
set local role service_role;
create temp table br1 on commit drop as select public.apply_bill_run(date '2028-01-29', jsonb_build_array(
  jsonb_build_object('lot_id','00000000-0000-4000-8000-000000000070','number','2028-070','description','2028 annual assessment','due_on','2028-05-15','assessment_cents',18000,'total_cents',0),
  jsonb_build_object('lot_id','00000000-0000-4000-8000-000000000071','number','2028-071','description','2028 annual assessment','due_on','2028-05-15','assessment_cents',18000,'total_cents',18000))) as r;
reset role;
select tests.ok((select (r->>'created')::int = 2 and (r->>'already_existing')::int = 0 and (r->>'charges_posted')::int = 2 from br1), 'first run creates 2 invoices and 2 charges');
select tests.ok((select status = 'paid' and amount_cents = 0 from public.invoices where number = '2028-070'), 'credit lot gets a zero invoice, already paid');
select tests.eq((select status from public.invoices where number = '2028-071'), 'draft', 'normal lot gets a draft');
select tests.eq((select amount_cents from public.ledger_entries where external_ref = 'inv:2028-070'), 18000::bigint, 'yearly charge row posted at the assessment');
select tests.eq(pg_temp.bal(70), '-72000/0/credit', 'credit lot keeps the rest of its credit');
set local role service_role;
create temp table br2 on commit drop as select public.apply_bill_run(date '2028-01-29', jsonb_build_array(
  jsonb_build_object('lot_id','00000000-0000-4000-8000-000000000070','number','2028-070','description','2028 annual assessment','due_on','2028-05-15','assessment_cents',18000,'total_cents',0),
  jsonb_build_object('lot_id','00000000-0000-4000-8000-000000000071','number','2028-071','description','2028 annual assessment','due_on','2028-05-15','assessment_cents',18000,'total_cents',19000))) as r;
reset role;
select tests.ok((select (r->>'created')::int = 0 and (r->>'already_existing')::int = 2 and (r->>'charges_posted')::int = 0 from br2), 're-run reports 0 created, 2 existing, 0 new charges');
select tests.eq((select r->'differing' from br2), '["2028-071"]'::jsonb, 're-run lists the invoice whose amount differs');
select tests.eq((select count(*) from public.ledger_entries where external_ref like 'inv:2028-%'), 2::bigint, 'charges not duplicated');
select tests.eq((select amount_cents from public.invoices where number = '2028-071'), 18000::bigint, 'existing invoice is not overwritten');
rollback;
