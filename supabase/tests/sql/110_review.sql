-- 0005_review: former owners, board packets, check confirmer, business days, check dates, message lot,
-- credit-only bill run lots, Stripe quarantine, claim approval onto the roster owner, audit of service writes.

-- ===========================================================================
-- 1. Former owners lose access after ends_on (ends_on is the LAST day of access)
-- ===========================================================================
begin;
insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-000000000042', 'pat.example@example.com', now());
select tests.as_user('a0000000-0000-4000-8000-000000000042');
select tests.eq(tests.count('select 1 from public.messages'), 1::bigint, 'current owner reads own message');
select tests.eq(tests.count('select 1 from public.lot_owners'), 1::bigint, 'current owner reads own lot_owners row');
select tests.eq((select count(*) from public.my_owner_ids()), 1::bigint, 'my_owner_ids has the current record');
reset role;

update public.lot_owners set ends_on = current_date where owner_id = '10000000-0000-4000-8000-000000000042';
select tests.as_user('a0000000-0000-4000-8000-000000000042');
select tests.eq(tests.count('select 1 from public.messages'), 1::bigint, 'on ends_on itself the seller still has access (last day)');
select tests.eq(tests.count('select 1 from public.lots'), 1::bigint, 'last day: lot still visible');
reset role;

update public.lot_owners set ends_on = current_date - 1 where owner_id = '10000000-0000-4000-8000-000000000042';
select tests.as_user('a0000000-0000-4000-8000-000000000042');
select tests.eq(tests.count('select 1 from public.messages'), 0::bigint, 'the day after ends_on the seller sees no messages');
select tests.eq(tests.count('select 1 from public.lot_owners'), 0::bigint, 'the seller sees no lot_owners row');
select tests.eq(tests.count('select 1 from public.lots'), 0::bigint, 'the seller sees no lot');
select tests.eq(tests.count('select 1 from public.invoices'), 0::bigint, 'the seller sees no invoice');
select tests.eq((select count(*) from public.my_owner_ids()), 0::bigint, 'my_owner_ids is empty for the seller');
select tests.eq(tests.count('select 1 from public.owners'), 1::bigint, 'the seller can still read their own contact record');
select tests.fails($$select public.send_message('question','still here?')$$, 'no owner record', 'the seller cannot send messages for the lot');
reset role;

-- the buyer starts the day after the seller ends; sees the lot but not the seller's messages
update public.owners set email = null where id = '10000000-0000-4000-8000-000000000042';
insert into public.owners (id, full_name, first_name, email, mailing_address)
  values ('10000000-0000-4000-8000-0000000000b1', 'Buyer Example', 'Buyer', 'buyer.example@example.com', '118 Sample Lane');
insert into public.lot_owners (lot_id, owner_id, starts_on) values ('00000000-0000-4000-8000-000000000042', '10000000-0000-4000-8000-0000000000b1', current_date);
insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000b1', 'buyer.example@example.com', now());
select tests.as_user('a0000000-0000-4000-8000-0000000000b1');
select tests.eq(tests.count('select 1 from public.lots'), 1::bigint, 'the buyer sees the lot');
select tests.eq(tests.count('select 1 from public.messages'), 0::bigint, 'the buyer does not see the seller''s messages');
reset role;

-- an owner whose start date is tomorrow has no access yet
update public.lot_owners set starts_on = current_date + 1 where owner_id = '10000000-0000-4000-8000-0000000000b1';
select tests.as_user('a0000000-0000-4000-8000-0000000000b1');
select tests.eq(tests.count('select 1 from public.lots'), 0::bigint, 'an owner starting tomorrow sees nothing yet');
select tests.eq((select count(*) from public.my_owner_ids()), 0::bigint, 'and has no current owner record');
reset role;
update public.lot_owners set starts_on = current_date where owner_id = '10000000-0000-4000-8000-0000000000b1';
select tests.as_user('a0000000-0000-4000-8000-0000000000b1');
select tests.eq(tests.count('select 1 from public.lots'), 1::bigint, 'starting today counts');
reset role;
rollback;

-- ===========================================================================
-- 2. Board packets are board-only; one document row per storage object
-- ===========================================================================
begin;
select tests.fails($$insert into public.documents (folder, title, storage_path, audience) values ('board_packets', 'Packet', 'x/packet-owners.pdf', 'owners')$$,
  'board_packets_board_only', 'a board packet cannot be shared with owners');
select tests.fails($$insert into public.documents (folder, title, storage_path, audience) values ('board_packets', 'Packet', 'x/packet-public.pdf', 'public')$$,
  'board_packets_board_only', 'a board packet cannot be public');
select tests.fails($$update public.documents set audience = 'owners' where folder = 'board_packets'$$,
  'board_packets_board_only', 'a board packet cannot be switched to owners');
select tests.fails($$update public.documents set folder = 'board_packets' where title like 'Bylaws%'$$,
  'board_packets_board_only', 'a shared document cannot be moved into the board packets folder');
insert into public.documents (folder, title, storage_path, audience) values ('board_packets', 'Packet', 'x/packet-board.pdf', 'board');
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.fails($$insert into public.documents (folder, title, storage_path, audience) values ('board_packets', 'Packet 2', 'x/p2.pdf', 'owners')$$,
  'board_packets_board_only', 'a board member cannot publish a packet to owners either');
reset role;
-- the same file cannot back a second, visible row (that would open the board file through the storage policy)
select tests.fails($$insert into public.documents (folder, title, storage_path, audience) values ('forms', 'Alias', 'x/packet-board.pdf', 'public')$$,
  'documents_storage_path_unique', 'a storage path belongs to one document row');
insert into public.documents (folder, title, storage_path, audience) values ('forms', 'No file yet', '', 'public'), ('forms', 'No file either', '', 'public');
select tests.ok(true, 'rows without a file may share the empty path');
-- the storage object of a board packet is unreadable for owners and anon
insert into storage.objects (bucket_id, name) values ('documents', 'x/packet-board.pdf');
insert into auth.users (id, email, email_confirmed_at) select 'a0000000-0000-4000-8000-0000000000f3', email, now() from public.owners where id = '10000000-0000-4000-8000-000000000043';
select tests.as_user('a0000000-0000-4000-8000-0000000000f3');
select tests.eq(tests.count($$select 1 from storage.objects where name = 'x/packet-board.pdf'$$), 0::bigint, 'owner cannot read the packet file');
select tests.as_anon();
select tests.eq(tests.count($$select 1 from storage.objects where name = 'x/packet-board.pdf'$$), 0::bigint, 'anon cannot read the packet file');
reset role;
rollback;

-- ===========================================================================
-- 3. Two-person rule: no direct write path to checks
-- ===========================================================================
begin;
select tests.eq((select count(*) from pg_policies where schemaname = 'public' and tablename = 'checks' and cmd <> 'SELECT'), 0::bigint, 'checks has no write policy');
select tests.ok(not has_table_privilege('authenticated', 'public.checks', 'update'), 'authenticated has no UPDATE on checks');
select tests.ok(not has_table_privilege('authenticated', 'public.checks', 'insert'), 'authenticated has no INSERT on checks');
select tests.ok(not has_table_privilege('authenticated', 'public.checks', 'delete'), 'authenticated has no DELETE on checks');
select tests.ok(not has_column_privilege('authenticated', 'public.checks', 'deposit_confirmed_by', 'update'), 'no column UPDATE on deposit_confirmed_by');
select tests.ok(not has_table_privilege('anon', 'public.checks', 'select'), 'anon cannot even read checks');
select tests.as_user('b0000000-0000-4000-8000-000000000003');
create temp table kc on commit drop as select * from public.log_check('00000000-0000-4000-8000-000000000042', '7001', 17500, date '2026-10-01');
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.fails($$update public.checks set deposit_confirmed_by = 'b0000000-0000-4000-8000-000000000004', state = 'deposited'$$, 'permission denied', 'a board member cannot confirm by updating the table');
select tests.fails($$update public.checks set deposit_confirmed_by = 'b0000000-0000-4000-8000-000000000005'$$, 'permission denied', 'nor name somebody else as confirmer');
select tests.fails($$insert into public.checks (lot_id, check_number, amount_cents, received_on, logged_by, deposit_confirmed_by, state) values ('00000000-0000-4000-8000-000000000042', '7002', 100, '2026-10-01', 'b0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000004', 'deposited')$$, 'permission denied', 'nor insert a pre-confirmed check');
select tests.fails($$delete from public.checks$$, 'permission denied', 'nor delete a check');
reset role;
-- claims are still b4's here: the trigger lets the signed-in confirmer through and nobody else
select tests.fails($$update public.checks set state = 'deposited', deposit_confirmed_by = 'b0000000-0000-4000-8000-000000000005' where id = (select id from kc)$$,
  'can only be the signed-in', 'even a privileged write cannot name another confirmer');
select tests.ok((select state = 'received' and deposit_confirmed_by is null from public.checks where id = (select id from kc)), 'the refused write changed nothing');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select tests.fails($$update public.checks set state = 'deposited', deposit_confirmed_by = 'b0000000-0000-4000-8000-000000000004' where id = (select id from kc)$$,
  'can only be the signed-in', 'the service role (no signed-in user) cannot set a confirmer directly');
select set_config('request.jwt.claims', '', true);
select tests.fails($$insert into public.checks (lot_id, check_number, amount_cents, received_on, logged_by, deposit_confirmed_by, state) values ('00000000-0000-4000-8000-000000000042', '7003', 100, '2026-10-01', 'b0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000004', 'deposited')$$,
  'can only be the signed-in', 'a check cannot be inserted already confirmed');
-- the function path still works, and records the caller
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.eq((select deposit_confirmed_by from public.confirm_check_deposit((select id from kc), 'deposited')), 'b0000000-0000-4000-8000-000000000004'::uuid, 'confirm_check_deposit records auth.uid() as confirmer');
reset role;
rollback;

-- ===========================================================================
-- 4. add_business_days: invoker, bounded, closed to users
-- ===========================================================================
begin;
select tests.ok(not (select prosecdef from pg_proc where oid = 'public.add_business_days(timestamptz, integer)'::regprocedure), 'add_business_days is not SECURITY DEFINER');
select tests.ok(not has_function_privilege('anon', 'public.add_business_days(timestamptz, integer)', 'execute'), 'anon cannot execute add_business_days');
select tests.ok(not has_function_privilege('authenticated', 'public.add_business_days(timestamptz, integer)', 'execute'), 'authenticated cannot execute add_business_days');
select tests.ok(not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                             where p.oid = 'public.add_business_days(timestamptz, integer)'::regprocedure and a.grantee = 0), 'PUBLIC cannot execute add_business_days');
select tests.fails($$select public.add_business_days(now(), 401)$$, 'between 0 and 400', 'more than 400 days refused');
select tests.fails($$select public.add_business_days(now(), -1)$$, 'between 0 and 400', 'negative days refused');
select tests.fails($$select public.add_business_days(now(), null)$$, 'between 0 and 400', 'null days refused');
select tests.ok(public.add_business_days(timestamptz '2027-03-05 10:00+00', 400) > timestamptz '2028-08-01', '400 days is allowed');
select tests.eq(public.add_business_days(timestamptz '2027-03-05 10:00+00', 0), timestamptz '2027-03-05 10:00+00', 'zero days returns the start');
rollback;

-- ===========================================================================
-- 5. A deposited check posts on the day it was received
-- ===========================================================================
begin;
select tests.as_user('b0000000-0000-4000-8000-000000000003');
create temp table dc on commit drop as select * from public.log_check('00000000-0000-4000-8000-000000000042', '7100', 17500, date '2026-10-01');
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select public.confirm_check_deposit((select id from dc), 'deposited');
reset role;
select tests.eq((select posted_on from public.ledger_entries where external_ref = 'check:' || (select id from dc)), date '2026-10-01', 'the payment row is dated the day the check was received');
select tests.ok(current_date <> date '2026-10-01', 'and that is not the confirmation date');
select tests.eq((select paid_on from public.invoices where number = '2027-042'), date '2026-10-01', 'the invoice shows paid on the receipt date');
rollback;

-- ===========================================================================
-- 6. send_message with a chosen lot
-- ===========================================================================
begin;
update public.owners set email = 'shared.household@example.net' where id in ('10000000-0000-4000-8000-000000000044', '10000000-0000-4000-8000-000000000045');
insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000f2', 'shared.household@example.net', now());
select tests.as_user('a0000000-0000-4000-8000-0000000000f2');
select tests.eq((select lot_id from public.send_message('question', 'default lot')), '00000000-0000-4000-8000-000000000044'::uuid, 'no lot given: the first lot');
select tests.ok((select lot_id = '00000000-0000-4000-8000-000000000045' and owner_id = '10000000-0000-4000-8000-000000000045'
                   from public.send_message('question', 'second lot', '00000000-0000-4000-8000-000000000045')), 'a chosen lot is used, with that lot''s owner record');
select tests.ok((select lot_id = '00000000-0000-4000-8000-000000000044' and owner_id = '10000000-0000-4000-8000-000000000044'
                   from public.send_message('question', 'first lot by name', '00000000-0000-4000-8000-000000000044')), 'naming the first lot works too');
select tests.fails($$select public.send_message('question', 'forged', '00000000-0000-4000-8000-000000000043')$$, 'not a current owner', 'a lot that is not mine is refused');
select tests.fails($$select public.send_message('question', 'forged', gen_random_uuid())$$, 'not a current owner', 'an unknown lot is refused');
reset role;
update public.lot_owners set ends_on = current_date - 1 where owner_id = '10000000-0000-4000-8000-000000000045';
select tests.as_user('a0000000-0000-4000-8000-0000000000f2');
select tests.fails($$select public.send_message('question', 'sold', '00000000-0000-4000-8000-000000000045')$$, 'not a current owner', 'a lot I no longer own is refused');
select tests.eq(tests.count('select 1 from public.messages where lot_id = ''00000000-0000-4000-8000-000000000045'''), 0::bigint, 'and the earlier message for it is no longer visible to the seller');
reset role;
rollback;

-- ===========================================================================
-- 7. Bill run: credit larger than the dues makes no invoice
-- ===========================================================================
begin;
-- lot 5 is paid up (balance 0); give it a 25000 credit. Lot 10 gets a credit exactly equal to the dues.
insert into public.ledger_entries (lot_id, posted_on, kind, description, amount_cents, external_ref) values
  ('00000000-0000-4000-8000-000000000005', date '2027-12-01', 'credit', 'Credit', -25000, 'cr:5'),
  ('00000000-0000-4000-8000-000000000010', date '2027-12-01', 'credit', 'Credit', -18000, 'cr:10');
create function pg_temp.draft(p_lot int, p_total bigint, p_credit bigint) returns jsonb language sql as $$
  select jsonb_build_object('lot_id', ('00000000-0000-4000-8000-' || lpad(p_lot::text, 12, '0')), 'number', '2028-' || lpad(p_lot::text, 3, '0'),
    'description', '2028 annual assessment', 'due_on', '2028-05-15', 'assessment_cents', 18000, 'total_cents', p_total, 'credit_left_cents', p_credit) $$;
create function pg_temp.bal(p_lot int) returns bigint language sql as $$
  select balance_cents from public.lot_balances where lot_id = ('00000000-0000-4000-8000-' || lpad(p_lot::text, 12, '0'))::uuid $$;
grant execute on all functions in schema pg_temp to public;
set local role service_role;
create temp table b1 on commit drop as select public.apply_bill_run(date '2028-01-29', jsonb_build_array(pg_temp.draft(5, 0, 7000), pg_temp.draft(10, 0, 0), pg_temp.draft(12, 17500, 0))) r;
reset role;
select tests.eq((select r -> 'credit_only' from b1), '["2028-005"]'::jsonb, 'the credit-only lot is listed');
select tests.eq((select count(*) from public.invoices where number = '2028-005'), 0::bigint, 'no invoice for a credit larger than the dues');
select tests.ok((select amount_cents = 18000 and invoice_id is null and kind = 'charge' from public.ledger_entries where external_ref = 'inv:2028-005'), 'the assessment is still charged, with no invoice behind it');
select tests.eq(pg_temp.bal(5), -7000::bigint, 'the lot keeps the rest of its credit in the ledger');
select tests.ok((select status = 'paid' and amount_cents = 0 from public.invoices where number = '2028-010'), 'a credit exactly equal to the dues still gets a zero invoice, paid');
select tests.ok((select status = 'draft' and amount_cents = 17500 from public.invoices where number = '2028-012'), 'an ordinary lot gets its invoice');
select tests.eq((select count(*) from public.invoices where amount_cents < 0), 0::bigint, 'no negative invoice anywhere');
-- re-run: nothing twice
set local role service_role;
create temp table b2 on commit drop as select public.apply_bill_run(date '2028-01-29', jsonb_build_array(pg_temp.draft(5, 0, 7000), pg_temp.draft(10, 0, 0), pg_temp.draft(12, 17500, 0))) r;
reset role;
select tests.ok((select (r ->> 'created')::int = 0 and (r ->> 'charges_posted')::int = 0 from b2), 're-running creates and posts nothing');
select tests.eq(pg_temp.bal(5), -7000::bigint, 'and the credit lot balance is unchanged');
set local role service_role;
select tests.fails($$select public.apply_bill_run(date '2028-01-29', jsonb_build_array(pg_temp.draft(20, 100, 500)))$$, 'must total 0', 'a credit draft with a non-zero total is refused');
select tests.fails($$select public.apply_bill_run(date '2028-01-29', jsonb_build_array(pg_temp.draft(20, -100, 0)))$$, 'cannot be negative', 'a negative total is still refused');
reset role;
rollback;

-- ===========================================================================
-- 8. Stripe events with no lot are kept for review
-- ===========================================================================
begin;
set local role service_role;
create temp table q1 on commit drop as select public.apply_stripe_event('evt_orphan', jsonb_build_object('event_type', 'payment_intent.succeeded', 'payment_intent', 'pi_orphan',
  'invoice_status', 'paid', 'ledger', '[]'::jsonb)) r;
reset role;
select tests.ok((select r ->> 'reason' = 'lot_not_found' and (r ->> 'quarantined')::boolean and (r ->> 'attempts')::int = 1 from q1), 'an event with no lot reports the quarantine');
select tests.eq((select count(*) from public.stripe_quarantine where event_id = 'evt_orphan' and resolved_at is null and reason = 'lot_not_found'), 1::bigint, 'and a quarantine row exists');
select tests.eq((select count(*) from public.processed_events where id = 'evt_orphan'), 0::bigint, 'it is not marked processed, so Stripe can retry');
set local role service_role;
select public.apply_stripe_event('evt_orphan', jsonb_build_object('event_type', 'payment_intent.succeeded', 'payment_intent', 'pi_orphan', 'invoice_status', 'paid', 'ledger', '[]'::jsonb));
reset role;
select tests.eq((select attempts from public.stripe_quarantine where event_id = 'evt_orphan'), 2, 'a retry counts as another attempt, no second row');
-- the invoice link arrives; the retry applies and closes the row
update public.invoices set stripe_payment_intent_id = 'pi_orphan' where number = '2027-042';
set local role service_role;
create temp table q2 on commit drop as select public.apply_stripe_event('evt_orphan', jsonb_build_object('event_type', 'payment_intent.succeeded', 'payment_intent', 'pi_orphan',
  'invoice_status', 'paid', 'ledger', '[]'::jsonb)) r;
reset role;
select tests.ok((select (r ->> 'applied')::boolean from q2), 'once the invoice is linked the event applies');
select tests.ok((select resolved_at is not null from public.stripe_quarantine where event_id = 'evt_orphan'), 'and its quarantine row is closed');
-- review
set local role service_role;
select public.quarantine_stripe_event('evt_other', 'charge.dispute.created', 'no_payment_reference', '{"amount": 500}'::jsonb);
reset role;
insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-4000-8000-0000000000f3', 'owner43@example.net', now());
update public.owners set user_id = 'a0000000-0000-4000-8000-0000000000f3' where id = '10000000-0000-4000-8000-000000000043';
select tests.as_user('a0000000-0000-4000-8000-0000000000f3');
select tests.eq(tests.count('select 1 from public.stripe_quarantine'), 0::bigint, 'an owner cannot see quarantined events');
select tests.fails($$select public.quarantine_stripe_event('evt_x', 't', 'r', '{}')$$, 'permission denied', 'owners cannot write the quarantine');
select tests.fails($$select public.resolve_stripe_quarantine((select id from public.stripe_quarantine where event_id = 'evt_other'))$$, 'board only', 'owners cannot close a quarantine row');
select tests.as_user('b0000000-0000-4000-8000-000000000004');
select tests.eq(tests.count('select 1 from public.stripe_quarantine'), 2::bigint, 'the board sees the quarantine rows');
select tests.ok((select resolved_at is not null and resolved_by = 'b0000000-0000-4000-8000-000000000004' and note = 'duplicate of a test event'
                   from public.resolve_stripe_quarantine((select id from public.stripe_quarantine where event_id = 'evt_other'), 'duplicate of a test event')), 'a board member closes a row with a note');
reset role;
rollback;

-- ===========================================================================
-- 11. Claim approval attaches to the existing roster owner
-- ===========================================================================
begin;
insert into auth.users (id, email, email_confirmed_at) values
  ('a0000000-0000-4000-8000-0000000000e1', 'new.owner@example.net', now()),
  ('a0000000-0000-4000-8000-0000000000e2', 'second.owner@example.net', now()),
  ('a0000000-0000-4000-8000-0000000000e3', 'third.owner@example.net', now()),
  ('a0000000-0000-4000-8000-0000000000e4', 'fourth.owner@example.net', now());
insert into public.claim_codes (lot_id, code_hash, expires_at)
select ('00000000-0000-4000-8000-0000000000' || n)::uuid, encode(sha256(convert_to('CLAIMCODE' || n, 'UTF8')), 'hex'), now() + interval '30 days' from (values ('43'), ('44'), ('45')) v(n);

-- lot 42: one roster owner (Pat, not signed in yet) => the claim attaches to Pat's row, no second owner
select tests.as_user('a0000000-0000-4000-8000-0000000000e1');
select public.redeem_claim_code('sample-code-0042');
select tests.as_user('b0000000-0000-4000-8000-000000000001');
select public.resolve_claim_request((select id from public.claim_requests where user_id = 'a0000000-0000-4000-8000-0000000000e1'), true);
reset role;
select tests.eq((select count(*) from public.lot_owners where lot_id = '00000000-0000-4000-8000-000000000042'), 1::bigint, 'approval adds no second owner to the lot');
select tests.eq((select user_id from public.owners where id = '10000000-0000-4000-8000-000000000042'), 'a0000000-0000-4000-8000-0000000000e1'::uuid, 'the roster owner is now linked to the new sign-in');
select tests.eq((select count(*) from public.owners where email = 'new.owner@example.net'), 0::bigint, 'no duplicate owner row with the claim email');
select tests.as_user('a0000000-0000-4000-8000-0000000000e1');
select tests.eq(tests.count('select 1 from public.lots'), 1::bigint, 'the claimant sees the lot through the roster owner');
select tests.eq(tests.count('select 1 from public.messages'), 1::bigint, 'and the roster owner''s message history');
reset role;

-- lot 43: two roster owners => the board must choose
insert into public.owners (id, full_name, first_name, email, mailing_address) values ('10000000-0000-4000-8000-0000000000c2', 'Second Owner', 'Second', 'second.roster@example.net', '120 Sample Lane');
insert into public.lot_owners (lot_id, owner_id, starts_on) values ('00000000-0000-4000-8000-000000000043', '10000000-0000-4000-8000-0000000000c2', date '2020-01-01');
select tests.as_user('a0000000-0000-4000-8000-0000000000e2');
select public.redeem_claim_code('CLAIMCODE43');
select tests.as_user('b0000000-0000-4000-8000-000000000001');
select tests.fails($$select public.resolve_claim_request((select id from public.claim_requests where user_id = 'a0000000-0000-4000-8000-0000000000e2'), true)$$, 'several owners', 'several owners: the board has to choose');
select tests.fails($$select public.resolve_claim_request((select id from public.claim_requests where user_id = 'a0000000-0000-4000-8000-0000000000e2'), true, '10000000-0000-4000-8000-000000000044')$$, 'not a current owner of this lot', 'the chosen owner must be an owner of that lot');
select tests.eq((select status from public.claim_requests where user_id = 'a0000000-0000-4000-8000-0000000000e2'), 'pending', 'refusals leave the claim pending');
select tests.eq((select status from public.resolve_task((select id from public.board_tasks where kind = 'claim_attach' and status = 'open' and lot_id = '00000000-0000-4000-8000-000000000043'),
                'approve', null, '10000000-0000-4000-8000-0000000000c2')), 'done', 'resolve_task passes the chosen owner through');
reset role;
select tests.eq((select user_id from public.owners where id = '10000000-0000-4000-8000-0000000000c2'), 'a0000000-0000-4000-8000-0000000000e2'::uuid, 'the chosen owner is linked');
select tests.ok((select user_id is null from public.owners where id = '10000000-0000-4000-8000-000000000043'), 'the other roster owner is untouched');
select tests.eq((select count(*) from public.lot_owners where lot_id = '00000000-0000-4000-8000-000000000043'), 2::bigint, 'still two owners on the lot');

-- lot 44: its roster owner already has a different sign-in => refused, nothing re-pointed
update public.owners set user_id = 'a0000000-0000-4000-8000-0000000000e4' where id = '10000000-0000-4000-8000-000000000044';
select tests.as_user('a0000000-0000-4000-8000-0000000000e3');
select public.redeem_claim_code('CLAIMCODE44');
select tests.as_user('b0000000-0000-4000-8000-000000000001');
select tests.fails($$select public.resolve_claim_request((select id from public.claim_requests where user_id = 'a0000000-0000-4000-8000-0000000000e3'), true)$$, 'already linked to another sign-in', 'an owner linked to another sign-in is not re-pointed');
reset role;
select tests.eq((select user_id from public.owners where id = '10000000-0000-4000-8000-000000000044'), 'a0000000-0000-4000-8000-0000000000e4'::uuid, 'the existing link is unchanged');

-- a lot with no roster owner at all still gets one created
delete from public.lot_owners where lot_id = '00000000-0000-4000-8000-000000000045';
select tests.as_user('a0000000-0000-4000-8000-0000000000e3');
select public.redeem_claim_code('CLAIMCODE45');
select tests.as_user('b0000000-0000-4000-8000-000000000001');
select public.resolve_claim_request((select id from public.claim_requests where user_id = 'a0000000-0000-4000-8000-0000000000e3' and lot_id = '00000000-0000-4000-8000-000000000045'), true);
reset role;
select tests.eq((select count(*) from public.lot_owners lo join public.owners o on o.id = lo.owner_id
                  where lo.lot_id = '00000000-0000-4000-8000-000000000045' and o.user_id = 'a0000000-0000-4000-8000-0000000000e3'), 1::bigint, 'a lot with no roster owner gets a new owner row');
-- the shared household case stays possible: one sign-in on two owner records
select tests.ok(not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'owners' and indexdef ilike '%unique%user_id%'), 'owners.user_id is not unique (shared households link one sign-in to several records)');
rollback;

-- ===========================================================================
-- 13. Audit rows for service-role writes
-- ===========================================================================
begin;
create function pg_temp.draft(p_lot int) returns jsonb language sql as $$
  select jsonb_build_object('lot_id', ('00000000-0000-4000-8000-' || lpad(p_lot::text, 12, '0')), 'number', '2029-' || lpad(p_lot::text, 3, '0'),
    'description', '2029 annual assessment', 'due_on', '2029-05-15', 'assessment_cents', 100, 'total_cents', 100) $$;
grant execute on all functions in schema pg_temp to public;
-- seed and migration style writes (no JWT at all) stay quiet
select public.apply_bill_run(date '2029-01-29', jsonb_build_array(pg_temp.draft(1)));
select tests.eq((select count(*) from public.audit_log where table_name = 'invoices' and new_data ->> 'number' = '2029-001'), 0::bigint, 'a write with no JWT at all is not audited');
-- the service role (webhook, bill run) is audited with no actor_id and actor_role service
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select public.apply_bill_run(date '2029-01-29', jsonb_build_array(pg_temp.draft(2)));
reset role;
select tests.ok(exists (select 1 from public.audit_log where table_name = 'invoices' and new_data ->> 'number' = '2029-002' and actor_id is null and actor_role = 'service'), 'a service-role invoice write is audited as service');
select tests.ok(exists (select 1 from public.audit_log where table_name = 'ledger_entries' and new_data ->> 'external_ref' = 'inv:2029-002' and actor_role = 'service'), 'and so is its ledger charge');
select set_config('request.jwt.claims', '', true);
-- a signed-in person is audited as user
select tests.as_user('b0000000-0000-4000-8000-000000000004');
insert into public.announcements (title, body, audience) values ('Audit me', 'x', 'public');
reset role;
select tests.ok(exists (select 1 from public.audit_log where table_name = 'announcements' and new_data ->> 'title' = 'Audit me' and actor_id = 'b0000000-0000-4000-8000-000000000004' and actor_role = 'user'), 'a board write is audited as user');
rollback;
